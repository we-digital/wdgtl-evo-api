import assert from 'node:assert/strict';
import test from 'node:test';

import { proto } from 'baileys';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import {
  albumImageCount,
  preserveAlbumContainers,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-album';

function parent(album: any) {
  return {
    id: 'native-parent',
    instanceId: 'owned',
    key: { id: 'album', remoteJid: 'synthetic@g.us', fromMe: false },
    messageType: 'albumMessage',
    messageTimestamp: 100,
    status: 'READ',
    message: {
      albumMessage: album,
      messageContextInfo: { threadId: [], messageSecret: Buffer.alloc(32, 1).toString('base64') },
    },
  };
}

test('installed protobuf leaves optional album counters absent in canonical JSON', () => {
  const decoded = proto.Message.AlbumMessage.decode(proto.Message.AlbumMessage.encode({}).finish());
  assert.equal(decoded.expectedImageCount, null);
  assert.equal(decoded.expectedVideoCount, null);
  assert.deepEqual(decoded.toJSON(), {});
  assert.equal(Object.hasOwn(decoded, 'expectedImageCount'), false);
  assert.deepEqual(
    proto.Message.AlbumMessage.decode(proto.Message.AlbumMessage.encode({ expectedImageCount: 0 }).finish()).toJSON(),
    { expectedImageCount: 0 },
  );
});

for (const album of [{ contextInfo: { quotedType: 4 } }, { expectedImageCount: 2 }, { expectedVideoCount: 0 }]) {
  test(`omitted counters preserve exact container and explicit native-presence flags ${JSON.stringify(Object.keys(album))}`, async () => {
    const source = parent(album),
      before = structuredClone(source);
    assert.throws(() => albumImageCount(source));
    assert.equal(classifyCachedHistoryRecord(source, false), 'album_container');
    const result = await preserveAlbumContainers(
      [source],
      { findMany: async () => [structuredClone(source)] },
      { connect: async () => assert.fail('No children/destination query') },
      1,
      114,
      'container_only',
    );
    await result.assertCurrent();
    const proof = result.proofs.get('WAID:album');
    assert.equal(proof.version, 3);
    assert.equal(proof.nativeImageCountPresent, Object.hasOwn(album, 'expectedImageCount'));
    assert.equal(proof.nativeVideoCountPresent, Object.hasOwn(album, 'expectedVideoCount'));
    assert.equal(proof.expectedImages, 'expectedImageCount' in album ? album.expectedImageCount : 0);
    assert.equal(proof.childrenComplete, false);
    assert.equal(proof.childrenQueried, false);
    assert.equal(proof.children, undefined);
    assert.deepEqual(JSON.parse(proof.sourceNativeJSON), before);
    assert.deepEqual(source, before);
    source.message.albumMessage = { expectedImageCount: 0, expectedVideoCount: 0 };
    await assert.rejects(result.assertCurrent());
  });
}

test('explicit native zero counters retain existing version2 semantics', async () => {
  const source = parent({ expectedImageCount: 0, expectedVideoCount: 0 });
  const result = await preserveAlbumContainers(
    [source],
    { findMany: async () => [structuredClone(source)] },
    {},
    1,
    114,
    'container_only',
  );
  assert.equal(result.proofs.get('WAID:album').version, 2);
  assert.equal(result.proofs.get('WAID:album').nativeImageCountPresent, undefined);
});

test('explicit null, undefined, negative, noninteger, videos and unknown fields remain refused', () => {
  for (const album of [
    { expectedImageCount: null },
    { expectedImageCount: undefined },
    { expectedImageCount: -1 },
    { expectedImageCount: 0.5 },
    { expectedImageCount: 14 },
    { expectedVideoCount: null },
    { expectedVideoCount: 1 },
    { expectedVideoCount: '0' },
    { unexpected: true },
  ]) {
    assert.throws(() => albumImageCount(parent(album), 'container_only'));
  }
});
