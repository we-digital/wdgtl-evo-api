import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import { getMediaKeys } from 'baileys';
import { fetch as fetchEncrypted, MockAgent } from 'undici';

import { readRetainedRecoveryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

const plaintext = Buffer.alloc(45505, 3);
const key = Buffer.alloc(32, 1);
function native() {
  return {
    id: 'synthetic-native-image',
    instanceId: 'synthetic-instance',
    messageType: 'imageMessage',
    key: { id: 'SYNTHETIC_IMAGE', fromMe: false, remoteJid: '628111111111@s.whatsapp.net' },
    message: {
      imageMessage: {
        mimetype: 'image/jpeg',
        fileLength: { low: plaintext.length, high: 0, unsigned: true },
        fileSha256: createHash('sha256').update(plaintext).digest('base64'),
        mediaKey: key.toString('base64'),
        url: 'https://mmg.whatsapp.net/synthetic-old-pointer',
        directPath: '/synthetic-current-pointer?native=1',
      },
    },
  } as any;
}
async function ciphertext() {
  const keys = await getMediaKeys(key, 'image');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac('sha256', keys.macKey)
    .update(Buffer.concat([keys.iv, encrypted]))
    .digest()
    .subarray(0, 10);
  return Buffer.concat([encrypted, mac]);
}

test('default installed Baileys decrypts one bounded current native pointer without changing the envelope', async () => {
  const row = native();
  const before = JSON.stringify(row);
  const encrypted = await ciphertext();
  let requests = 0;
  let closes = 0;
  const result = await readRetainedRecoveryMedia(row, undefined, (async (url: any, options: any) => {
    requests++;
    assert.equal(url, 'https://mmg.whatsapp.net/synthetic-current-pointer?native=1');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    assert(options.dispatcher);
    const close = options.dispatcher.destroy.bind(options.dispatcher);
    options.dispatcher.destroy = (...args: any[]) => {
      if (!args.length) closes++;
      return close(...args);
    };
    return new Response(encrypted, { status: 200 });
  }) as any);
  assert.equal(requests, 1);
  assert.equal(closes, 1);
  assert(result.equals(plaintext));
  assert.equal(JSON.stringify(row), before);
});

test('default transport refuses HTTP, redirects, excess bytes and native hash mismatch without a retry', async () => {
  for (const response of [
    () => new Response(null, { status: 403 }),
    () => new Response(null, { status: 302, headers: { location: 'https://foreign.invalid/object' } }),
    () => new Response(Buffer.alloc(plaintext.length + 1025), { status: 200 }),
    async () => new Response(await ciphertext(), { status: 200 }),
  ]) {
    const row = native();
    if (response.constructor.name === 'AsyncFunction')
      row.message.imageMessage.fileSha256 = Buffer.alloc(32).toString('base64');
    let requests = 0;
    await assert.rejects(() =>
      readRetainedRecoveryMedia(row, undefined, (async () => {
        requests++;
        return response();
      }) as any),
    );
    assert.equal(requests, 1);
  }
  for (const directPath of [
    '//foreign.invalid/object',
    '/object#fragment',
    '/a/../object',
    '/object\\bad',
    '/object bad',
  ]) {
    const row = native();
    row.message.imageMessage.directPath = directPath;
    await assert.rejects(() =>
      readRetainedRecoveryMedia(row, undefined, (async () => assert.fail('No invalid request')) as any),
    );
  }
});

test('default installed-SDK path aborts a stalled encrypted fetch at five seconds and makes no decrypt request', async () => {
  let requests = 0;
  let aborted = false;
  const start = Date.now();
  await assert.rejects(
    () =>
      readRetainedRecoveryMedia(native(), undefined, (async (_url: any, options: any) => {
        requests++;
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('synthetic encrypted fetch aborted'));
            },
            { once: true },
          ),
        );
      }) as any),
    /synthetic encrypted fetch aborted/,
  );
  assert.equal(requests, 1);
  assert.equal(aborted, true);
  assert(Date.now() - start >= 4900 && Date.now() - start < 8000);
});

test('actual Undici rejects a redirect before any second host request reaches the installed SDK', async () => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  mock
    .get('https://mmg.whatsapp.net')
    .intercept({ path: '/synthetic-current-pointer?native=1', method: 'GET' })
    .reply(302, '', { headers: { location: 'https://foreign.invalid/object' } });
  mock.get('https://foreign.invalid').intercept({ path: '/object', method: 'GET' }).reply(200, 'foreign');
  let requests = 0;
  try {
    await assert.rejects(
      () =>
        readRetainedRecoveryMedia(native(), undefined, (async (url: any, options: any) => {
          requests++;
          return fetchEncrypted(url, { ...options, dispatcher: mock });
        }) as any),
      (error: any) => error.cause?.message === 'unexpected redirect',
    );
    assert.equal(requests, 1);
    assert.equal(mock.pendingInterceptors().length, 1);
    assert.equal(mock.pendingInterceptors()[0].origin, 'https://foreign.invalid');
  } finally {
    await mock.close();
  }
});
