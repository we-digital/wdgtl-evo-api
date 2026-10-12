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

test('cached aggregate budget uses complete authenticated physical sizes, not native declared sizes', async () => {
  const bytes = Buffer.alloc(32 * 1024 * 1024, 7);
  const overflow = Buffer.from([9]);
  const digest = createHash('sha256').update(bytes).digest('base64');
  const overflowDigest = createHash('sha256').update(overflow).digest('base64');
  // PR148 permits a contradictory reported length only after full physical SHA proof.
  const rows = [video('one', 2 * 1024 * 1024, digest), video('two', 2 * 1024 * 1024, digest)];
  const before = JSON.stringify(rows);
  let reads = 0;
  const read = async (name: string) => {
    reads++;
    return name.endsWith('_overflow.mp4') ? overflow : bytes;
  };
  const prepared = await prepareCachedRecoveryMedia(rows, async (row) => media(row), read);
  assert.equal(prepared.size, 2);
  assert.equal(reads, 2);
  for (const result of prepared.values()) {
    assert.equal(result.descriptor.size, bytes.length);
    assert.equal(result.descriptor.nativeReportedSize, 2 * 1024 * 1024);
  }
  assert.equal(
    [...prepared.values()].reduce((total, result) => total + result.bytes.length, 0),
    CACHED_MEDIA_BATCH_LIMIT,
  );
  reads = 0;
  await assert.rejects(
    prepareCachedRecoveryMedia([...rows, video('overflow', 1, overflowDigest)], async (row) => media(row), read),
    /cached_media_batch_limit/,
  );
  assert.equal(reads, 3, 'Cached size must be authenticated before enforcing the measured aggregate budget');
  assert.equal(JSON.stringify(rows), before);
});

test('provider aggregate budget refuses before the download that exceeds native exact lengths', async () => {
  const bytes = Buffer.alloc(32 * 1024 * 1024, 7);
  const digest = createHash('sha256').update(bytes).digest('base64');
  const overflow = Buffer.from([9]);
  const rows = [video('one', bytes.length, digest), video('two', bytes.length, digest)];
  let reads = 0;
  const read = async () => {
    reads++;
    return bytes;
  };
  await assert.rejects(
    prepareCachedRecoveryMedia(
      [...rows, video('overflow', 1, createHash('sha256').update(overflow).digest('base64'))],
      async () => null,
      async () => assert.fail('Provider path must not read stored objects'),
      read,
    ),
    /cached_media_batch_limit/,
  );
  assert.equal(reads, 2);
  reads = 0;
  await assert.rejects(
    prepareCachedRecoveryMedia([video('too-large', CACHED_MEDIA_FILE_LIMIT + 1)], async () => null, read, read),
    /cached_media_size_or_digest_unavailable/,
  );
  assert.equal(reads, 0);
});

test('corrupt cached physical bytes still fail their native digest before aggregate accounting', async () => {
  const expected = Buffer.from('expected-owned-bytes');
  const corrupted = Buffer.from('different-owned-bytes');
  let reads = 0;
  const source = video('corrupt', expected.length, createHash('sha256').update(expected).digest('base64'));
  await assert.rejects(
    prepareCachedRecoveryMedia(
      [source],
      async (row) => media(row),
      async () => {
        reads++;
        return corrupted;
      },
    ),
    /cached_media_bytes_mismatch/,
  );
  assert.equal(reads, 1);
});
