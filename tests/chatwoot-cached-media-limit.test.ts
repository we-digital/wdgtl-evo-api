import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CACHED_MEDIA_BATCH_LIMIT,
  CACHED_MEDIA_FILE_LIMIT,
  nativeCachedMediaPayload,
  prepareCachedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

function video(id: string, size: number, digest = Buffer.alloc(32).toString('base64')) {
  return {
    id,
    instanceId: 'synthetic-instance',
    messageType: 'videoMessage',
    key: { id, remoteJid: '628111111111@s.whatsapp.net', fromMe: false },
    message: { videoMessage: { mimetype: 'video/mp4', fileName: `${id}.mp4`, fileLength: size, fileSha256: digest } },
  } as any;
}
function media(message: any) {
  return {
    messageId: message.id,
    instanceId: message.instanceId,
    type: message.messageType,
    mimetype: 'video/mp4',
    fileName: `${message.instanceId}/${message.key.remoteJid}/videoMessage/1700000000000_${message.id}.mp4`,
  } as any;
}

test('authenticated ordinary files accept 43MB and exact 64MiB, but reject over-limit and invalid digest', () => {
  assert.equal(CACHED_MEDIA_FILE_LIMIT, 64 * 1024 * 1024);
  assert.equal(CACHED_MEDIA_BATCH_LIMIT, 64 * 1024 * 1024);
  for (const size of [43204359, CACHED_MEDIA_FILE_LIMIT]) {
    assert.equal(nativeCachedMediaPayload(video('bounded', size)).size, size);
  }
  assert.throws(() => nativeCachedMediaPayload(video('large', CACHED_MEDIA_FILE_LIMIT + 1)));
  assert.throws(() => nativeCachedMediaPayload(video('invalid', 43204359, Buffer.alloc(31).toString('base64'))));
});

test('batch bytes remain bounded and refuse before reading the file that would exceed the total', async () => {
  const bytes = Buffer.alloc(32 * 1024 * 1024, 7);
  const digest = createHash('sha256').update(bytes).digest('base64');
  const rows = [video('one', bytes.length, digest), video('two', bytes.length, digest)];
  let reads = 0;
  const read = async () => {
    reads++;
    return bytes;
  };
  const prepared = await prepareCachedRecoveryMedia(rows, async (row) => media(row), read);
  assert.equal(prepared.size, 2);
  assert.equal(reads, 2);
  reads = 0;
  await assert.rejects(
    prepareCachedRecoveryMedia([...rows, video('overflow', 1)], async (row) => media(row), read),
    /cached_media_batch_limit/,
  );
  assert.equal(reads, 2);
  reads = 0;
  await assert.rejects(
    prepareCachedRecoveryMedia([video('too-large', CACHED_MEDIA_FILE_LIMIT + 1)], async (row) => media(row), read),
    /cached_media_size_or_digest_unavailable/,
  );
  assert.equal(reads, 0);
});
