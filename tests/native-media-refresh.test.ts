import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Boom } from '@hapi/boom';
import { aesDecryptGCM, downloadMediaMessage, encryptMediaRetryRequest, getMediaKeys, hkdf, proto } from 'baileys';
import { MockAgent } from 'undici';

import {
  expiredNativeMediaStatus,
  refreshExpiredNativeMedia,
} from '../src/api/integrations/channel/whatsapp/native-media-refresh';

const bytes = Buffer.from('synthetic native image bytes');
function setup() {
  const source: any = {
    id: 'native-source-pk',
    instanceId: 'instance-A',
    messageType: 'imageMessage',
    messageTimestamp: 1788236786,
    key: { id: 'native-id', remoteJid: '123456789@g.us', fromMe: false, participant: '123456789@s.whatsapp.net' },
    message: {
      imageMessage: {
        url: 'https://mmg.whatsapp.net/expired',
        directPath: '/expired',
        mimetype: 'image/jpeg',
        fileLength: bytes.length,
        fileSha256: createHash('sha256').update(bytes).digest('base64'),
        fileEncSha256: Buffer.alloc(32, 2).toString('base64'),
        mediaKey: Buffer.alloc(32, 1).toString('base64'),
        caption: 'Original caption',
        contextInfo: { stanzaId: 'original-reply' },
      },
      messageContextInfo: { retained: 'metadata' },
    },
  };
  const original = structuredClone(source);
  const counts = { refresh: 0, download: 0, persist: 0, reads: 0 };
  const input: any = {
    error: new Boom('Expired synthetic media', { statusCode: 403 }),
    instanceId: source.instanceId,
    original,
    requestedKey: original.key,
    message: structuredClone(source),
    type: source.messageType,
    readSource: async () => {
      counts.reads++;
      return [structuredClone(source)];
    },
    refresh: async (m: any) => {
      counts.refresh++;
      m.message.imageMessage.url = 'https://mmg.whatsapp.net/refreshed';
      m.message.imageMessage.directPath = '/refreshed';
      return m;
    },
    download: async (_m: any, limit: number) => {
      counts.download++;
      assert.equal(limit, bytes.length);
      return bytes;
    },
    persistPointers: async (current: any, pointers: any) => {
      counts.persist++;
      assert.deepEqual(current, source);
      Object.assign(source.message.imageMessage, pointers);
    },
  };
  return { source, original, counts, input };
}

test('normalizes real installed-SDK Boom expiry status and refreshes only 403/410', () => {
  for (const status of [403, 410]) {
    const error = new Boom('synthetic', { statusCode: status });
    assert.equal((error as any).status, undefined);
    assert.equal(expiredNativeMediaStatus(error), status);
    assert.equal(expiredNativeMediaStatus({ status }), status);
  }
  for (const error of [
    undefined,
    { status: 404 },
    { output: { statusCode: 500 } },
    { status: '403' },
    new Error('403'),
  ])
    assert.equal(expiredNativeMediaStatus(error), undefined);
});

test('one verified refresh preserves native metadata and persists only authenticated pointers', async () => {
  const { source, original, counts, input } = setup();
  assert.deepEqual(await refreshExpiredNativeMedia(input), bytes);
  const expected = structuredClone(original);
  expected.message.imageMessage.url = 'https://mmg.whatsapp.net/refreshed';
  expected.message.imageMessage.directPath = '/refreshed';
  assert.deepEqual(source, expected);
  assert.deepEqual(counts, { refresh: 1, download: 1, persist: 1, reads: 3 });
});

test('stock SDK refresh encrypts a receipt to the own device, retaining the exact original media key', async () => {
  const { original } = setup();
  const own = '999999999@s.whatsapp.net';
  const node = await encryptMediaRetryRequest(original.key, Buffer.alloc(32, 1), own);
  assert.equal(node.tag, 'receipt');
  assert.equal(node.attrs.type, 'server-error');
  assert.equal(node.attrs.to, own);
  assert.equal(node.attrs.id, original.key.id);
  const rmr = (node.content as any[]).find((n) => n.tag === 'rmr');
  assert.deepEqual(rmr.attrs, { jid: original.key.remoteJid, from_me: 'false', participant: original.key.participant });
});

