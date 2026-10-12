import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  CACHED_MEDIA_FILE_LIMIT,
  prepareCachedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import {
  readBoundedStoredMedia,
  STORED_MEDIA_READ_LIMIT,
} from '../src/api/integrations/storage/s3/libs/stored-media-reader';

const bytes = Buffer.from('synthetic-complete-native-file');
function source(size: number, id = 'native') {
  return {
    id,
    instanceId: 'owned-instance',
    messageType: 'documentMessage',
    key: { id, fromMe: false, remoteJid: '628111111111@s.whatsapp.net' },
    message: {
      documentMessage: {
        fileLength: size,
        fileSha256: createHash('sha256').update(bytes).digest('base64'),
        mimetype: 'application/pdf',
        fileName: 'synthetic.pdf',
      },
    },
  } as any;
}
function media(message: ReturnType<typeof source>) {
  return {
    messageId: message.id,
    instanceId: message.instanceId,
    type: message.messageType,
    mimetype: 'application/pdf',
    fileName: `${message.instanceId}/${message.key.remoteJid}/${message.key.id}/documentMessage/synthetic.pdf`,
  } as any;
}
const stat = (size: number, mime = 'application/pdf') => ({ size, metaData: { 'content-type': mime } });

test('stored native SHA authenticates shorter and longer declared lengths without changing the source', async () => {
  for (const reported of [bytes.length - 7, bytes.length + 7]) {
    const message = source(reported);
    const before = JSON.stringify(message);
    const prepared = await prepareCachedRecoveryMedia(
      [message],
      async () => media(message),
      async (_name, length, mime) => {
        assert.equal(length, reported);
        return readBoundedStoredMedia(
          async () => stat(bytes.length),
          async () => Readable.from(bytes),
          mime,
        );
      },
      async () => assert.fail('Stored authority must not fall back to provider reads'),
    );
    assert.equal(prepared.get(message.id)?.descriptor.size, bytes.length);
    assert.equal(prepared.get(message.id)?.descriptor.nativeReportedSize, reported);
    assert.deepEqual(prepared.get(message.id)?.bytes, bytes);
    assert.equal(JSON.stringify(message), before);
  }
});

test('corrupt, empty and malformed native evidence never qualifies stored length reconciliation', async () => {
  const message = source(bytes.length + 7);
  for (const stored of [Buffer.from('wrong SHA'), Buffer.alloc(0)]) {
    await assert.rejects(
      prepareCachedRecoveryMedia(
        [message],
        async () => media(message),
        async () => stored,
      ),
      /cached_media_bytes_mismatch/,
    );
  }
  for (const reported of [0, CACHED_MEDIA_FILE_LIMIT + 1]) {
    const invalid = source(reported);
    await assert.rejects(
      prepareCachedRecoveryMedia(
        [invalid],
        async () => media(invalid),
        async () => assert.fail('Invalid native bound'),
      ),
      /cached_media_size_or_digest_unavailable/,
    );
  }
});

test('missing Media and provider download retain exact native length even with matching SHA', async () => {
  for (const reported of [bytes.length - 7, bytes.length + 7]) {
    await assert.rejects(
      prepareCachedRecoveryMedia(
        [source(reported)],
        async () => null,
        async () => assert.fail('No stored authority'),
        async () => bytes,
      ),
      /cached_media_bytes_mismatch/,
    );
  }
});

test('stored batch budget counts measured bytes instead of small reported lengths', async () => {
  const physical = Buffer.alloc(STORED_MEDIA_READ_LIMIT, 37);
  const messages = Array.from({ length: 9 }, (_, i) => {
    const row = source(1, String(i));
    row.message.documentMessage.fileSha256 = createHash('sha256').update(physical).digest('base64');
    return row;
  });
  await assert.rejects(
    prepareCachedRecoveryMedia(
      messages,
      async (row: any) => media(row),
      async () => physical,
    ),
    /cached_media_batch_limit/,
  );
});

test('storage rejects invalid stat bounds and MIME before fetching bytes', async () => {
  for (const metadata of [stat(0), stat(1.5), stat(STORED_MEDIA_READ_LIMIT + 1), stat(bytes.length, 'image/jpeg')]) {
    await assert.rejects(
      readBoundedStoredMedia(
        async () => metadata,
        async () => assert.fail('No invalid-object read'),
        'application/pdf',
      ),
      /cached_media_storage_metadata_mismatch/,
    );
  }
});

test('storage refuses truncation and overflow against authenticated stat and closes each stream', async () => {
  for (const physical of [bytes.subarray(1), Buffer.concat([bytes, Buffer.from('extra')])]) {
    const stream = Readable.from(physical);
    await assert.rejects(
      readBoundedStoredMedia(
        async () => stat(bytes.length),
        async () => stream,
        'application/pdf',
      ),
      /cached_media_storage_(truncated|bound)/,
    );
    assert.equal(stream.destroyed, true);
  }
});

test('storage deadline closes a stalled stream', async () => {
  const stream = new Readable({ read() {} });
  await assert.rejects(
    readBoundedStoredMedia(
      async () => stat(bytes.length),
      async () => stream,
      'application/pdf',
    ),
    /cached_media_storage_timeout/,
  );
  assert.equal(stream.destroyed, true);
});
