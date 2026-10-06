import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import { getMediaKeys } from 'baileys';

import {
  prepareCachedRecoveryMedia,
  readRetainedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

async function fixture(index: number, size: number, family: 'image' | 'document' = 'document') {
  const plaintext = Buffer.alloc(size, index + 1);
  const key = Buffer.alloc(32, index + 2);
  const keys = await getMediaKeys(key, family);
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac('sha256', keys.macKey)
    .update(Buffer.concat([keys.iv, encrypted]))
    .digest()
    .subarray(0, 10);
  const ciphertext = Buffer.concat([encrypted, mac]);
  const row = {
    id: `synthetic-image-${index}`,
    instanceId: 'synthetic-instance',
    messageType: 'imageMessage',
    key: { id: `SYNTHETIC${index}`, fromMe: false, remoteJid: '628111111111@s.whatsapp.net' },
    message: {
      imageMessage: {
        mimetype: 'image/jpeg',
        fileLength: { low: size, high: 0, unsigned: true },
        fileSha256: createHash('sha256').update(plaintext).digest('base64'),
        fileEncSha256: createHash('sha256').update(ciphertext).digest('base64'),
        mediaKey: key.toString('base64'),
        directPath: `/synthetic-${index}`,
      },
    },
  } as any;
  return { row, plaintext, ciphertext };
}

test('whole250 preflight authenticates Document keys for two native JPEGs without changing image envelopes', async () => {
  const images = await Promise.all([fixture(0, 69323), fixture(1, 86242)]);
  const messages = [
    ...Array.from({ length: 248 }, (_, i) => ({ id: `synthetic-text-${i}`, messageType: 'conversation' }) as any),
    ...images.map((x) => x.row),
  ];
  const before = JSON.stringify(messages);
  let reads = 0;
  const prepared = await prepareCachedRecoveryMedia(
    messages,
    async () => null,
    async () => assert.fail('No owned media object'),
    async (message) => {
      const image = images.find((x) => x.row.id === message.id)!;
      return readRetainedRecoveryMedia(message, undefined, (async (url: any, options: any) => {
        reads++;
        assert.equal(url, `https://mmg.whatsapp.net${image.row.message.imageMessage.directPath}`);
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        assert(options.signal instanceof AbortSignal);
        return new Response(image.ciphertext);
      }) as any);
    },
  );
  assert.equal(reads, 2);
  assert.equal(prepared.size, 2);
  for (const image of images) {
    const found = prepared.get(image.row.id)!;
    assert(found.bytes.equals(image.plaintext));
    assert.equal(found.descriptor.mimetype, 'image/jpeg');
    assert.equal(found.descriptor.filename, `${image.row.key.id}.jpg`);
    assert.equal(found.media, null);
  }
  assert.equal(JSON.stringify(messages), before);
});

test('Document selection requires native encrypted SHA, MAC, key and exact plaintext SHA/size with one read', async () => {
  for (const mutation of ['enc_sha', 'missing_enc_sha', 'mac', 'key', 'plain_sha', 'plain_size', 'overflow']) {
    const image = await fixture(2, 69323);
    const descriptor = image.row.message.imageMessage;
    if (mutation === 'enc_sha') descriptor.fileEncSha256 = Buffer.alloc(32).toString('base64');
    if (mutation === 'missing_enc_sha') delete descriptor.fileEncSha256;
    if (mutation === 'mac') {
      image.ciphertext[image.ciphertext.length - 1] ^= 1;
      descriptor.fileEncSha256 = createHash('sha256').update(image.ciphertext).digest('base64');
    }
    if (mutation === 'key') descriptor.mediaKey = Buffer.alloc(32, 9).toString('base64');
    if (mutation === 'plain_sha') descriptor.fileSha256 = Buffer.alloc(32).toString('base64');
    if (mutation === 'plain_size') descriptor.fileLength.low--;
    if (mutation === 'overflow') image.ciphertext = Buffer.alloc(descriptor.fileLength.low + 1025);
    const before = JSON.stringify(image.row);
    let reads = 0;
    await assert.rejects(() =>
      readRetainedRecoveryMedia(image.row, undefined, (async () => {
        reads++;
        return new Response(image.ciphertext);
      }) as any),
    );
    assert.equal(reads, 1, mutation);
    assert.equal(JSON.stringify(image.row), before, mutation);
  }
});

test('owned JPEG bytes stay first and ordinary Image crypto keeps the original SDK path', async () => {
  const image = await fixture(3, 69323, 'image');
  let reads = 0;
  const bytes = await readRetainedRecoveryMedia(image.row, undefined, (async () => {
    reads++;
    return new Response(image.ciphertext);
  }) as any);
  assert(bytes.equals(image.plaintext));
  assert.equal(reads, 1);
  const media = {
    messageId: image.row.id,
    instanceId: image.row.instanceId,
    type: 'imageMessage',
    mimetype: 'image/jpeg',
    fileName: `${image.row.instanceId}/${image.row.key.remoteJid}/imageMessage/1700000000000_synthetic.jpg`,
  } as any;
  let ownedReads = 0;
  const prepared = await prepareCachedRecoveryMedia(
    [image.row],
    async () => media,
    async () => {
      ownedReads++;
      return image.plaintext;
    },
    async () => assert.fail('No provider fallback from an owned object'),
  );
  assert.equal(ownedReads, 1);
  assert(prepared.get(image.row.id)!.bytes.equals(image.plaintext));
});

test('Document crypto does not reinterpret video wrappers or broaden image MIME support', async () => {
  const image = await fixture(4, 69323);
  const descriptor = image.row.message.imageMessage;
  const video = {
    ...image.row,
    messageType: 'associatedChildMessage',
    message: { associatedChildMessage: { message: { videoMessage: { ...descriptor, mimetype: 'video/mp4' } } } },
  } as any;
  let reads = 0;
  await assert.rejects(() =>
    readRetainedRecoveryMedia(video, undefined, (async () => {
      reads++;
      return new Response(image.ciphertext);
    }) as any),
  );
  assert.equal(reads, 1);
  descriptor.mimetype = 'image/png';
  await assert.rejects(() =>
    readRetainedRecoveryMedia(image.row, undefined, (async () => assert.fail('No unsupported MIME request')) as any),
  );
});