test('persisted base64 media key is decoded for authenticated stock receipts without changing native JSON', async () => {
  const { original, counts, input } = setup();
  const nativeBefore = structuredClone(original);
  const messageBefore = structuredClone(input.message);
  const own = '999999999@s.whatsapp.net';
  const retryKey = await hkdf(Buffer.alloc(32, 1), 32, { info: 'WhatsApp Media Retry Notification' });
  const decrypt = (node: any) => {
    const encrypted = node.content.find((child: any) => child.tag === 'encrypt').content;
    const payload = encrypted.find((child: any) => child.tag === 'enc_p').content;
    const iv = encrypted.find((child: any) => child.tag === 'enc_iv').content;
    return aesDecryptGCM(payload, retryKey, iv, Buffer.from(original.key.id));
  };
  const incorrect = await encryptMediaRetryRequest(original.key, original.message.imageMessage.mediaKey as any, own);
  assert.throws(() => decrypt(incorrect));
  const refresh = input.refresh;
  input.refresh = async (message: any) => {
    assert(Buffer.isBuffer(message.message.imageMessage.mediaKey));
    assert.deepEqual(message.message.imageMessage.mediaKey, Buffer.alloc(32, 1));
    const receipt = await encryptMediaRetryRequest(message.key, message.message.imageMessage.mediaKey, own);
    assert.equal(proto.ServerErrorReceipt.decode(decrypt(receipt)).stanzaId, original.key.id);
    assert.equal(receipt.tag, 'receipt');
    assert.equal(receipt.attrs.to, own);
    assert.equal(receipt.attrs.type, 'server-error');
    return refresh(message);
  };
  assert.deepEqual(await refreshExpiredNativeMedia(input), bytes);
  assert.deepEqual(input.original, nativeBefore);
  assert.deepEqual(input.message, messageBefore);
  assert.equal(counts.refresh, 1);
  assert.equal(counts.persist, 1);
});

test('actual Node26 SDK HTTP403 then decrypts authenticated refreshed ciphertext once in synthetic lab', async () => {
  const { counts, input } = setup();
  const mock = new MockAgent();
  mock.disableNetConnect();
  const keys = await getMediaKeys(Buffer.alloc(32, 1), 'image');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const mac = createHmac('sha256', keys.macKey)
    .update(Buffer.concat([keys.iv, encrypted]))
    .digest()
    .subarray(0, 10);
  const response = Buffer.concat([encrypted, mac]);
  input.original.message.imageMessage.fileEncSha256 = createHash('sha256').update(response).digest('base64');
  input.message.message.imageMessage.fileEncSha256 = input.original.message.imageMessage.fileEncSha256;
  const source = (await input.readSource())[0];
  source.message.imageMessage.fileEncSha256 = input.original.message.imageMessage.fileEncSha256;
  input.readSource = async () => {
    counts.reads++;
    return [structuredClone(source)];
  };
  input.persistPointers = async (_current: any, pointers: any) => {
    counts.persist++;
    Object.assign(source.message.imageMessage, pointers);
  };
  mock.get('https://mmg.whatsapp.net').intercept({ path: '/expired', method: 'GET' }).reply(403, 'expired');
  mock.get('https://mmg.whatsapp.net').intercept({ path: '/refreshed', method: 'GET' }).reply(200, response);
  const options = { options: { dispatcher: mock } } as any;
  try {
    await assert.rejects(downloadMediaMessage(input.message, 'buffer', options), (error: any) => {
      assert.equal(error.status, undefined);
      assert.equal(error.output.statusCode, 403);
      input.error = error;
      return true;
    });
    input.download = async (message: any, limit: number) => {
      counts.download++;
      const stream = await downloadMediaMessage(message, 'stream', options);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        assert(size <= limit);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    };
    assert.deepEqual(await refreshExpiredNativeMedia(input), bytes);
    assert.equal(counts.refresh, 1);
    assert.equal(counts.download, 1);
    assert.equal(counts.persist, 1);
    mock.assertNoPendingInterceptors();
  } finally {
    await mock.close();
  }
});

for (const change of [
  'foreign-instance',
  'foreign-peer',
  'foreign-direction',
  'changed-caption',
  'missing',
  'duplicate',
]) {
  test(`refuses ${change} source before any refresh`, async () => {
    const { source, counts, input } = setup();
    if (change === 'foreign-instance') source.instanceId = 'other';
    if (change === 'foreign-peer') source.key.remoteJid = '987654321@g.us';
    if (change === 'foreign-direction') source.key.fromMe = true;
    if (change === 'changed-caption') source.message.imageMessage.caption = 'Changed';
    if (change === 'missing') input.readSource = async () => [];
    if (change === 'duplicate') input.readSource = async () => [source, structuredClone(source)];
    await assert.rejects(refreshExpiredNativeMedia(input), /native_media_refresh_source/);
    assert.equal(counts.refresh, 0);
    assert.equal(counts.persist, 0);
  });
}

