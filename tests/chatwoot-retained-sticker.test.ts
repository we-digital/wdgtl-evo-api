import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import { getMediaKeys } from 'baileys';

import {
  cachedHistoryMediaType,
  nativeCachedMediaPayload,
  prepareCachedRecoveryMedia,
  readRetainedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

const bytes = Buffer.from('synthetic-authenticated-WebP-sticker');
const key = Buffer.alloc(32, 3);
function sticker() {
  return {
    id: 'native-sticker',
    instanceId: 'synthetic-instance',
    messageType: 'stickerMessage',
    key: { id: 'STICKER', fromMe: false, remoteJid: '628111111111@s.whatsapp.net' },
    message: {
      stickerMessage: {
        mimetype: 'image/webp',
        fileLength: { low: bytes.length, high: 0, unsigned: true },
        fileSha256: createHash('sha256').update(bytes).digest('base64'),
        mediaKey: key.toString('base64'),
        directPath: '/synthetic-sticker',
      },
    },
  } as any;
}
const media = {
  id: 'owned-sticker',
  messageId: 'native-sticker',
  instanceId: 'synthetic-instance',
  type: 'stickerMessage',
  mimetype: 'image/webp',
  fileName: 'synthetic-instance/628111111111@s.whatsapp.net/stickerMessage/1700000000000_synthetic.webp',
} as any;

test('owned native sticker retains raw authority and maps only its upload type to image', async () => {
  const row = sticker();
  const before = JSON.stringify(row);
  const prepared = await prepareCachedRecoveryMedia(
    [row],
    async () => media,
    async () => bytes,
  );
  assert.equal(prepared.get(row.id)?.bytes.equals(bytes), true);
  assert.equal(cachedHistoryMediaType(row), 'image');
  assert.equal(nativeCachedMediaPayload(row).size, bytes.length);
  assert.equal(JSON.stringify(row), before);
  for (const changed of [
    { ...media, type: 'imageMessage' },
    { ...media, instanceId: 'foreign' },
    { ...media, fileName: 'foreign/sticker.webp' },
    { ...media, mimetype: 'image/png' },
  ]) {
    await assert.rejects(
      prepareCachedRecoveryMedia(
        [row],
        async () => changed,
        async () => bytes,
      ),
    );
  }
  await assert.rejects(
    prepareCachedRecoveryMedia(
      [row],
      async () => media,
      async () => Buffer.alloc(bytes.length),
    ),
  );
});

test('missing native WebP sticker uses one default SDK read with encrypted/plain SHA, MAC and size intact', async () => {
  const keys = await getMediaKeys(key, 'sticker');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const mac = createHmac('sha256', keys.macKey)
    .update(Buffer.concat([keys.iv, body]))
    .digest()
    .subarray(0, 10);
  const ciphertext = Buffer.concat([body, mac]);
  const row = sticker();
  row.message.stickerMessage.fileEncSha256 = createHash('sha256').update(ciphertext).digest('base64');
  const before = JSON.stringify(row);
  let reads = 0;
  const downloaded = await readRetainedRecoveryMedia(row, undefined, (async (_url: any, options: any) => {
    reads++;
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return new Response(ciphertext, { status: 200 });
  }) as any);
  assert(downloaded.equals(bytes));
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(row), before);
  const prepared = await prepareCachedRecoveryMedia(
    [row],
    async () => null,
    async () => assert.fail('No owned object'),
    async () => downloaded,
  );
  assert.equal(prepared.get(row.id)?.descriptor.filename, 'STICKER.webp');
  for (const change of [
    { mimetype: 'image/png' },
    { fileSha256: Buffer.alloc(32).toString('base64') },
    { fileEncSha256: Buffer.alloc(32).toString('base64') },
    { mediaKey: Buffer.alloc(32).toString('base64') },
    { fileLength: bytes.length + 1 },
  ]) {
    const rotated = sticker();
    Object.assign(rotated.message.stickerMessage, row.message.stickerMessage, change);
    await assert.rejects(readRetainedRecoveryMedia(rotated, undefined, (async () => new Response(ciphertext)) as any));
  }
});
