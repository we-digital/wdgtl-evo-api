import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { readRetainedGroupMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-group-media';

const bytes = Buffer.from('synthetic retained group image');
const target = {
  id: 'target-native-row',
  instanceId: 'target-instance',
  messageType: 'imageMessage',
  messageTimestamp: 1700000000,
  key: { id: 'group-source', remoteJid: '120363123456@g.us', fromMe: false },
  message: {
    imageMessage: {
      mimetype: 'image/jpeg',
      caption: 'target caption',
      fileLength: bytes.length,
      fileSha256: createHash('sha256').update(bytes).digest('base64'),
    },
  },
} as any;
const retained = {
  ...target,
  id: 'retained-native-row',
  instanceId: 'retained-instance',
  key: { ...target.key, fromMe: true },
  message: { imageMessage: { ...target.message.imageMessage, caption: 'foreign caption' } },
};
const media = {
  id: 'retained-media',
  messageId: retained.id,
  instanceId: retained.instanceId,
  type: 'imageMessage',
  mimetype: 'image/jpeg',
  fileName: `${retained.instanceId}/${target.key.remoteJid}/imageMessage/1700000000000_synthetic.jpg`,
} as any;
const candidate = { message: retained, media };

test('same group bytes are reusable across participating numbers with different native directions', async () => {
  const before = JSON.stringify(target);
  const result = await readRetainedGroupMedia(target, [candidate], async (name, limit, mime) => {
    assert.equal(name, media.fileName);
    assert.equal(limit, bytes.length);
    assert.equal(mime, 'image/jpeg');
    return bytes;
  });
  assert.deepEqual(result, bytes);
  assert.equal(JSON.stringify(target), before);
});

test('other peer, source, timestamp, type or target instance cannot authorize reads', async () => {
  for (const change of [
    { key: { ...retained.key, remoteJid: '120363999999@g.us' } },
    { key: { ...retained.key, id: 'another-source' } },
    { messageTimestamp: target.messageTimestamp + 1 },
    { messageType: 'documentMessage' },
    { instanceId: target.instanceId },
  ]) {
    assert.equal(
      await readRetainedGroupMedia(target, [{ ...candidate, message: { ...retained, ...change } }], async () => {
        assert.fail('foreign candidate read');
      }),
      null,
    );
  }
});

test('digest, MIME and Media authority conflicts refuse before storage access', async () => {
  for (const changed of [
    {
      ...candidate,
      message: {
        ...retained,
        message: {
          imageMessage: { ...retained.message.imageMessage, fileSha256: Buffer.alloc(32, 1).toString('base64') },
        },
      },
    },
    {
      ...candidate,
      message: {
        ...retained,
        message: { imageMessage: { ...retained.message.imageMessage, fileLength: bytes.length + 1 } },
      },
    },
    { ...candidate, media: { ...media, messageId: 'foreign-native' } },
    { ...candidate, media: { ...media, fileName: 'foreign/object.jpg' } },
    { ...candidate, media: { ...media, mimetype: 'application/pdf' } },
  ]) {
    await assert.rejects(
      readRetainedGroupMedia(target, [changed], async () => {
        assert.fail('unproven candidate read');
      }),
    );
  }
});

test('corrupt stored bytes stop recovery; absent objects allow another retained copy', async () => {
  await assert.rejects(
    readRetainedGroupMedia(target, [candidate], async () => Buffer.alloc(bytes.length)),
    /cached_media_bytes_mismatch/,
  );
  let reads = 0;
  assert.deepEqual(
    await readRetainedGroupMedia(target, [candidate, candidate], async () => {
      if (++reads === 1) throw new Error('storage object absent');
      return bytes;
    }),
    bytes,
  );
  assert.equal(reads, 2);
  assert.equal(
    await readRetainedGroupMedia(target, [candidate], async () => {
      throw new Error('absent');
    }),
    null,
  );
});

test('bounds and direct-message isolation apply without provider or storage requests', async () => {
  await assert.rejects(
    readRetainedGroupMedia(target, Array(26).fill(candidate), async () => bytes),
    /candidate_bound/,
  );
  assert.equal(
    await readRetainedGroupMedia(
      { ...target, key: { ...target.key, remoteJid: '628111111@s.whatsapp.net' } },
      [candidate],
      async () => {
        assert.fail('direct message read');
      },
    ),
    null,
  );
  assert.equal(
    await readRetainedGroupMedia(target, [], async () => {
      assert.fail('empty candidates read');
    }),
    null,
  );
});