for (const change of ['caption', 'reply', 'MIME', 'hash', 'key', 'context', 'URL']) {
  test(`refuses refreshed ${change} changes without persisting`, async () => {
    const { counts, input } = setup();
    const refresh = input.refresh;
    input.refresh = async (m: any) => {
      const r = await refresh(m);
      if (change === 'caption') r.message.imageMessage.caption = 'Unexpected';
      if (change === 'reply') r.message.imageMessage.contextInfo.stanzaId = 'Unexpected';
      if (change === 'MIME') r.message.imageMessage.mimetype = 'application/pdf';
      if (change === 'hash') r.message.imageMessage.fileSha256 = Buffer.alloc(32, 7).toString('base64');
      if (change === 'key') r.key.id = 'Other';
      if (change === 'context') r.message.messageContextInfo.retained = 'Unexpected';
      if (change === 'URL') r.message.imageMessage.url = 'https://foreign.invalid/private';
      return r;
    };
    await assert.rejects(
      refreshExpiredNativeMedia(input),
      /native_media_refresh_(metadata_changed|pointer_unqualified)/,
    );
    assert.equal(counts.refresh, 1);
    assert.equal(counts.download, 0);
    assert.equal(counts.persist, 0);
  });
}

test('wrong bytes and a rotated native source never persist a pointer', async () => {
  for (const rotated of [false, true]) {
    const { source, counts, input } = setup();
    input.download = async () => {
      if (rotated) source.message.imageMessage.caption = 'Concurrent edit';
      return rotated ? bytes : Buffer.from('corrupt');
    };
    await assert.rejects(refreshExpiredNativeMedia(input), /native_media_refresh_(bytes_mismatch|source_rotated)/);
    assert.equal(counts.persist, 0);
  }
});

test('refresh failure produces one attempt, no download or pointer write', async () => {
  const { counts, input } = setup();
  input.refresh = async () => {
    counts.refresh++;
    throw new Error('device unavailable');
  };
  await assert.rejects(refreshExpiredNativeMedia(input), /device unavailable/);
  assert.deepEqual(counts, { refresh: 1, download: 0, persist: 0, reads: 1 });
});

test('absolute deadline covers source reads, and a late receipt never starts a download', async () => {
  for (const phase of ['source', 'refresh']) {
    const { counts, input } = setup();
    input.deadlineMs = 20;
    let settle: (value: any) => void;
    if (phase === 'source')
      input.readSource = () =>
        new Promise((resolve) => {
          settle = resolve;
        });
    else
      input.refresh = () => {
        counts.refresh++;
        return new Promise((resolve) => {
          settle = resolve;
        });
      };
    await assert.rejects(refreshExpiredNativeMedia(input), /deadline_unknown_no_retry/);
    settle!(phase === 'source' ? [] : input.message);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(counts.download, 0);
    assert.equal(counts.persist, 0);
  }
});

test('failed compare-and-set and unproved pointer readback refuse success', async () => {
  for (const noWrite of [false, true]) {
    const { input } = setup();
    input.persistPointers = async () => {
      if (!noWrite) throw new Error('CAS refused');
    };
    await assert.rejects(refreshExpiredNativeMedia(input), noWrite ? /persistence_unproved/ : /CAS refused/);
  }
});

test('native endpoint refresh is scoped by source, peer and direction and has no ordinary sender call', () => {
  const source = readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'utf8');
  const method = source.slice(
    source.indexOf('public async getBase64FromMediaMessage('),
    source.indexOf('public async fetchPrivacySettings('),
  );
  assert.match(method, /expiredNativeMediaStatus\(error\)/);
  assert.match(method, /this\.client\.updateMediaMessage\(message\)/);
  for (const key of ['id', 'remoteJid', 'fromMe']) assert(method.includes(`path: ['${key}']`));
  assert.match(method, /saved\.count !== 1/);
  assert.doesNotMatch(method, /sendMessage\(|sendMedia\(|readMessages\(/);
});

test('requested foreign peer and malformed native crypto refuse before a receipt', async () => {
  for (const kind of ['request', 'crypto']) {
    const { source, original, counts, input } = setup();
    if (kind === 'request') input.requestedKey = { ...original.key, remoteJid: 'other@g.us' };
    else {
      source.message.imageMessage.fileSha256 += '!';
      original.message.imageMessage.fileSha256 = source.message.imageMessage.fileSha256;
    }
    await assert.rejects(refreshExpiredNativeMedia(input), /native_media_refresh_(identity|crypto)_unqualified/);
    assert.equal(counts.refresh, 0);
    assert.equal(counts.persist, 0);
  }
});

test('a late native reread never starts a pointer write after the deadline', async () => {
  const { source, counts, input } = setup();
  input.deadlineMs = 20;
  let settle: (value: any) => void;
  let reads = 0;
  input.readSource = () =>
    ++reads === 1
      ? Promise.resolve([structuredClone(source)])
      : new Promise((resolve) => {
          settle = resolve;
        });
  await assert.rejects(refreshExpiredNativeMedia(input), /deadline_unknown_no_retry/);
  settle!([structuredClone(source)]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(counts.persist, 0);
});
