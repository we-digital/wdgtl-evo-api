import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { getMediaKeys } from 'baileys';
import {
  prepareCachedRecoveryMedia,
  readRetainedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
async function fixture(size = 1322681) {
  const plaintext = Buffer.alloc(size, 37);
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

test('native documents retain exact MIME and filename through one authenticated SDK Document decrypt', async () => {
  const f = await fixture();
  for (const mime of [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png',
    'image/jpeg',
    'text/plain',
    'text/csv',
    'application/zip',
    'application/octet-stream',
    'application/x-new-authenticated-native-file',
  ]) {
    const row = structuredClone(f.row);
    row.message.documentMessage.mimetype = mime;
    row.message.documentMessage.fileName = 'native-file.xlsx';
    const before = JSON.stringify(row);
    let fetched = 0;
    const result = await prepareCachedRecoveryMedia(
      [row],
      async () => null,
      async () => assert.fail('No owned object exists'),
      async (message) =>
        readRetainedRecoveryMedia(message, undefined, (async () => {
          fetched++;
          return new Response(f.ciphertext);
        }) as any),
    );
    assert.equal(fetched, 1);
    const entry = result.get(row.id)!;
    assert.equal(entry.descriptor.mimetype, mime);
    assert.equal(entry.descriptor.filename, 'native-file.xlsx');
    assert(entry.bytes.equals(f.plaintext));
    assert.equal(JSON.stringify(row), before);
  }
});
test('malformed MIME, header controls and unknown native outer kinds refuse before any GET', async () => {
  const f = await fixture();
  for (const mime of [
    '',
    null,
    'text',
    'application/',
    'application/pdf; injected=true',
    'application/pdf\r\nX-Injected: yes',
    'application/ pdf',
    'application/' + 'x'.repeat(100),
    'evil/subtype',
  ]) {
    const row = structuredClone(f.row);
    row.message.documentMessage.mimetype = mime;
    await assert.rejects(
      () => readRetainedRecoveryMedia(row, undefined, (async () => assert.fail('No malformed descriptor GET')) as any),
      /cached_media_authority_unavailable/,
    );
  }
  const wrong = structuredClone(f.row);
  wrong.messageType = 'unknown';
  await assert.rejects(() =>
    readRetainedRecoveryMedia(wrong, undefined, (async () => assert.fail('No unknown kind GET')) as any),
  );
  const png = structuredClone(f.row);
  png.messageType = 'imageMessage';
  png.message = { imageMessage: { ...png.message.documentMessage, mimetype: 'image/png' } };
  await assert.rejects(
    () => readRetainedRecoveryMedia(png, undefined, (async () => assert.fail('No image fallback extension')) as any),
    /cached_media_authority_unavailable/,
  );
});
test('native document missing filename uses honest generic extension without assuming PDF', async () => {
  const f = await fixture();
  f.row.message.documentMessage.mimetype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  delete f.row.message.documentMessage.fileName;
  const result = await prepareCachedRecoveryMedia(
    [f.row],
    async () => null,
    async () => assert.fail('No cache'),
    async (message) => readRetainedRecoveryMedia(message, undefined, (async () => new Response(f.ciphertext)) as any),
  );
  assert.equal(result.get(f.row.id)!.descriptor.filename, 'SYNTHETICPDF.bin');
});

test('native 9,177,575-byte PDF retains encrypted/plain SHA and MAC through the bounded default path', async () => {
  const f = await fixture(9177575);
  let gets = 0;
  const prepared = await prepareCachedRecoveryMedia(
    [f.row],
    async () => null,
    async () => assert.fail('No owned object'),
    async (message) =>
      readRetainedRecoveryMedia(message, undefined, (async () => {
        gets++;
        return new Response(f.ciphertext);
      }) as any),
  );
  assert.equal(gets, 1);
  assert.equal(prepared.get(f.row.id)!.descriptor.size, 9177575);
  assert(prepared.get(f.row.id)!.bytes.equals(f.plaintext));
  const corrupt = structuredClone(f.row);
  corrupt.message.documentMessage.fileSha256 = Buffer.alloc(32, 9).toString('base64');
  await assert.rejects(
    () => readRetainedRecoveryMedia(corrupt, undefined, (async () => new Response(f.ciphertext)) as any),
    /cached_media_bytes_mismatch/,
  );
  const oversized = structuredClone(f.row);
  oversized.message.documentMessage.fileLength.low = 32 * 1024 * 1024 + 1;
  await assert.rejects(
    () =>
      readRetainedRecoveryMedia(oversized, undefined, (async () =>
        assert.fail('Oversized descriptor must refuse before GET')) as any),
    /cached_media_size_or_digest_unavailable/,
  );
});
