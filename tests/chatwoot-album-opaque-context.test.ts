import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  albumImageCount,
  preserveAlbumContainers,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-album';
import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
function fixture(context: any) {
  const parent: any = {
    id: 'owned-parent',
    instanceId: 'owned',
    key: { id: 'album', remoteJid: '123@g.us', fromMe: false },
    messageType: 'albumMessage',
    messageTimestamp: 100,
    status: 'READ',
    message: { albumMessage: { expectedImageCount: 2, expectedVideoCount: 0, contextInfo: context } },
  };
  const rows = [parent];
  let calls = 0;
  const repository = {
    findMany: async (args: any) => {
      assert.deepEqual(args.where, { instanceId: 'owned', key: { path: ['id'], equals: 'album' } });
      assert.equal(args.take, 17);
      calls++;
      return structuredClone(rows);
    },
  };
  const pool = {
    connect: () => {
      throw new Error('No child or destination query allowed');
    },
  };
  return { parent, rows, repository, pool, calls: () => calls };
}
const known = {
  expiration: 0,
  ephemeralSettingTimestamp: { low: 1711338783, high: 0, unsigned: false },
  disappearingMode: { trigger: 0, initiator: 0 },
  entryPointConversionApp: 'whatsapp',
  entryPointConversionSource: 'global_search_new_chat',
  entryPointConversionDelaySeconds: 75250,
};
for (const context of [
  known,
  { ...known, futureMetadata: { values: [null, true, 123, 'retained'], nested: { immutable: 'sidecar' } } },
]) {
  test('explicit container-only retains complete bounded opaque sidecar without interpreting fields or claiming children', async () => {
    const f = fixture(context),
      before = structuredClone(f.parent);
    assert.throws(() => albumImageCount(f.parent));
    assert.equal(albumImageCount(f.parent, 'container_only'), 2);
    assert.equal(classifyCachedHistoryRecord(f.parent), 'album_container');
    const result = await preserveAlbumContainers([f.parent], f.repository, f.pool, 1, 108, 'container_only');
    await result.assertCurrent();
    const proof = result.proofs.get('WAID:album');
    assert.equal(proof.version, 2);
    assert.equal(proof.childrenQueried, false);
    assert.equal(proof.childrenComplete, false);
    assert.deepEqual(JSON.parse(proof.sourceNativeJSON), before);
    assert.deepEqual(JSON.parse(proof.sameKeyNativeJSON), [before]);
    assert.equal(proof.sourceNativeSHA256, createHash('sha256').update(proof.sourceNativeJSON).digest('hex'));
    assert.deepEqual(f.parent, before);
    assert.equal(f.calls(), 2);
    f.parent.message.albumMessage.contextInfo.changed = true;
    await assert.rejects(result.assertCurrent());
  });
}
let deep: any = {};
for (let i = 0; i < 18; i++) deep = { nested: deep };
const invalid = [
  null,
  [],
  'scalar',
  false,
  42,
  { value: Infinity },
  { value: NaN },
  { value: 'x'.repeat(65537) },
  deep,
  { values: Array(513).fill(0) },
  Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['key' + i, 0])),
  { value: () => null },
  { value: 1n },
  { value: new Date() },
  { [Symbol('not-json')]: true },
];
for (const [i, context] of invalid.entries())
  test(`refuses non-JSON or over-bound metadata ${i}`, () => {
    const f = fixture(context);
    assert.throws(() => albumImageCount(f.parent, 'container_only'));
    assert.throws(() => classifyCachedHistoryRecord(f.parent));
  });
test('refuses accessors without invoking them and keeps unknown outer payload refusal', async () => {
  let invoked = 0;
  const context = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      invoked++;
      return true;
    },
  });
  assert.throws(() => albumImageCount(fixture(context).parent, 'container_only'));
  assert.equal(invoked, 0);
  const f = fixture(known);
  f.parent.message.conversation = 'visible';
  assert.throws(() => albumImageCount(f.parent, 'container_only'));
  await assert.rejects(preserveAlbumContainers([f.parent], f.repository, f.pool, 1, 108, 'container_only'));
});

test('container-only retains bounded messageContextInfo with optional device metadata fields', async () => {
  const f = fixture(known);
  f.parent.message.messageContextInfo = {
    threadId: [],
    messageSecret: Buffer.alloc(32).toString('base64'),
    deviceListMetadataVersion: 2,
    deviceListMetadata: {
      senderTimestamp: { low: 1, high: 0, unsigned: true },
      recipientKeyHash: Buffer.alloc(10).toString('base64'),
      senderKeyIndexes: [],
      recipientTimestamp: { low: 2, high: 0, unsigned: true },
      recipientKeyIndexes: [],
    },
  };
  assert.throws(() => albumImageCount(f.parent));
  const result = await preserveAlbumContainers([f.parent], f.repository, f.pool, 1, 108, 'container_only');
  await result.assertCurrent();
  assert.deepEqual(JSON.parse(result.proofs.get('WAID:album').sourceNativeJSON), f.parent);
  for (const value of [null, [], 'scalar', { field: Infinity }, { field: 'x'.repeat(65537) }]) {
    f.parent.message.messageContextInfo = value;
    assert.throws(() => albumImageCount(f.parent, 'container_only'));
  }
});
