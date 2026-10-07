import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import { getMediaKeys } from 'baileys';

import {
  prepareCachedRecoveryMedia,
  readRetainedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

async function fixture() {
  const plaintext = Buffer.alloc(1322681, 37);
  const key = Buffer.alloc(32, 43);
  const keys = await getMediaKeys(key, 'document');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac('sha256', keys.macKey)
    .update(Buffer.concat([keys.iv, body]))
    .digest()
    .subarray(0, 10);
  const ciphertext = Buffer.concat([body, mac]);
  const row = {
    id: 'synthetic-pdf',
    instanceId: 'synthetic-instance',
    messageType: 'documentMessage',
    key: { id: 'SYNTHETICPDF', fromMe: false, remoteJid: '628111111111@s.whatsapp.net' },
    message: {
      documentMessage: {
        fileName: 'synthetic.pdf',
        mimetype: 'application/pdf',
        fileLength: { low: plaintext.length, high: 0, unsigned: true },
        fileSha256: createHash('sha256').update(plaintext).digest('base64'),
        fileEncSha256: createHash('sha256').update(ciphertext).digest('base64'),
        mediaKey: key.toString('base64'),
        directPath: '/synthetic-native-pdf',
        caption: 'synthetic retained caption',
      },
    },
  } as any;
  return { plaintext, ciphertext, row };
}

function media(row: any) {
  return {
    messageId: row.id,
    instanceId: row.instanceId,
    type: row.messageType,
    mimetype: row.message[row.messageType].mimetype,
    fileName: `${row.instanceId}/${row.key.remoteJid}/${row.messageType}/1700000000000_synthetic.pdf`,
  } as any;
}

test('whole250 prepares three owned images then one missing native PDF through the original SDK Document decryptor', async () => {
  const f = await fixture();
  const images = Array.from({ length: 3 }, (_, i) => ({
    ...f.row,
    id: `synthetic-image-${i}`,
    messageType: 'imageMessage',
    message: { imageMessage: { ...f.row.message.documentMessage, mimetype: 'image/jpeg', fileName: 'synthetic.jpg' } },
  }));
  const messages = [
    ...Array.from({ length: 246 }, (_, i) => ({ id: `text-${i}`, messageType: 'conversation' })),
    ...images,
    f.row,
  ] as any;
  const before = JSON.stringify(messages);
  let owned = 0,
    fetched = 0;
  const result = await prepareCachedRecoveryMedia(
    messages,
    async (m) => (m.id === f.row.id ? null : media(m)),
    async () => {
      owned++;
      return f.plaintext;
    },
    async (m) =>
      readRetainedRecoveryMedia(m, undefined, (async (url: any, options: any) => {
        fetched++;
        assert.equal(url, 'https://mmg.whatsapp.net/synthetic-native-pdf');
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        assert(options.signal instanceof AbortSignal);
        return new Response(f.ciphertext);
      }) as any),
  );
  assert.equal(owned, 3);
  assert.equal(fetched, 1);
  assert.equal(result.size, 4);
  assert.equal(result.get(f.row.id)!.media, null);
  assert(result.get(f.row.id)!.bytes.equals(f.plaintext));
  assert.equal(result.get(f.row.id)!.descriptor.mimetype, 'application/pdf');
  assert.equal(JSON.stringify(messages), before);
});

test('owned PDF remains cache-first and a corrupt owned object never falls back to the provider', async () => {
  const f = await fixture();
  const result = await prepareCachedRecoveryMedia(
    [f.row],
    async () => media(f.row),
    async () => f.plaintext,
    async () => assert.fail('No provider fallback from owned bytes'),
  );
  assert(result.get(f.row.id)!.bytes.equals(f.plaintext));
  await assert.rejects(
    () =>
      prepareCachedRecoveryMedia(
        [f.row],
        async () => media(f.row),
        async () => Buffer.alloc(1),
        async () => assert.fail('No provider fallback from corrupt owned bytes'),
      ),
    /cached_media_bytes_mismatch/,
  );
});

test('native PDF fallback refuses malformed MIME, wrong kind and malformed ownership or pointer before a request', async () => {
  for (const mutation of ['mime', 'kind', 'direction', 'peer', 'path', 'key', 'length', 'digest']) {
    const f = await fixture();
    const d = f.row.message.documentMessage;
    if (mutation === 'mime') d.mimetype = 'application/pdf; injected=1';
    if (mutation === 'kind') f.row.messageType = 'unknown';
    if (mutation === 'direction') f.row.key.fromMe = null;
    if (mutation === 'peer') f.row.key.remoteJid = '';
    if (mutation === 'path') d.directPath = '//foreign.invalid/object';
    if (mutation === 'key') d.mediaKey = Buffer.alloc(31).toString('base64');
    if (mutation === 'length') d.fileLength.low = 32 * 1024 * 1024 + 1;
    if (mutation === 'digest') d.fileSha256 = Buffer.alloc(31).toString('base64');
    await assert.rejects(() =>
      readRetainedRecoveryMedia(f.row, undefined, (async () => assert.fail(`No request for ${mutation}`)) as any),
    );
  }
});

test('one PDF ciphertext must match native encrypted SHA, Document MAC and plaintext size and SHA', async () => {
  for (const mutation of ['enc_sha', 'missing_enc_sha', 'mac', 'key', 'plain_sha', 'plain_size', 'overflow']) {
    const f = await fixture();
    const d = f.row.message.documentMessage;
    if (mutation === 'enc_sha') d.fileEncSha256 = Buffer.alloc(32).toString('base64');
    if (mutation === 'missing_enc_sha') delete d.fileEncSha256;
    if (mutation === 'mac') {
      f.ciphertext[f.ciphertext.length - 1] ^= 1;
      d.fileEncSha256 = createHash('sha256').update(f.ciphertext).digest('base64');
    }
    if (mutation === 'key') d.mediaKey = Buffer.alloc(32, 9).toString('base64');
    if (mutation === 'plain_sha') d.fileSha256 = Buffer.alloc(32).toString('base64');
    if (mutation === 'plain_size') d.fileLength.low--;
    if (mutation === 'overflow') f.ciphertext = Buffer.alloc(d.fileLength.low + 1025);
    const before = JSON.stringify(f.row);
    let reads = 0;
    await assert.rejects(() =>
      readRetainedRecoveryMedia(f.row, undefined, (async () => {
        reads++;
        return new Response(f.ciphertext);
      }) as any),
    );
    assert.equal(reads, 1, mutation);
    assert.equal(JSON.stringify(f.row), before, mutation);
  }
});

test('PDF default transport refuses HTTP errors and enforces the real abort deadline without retry', async () => {
  const f = await fixture();
  let reads = 0;
  await assert.rejects(
    () =>
      readRetainedRecoveryMedia(f.row, undefined, (async () => {
        reads++;
        return new Response(null, { status: 403 });
      }) as any),
    /cached_media_provider_read_refused/,
  );
  assert.equal(reads, 1);
  const started = Date.now();
  reads = 0;
  await assert.rejects(
    () =>
      readRetainedRecoveryMedia(f.row, undefined, ((_url: any, options: any) => {
        reads++;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('synthetic_actual_abort')), { once: true });
        });
      }) as any),
    /synthetic_actual_abort/,
  );
  assert.equal(reads, 1);
  assert(Date.now() - started >= 4900);
  assert(Date.now() - started < 6500);
});
