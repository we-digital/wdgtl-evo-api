import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  prepareCachedRecoveryMedia,
  readRetainedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

const bytes = Buffer.alloc(45505, 3);
function image(payload = bytes) {
  return {
    id: 'synthetic-native-image',
    instanceId: 'synthetic-instance',
    messageType: 'imageMessage',
    messageTimestamp: 1700000000,
    key: { id: 'SYNTHETIC_IMAGE', fromMe: false, remoteJid: '628111111111@s.whatsapp.net' },
    message: {
      imageMessage: {
        caption: 'original caption',
        mimetype: 'image/jpeg',
        fileLength: { low: payload.length, high: 0, unsigned: true },
        fileSha256: createHash('sha256').update(payload).digest('base64'),
        mediaKey: Buffer.alloc(32, 1).toString('base64'),
        url: 'https://mmg.whatsapp.net/synthetic-native-image',
      },
    },
  } as any;
}
const media = {
  id: 'synthetic-media',
  messageId: 'synthetic-native-image',
  instanceId: 'synthetic-instance',
  type: 'imageMessage',
  mimetype: 'image/jpeg',
  fileName: 'synthetic-instance/628111111111@s.whatsapp.net/imageMessage/1700000000000_synthetic.jpg',
} as any;

test('missing native JPEG Media uses one authenticated descriptor read and retains the full original envelope', async () => {
  const record = image();
  const before = JSON.stringify(record);
  let calls = 0;
  const prepared = await prepareCachedRecoveryMedia(
    [record],
    async () => null,
    async () => assert.fail('No unowned cache read'),
    (native) =>
      readRetainedRecoveryMedia(native, async (source, kind, options: any) => {
        calls++;
        assert.equal(source.url, record.message.imageMessage.url);
        assert.equal(kind, 'image');
        assert.equal(options.options.redirect, 'error');
        assert.equal(options.options.signal instanceof AbortSignal, true);
        return Readable.from(bytes) as any;
      }),
  );
  assert.equal(calls, 1);
  assert.equal(prepared.get(record.id)?.media, null);
  assert.equal(prepared.get(record.id)?.descriptor.size, 45505);
  assert.equal(prepared.get(record.id)?.bytes.equals(bytes), true);
  assert.equal(JSON.stringify(record), before);
});

test('existing owned JPEG is reused first and cache corruption never falls back to a provider read', async () => {
  let cacheReads = 0;
  let downloads = 0;
  const download = async () => {
    downloads++;
    return bytes;
  };
  const prepared = await prepareCachedRecoveryMedia(
    [image()],
    async () => media,
    async () => {
      cacheReads++;
      return bytes;
    },
    download,
  );
  assert.equal(prepared.size, 1);
  assert.equal(cacheReads, 1);
  assert.equal(downloads, 0);
  await assert.rejects(
    prepareCachedRecoveryMedia(
      [image()],
      async () => media,
      async () => Buffer.from('corrupt'),
      download,
    ),
    /cached_media_bytes_mismatch/,
  );
  assert.equal(downloads, 0);
});

test('missing JPEG refuses unsupported native kinds, MIME, direction, host and descriptor bounds before a GET', async () => {
  for (const change of [
    (r: any) => (r.messageType = 'documentMessage'),
    (r: any) => (r.message.imageMessage.mimetype = 'image/png'),
    (r: any) => (r.key.fromMe = null),
    (r: any) => (r.message.imageMessage.url = 'https://mmg.whatsapp.net.evil.invalid/a'),
    (r: any) => (r.message.imageMessage.url = 'http://mmg.whatsapp.net/a'),
    (r: any) => (r.message.imageMessage.mediaKey = 'bad'),
    (r: any) => (r.message.imageMessage.fileSha256 = 'bad'),
    (r: any) => (r.message.imageMessage.fileLength.low = 32 * 1024 * 1024 + 1),
  ]) {
    const record = image();
    change(record);
    await assert.rejects(() => readRetainedRecoveryMedia(record, async () => assert.fail('No malformed GET')));
  }
  await assert.rejects(
    () => readRetainedRecoveryMedia(image(), async () => Readable.from(Buffer.alloc(45505, 4)) as any),
    /cached_media_bytes_mismatch/,
  );
  await assert.rejects(
    () => readRetainedRecoveryMedia(image(), async () => Readable.from(Buffer.alloc(45506)) as any),
    /cached_media_bytes_mismatch/,
  );
});

test('missing JPEG keeps the whole-media batch bound and returns no prepared result if a later item fails', async () => {
  const large = Buffer.alloc(16 * 1024 * 1024, 2);
  const records = [1, 2, 3].map((id) => ({ ...image(large), id: `synthetic-${id}` }));
  let downloads = 0;
  await assert.rejects(
    prepareCachedRecoveryMedia(
      records,
      async () => null,
      async () => assert.fail('No cache'),
      async () => {
        downloads++;
        return large;
      },
    ),
    /cached_media_batch_limit/,
  );
  assert.equal(downloads, 2);
});

test('missing JPEG aborts its single source read at five seconds without producing import bytes', async () => {
  let calls = 0;
  let aborted = false;
  const start = Date.now();
  await assert.rejects(
    readRetainedRecoveryMedia(image(), async (_source, _kind, options: any) => {
      calls++;
      return new Promise<any>((_resolve, reject) =>
        options.options.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('synthetic source deadline'));
          },
          { once: true },
        ),
      );
    }),
    /synthetic source deadline/,
  );
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal(Date.now() - start < 8000, true);
});
