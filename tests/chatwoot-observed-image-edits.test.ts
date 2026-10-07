import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { nativeCachedMediaPayload, readRetainedRecoveryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import { captureMissingPlaintextEditOriginal } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ignored-history-edit';
import { readRetainedChatwootGroupVideo } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-chatwoot-video';
import { retainedHistoryDisplayBody, retainedHistoryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';

const bytes = Buffer.from('synthetic JPEG bytes');
const jpeg = {
  url: 'https://mmg.whatsapp.net/synthetic', directPath: '/synthetic', width: 640, height: 480,
  caption: 'synthetic caption', mimetype: 'image/jpeg', fileLength: { low: bytes.length, high: 0, unsigned: true },
  fileSha256: createHash('sha256').update(bytes).digest('base64'), mediaKey: Buffer.alloc(32, 3).toString('base64'),
  fileEncSha256: Buffer.alloc(32, 4).toString('base64'), mediaKeyTimestamp: { low: 123, high: 0, unsigned: true },
  annotations: [], contextInfo: {}, scanLengths: [], interactiveAnnotations: [],
};
const source: any = {
  id: 'native-image', instanceId: 'owned', messageTimestamp: 1700000000, status: 'DELIVERY_ACK',
  key: { id: 'synthetic-image', remoteJid: '120363123456@g.us', fromMe: false },
  messageType: 'associatedChildMessage',
  message: { associatedChildMessage: { message: { imageMessage: jpeg } }, messageContextInfo: { threadId: [] } },
};

function edit(body: any): any {
  return { ...source, id: 'native-edit', key: { ...source.key, id: 'synthetic-edit' }, messageType: 'protocolMessage',
    message: { protocolMessage: { type: 14, key: source.key, timestampMs: 1700000000000, editedMessage: body },
      messageContextInfo: { threadId: [] } } };
}
const preview = { text: 'synthetic edit', title: 'synthetic title', matchedText: 'https://example.invalid',
  previewType: 0, inviteLinkGroupTypeV2: 0, contextInfo: {}, endCardTiles: [] };

test('associated JPEG keeps full source tag while display and authenticated download select image', async () => {
  const before = JSON.stringify(source);
  assert.equal(classifyCachedHistoryRecord(source, false), 'ordinary');
  assert.equal(retainedHistoryMedia(source).type, 'imageMessage');
  assert.deepEqual(retainedHistoryDisplayBody(source), { imageMessage: jpeg, messageContextInfo: { threadId: [] } });
  assert.equal(nativeCachedMediaPayload(source).size, bytes.length);
  let calls = 0;
  assert.deepEqual(await readRetainedRecoveryMedia(source, (async (_descriptor: any, type: string) => {
    calls += 1; assert.equal(type, 'image'); return Readable.from([bytes]);
  }) as any), bytes);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(source), before);
});

test('associated JPEG reuses only hash-verified CW bytes with original wrapper and direction retained', async () => {
  const native = { ...source, id: 'retained', instanceId: 'retained-instance', key: { ...source.key, fromMe: true } };
  const copy = { id: 1, account_id: 1, inbox_id: 55, display_id: 2, source_id: `WAID:${source.key.id}`,
    message_type: 1, private: false, created_at_epoch: 1700000002, peer: source.key.remoteJid,
    instance_id: native.instanceId, attachment_id: 3, blob_id: '4', byte_size: String(bytes.length), content_type: 'image/jpeg' };
  const before = JSON.stringify(source);
  assert.deepEqual(await readRetainedChatwootGroupVideo(source, [native], [copy], 1, async () => bytes), bytes);
  assert.equal(JSON.stringify(source), before);
  await assert.rejects(readRetainedChatwootGroupVideo(source, [native], [{ ...copy, message_type: 0 }], 1, async () => assert.fail('direction conflict')));
  await assert.rejects(readRetainedChatwootGroupVideo(source, [native], [copy], 1, async () => Buffer.from('wrong')));
});

test('unknown associated/image fields, invalid hash/MIME/length and mixed wrappers refuse before download', () => {
  for (const changed of [
    { ...jpeg, foreign: true }, { ...jpeg, fileSha256: 'bad' }, { ...jpeg, mimetype: 'image/png' },
    { ...jpeg, fileLength: 0 }, { ...jpeg, width: -1 }, { ...jpeg, mediaKey: 'bad' },
  ]) assert.throws(() => classifyCachedHistoryRecord({ ...source, message: { associatedChildMessage: { message: { imageMessage: changed } } } }, false));
  assert.throws(() => classifyCachedHistoryRecord({ ...source, message: { associatedChildMessage: { message: { imageMessage: jpeg, videoMessage: {} } } } }, false));
  assert.throws(() => classifyCachedHistoryRecord({ ...source, message: { associatedChildMessage: { foreign: true, message: { imageMessage: jpeg } } } }, false));
});

test('observed image and preview deltas account only for independently absent originals, never apply an edit', async () => {
  for (const body of [{ imageMessage: jpeg }, { extendedTextMessage: preview }]) {
    const envelope = edit(body);
    assert.equal(classifyCachedHistoryRecord(envelope, false), 'plaintext_edit');
    const repository = { findUnique: async () => envelope, findMany: async () => [] };
    const proof = await captureMissingPlaintextEditOriginal(envelope, repository, 1, 55);
    assert.equal(proof?.version, 4); assert.equal(proof?.nativeTargetState, 'missing');
    assert.equal(proof?.disposition, 'ignored_unavailable_edit'); assert.equal(proof?.destinationState, 'unqualified');
    assert.equal(proof?.sourceNativeJSON, JSON.stringify(envelope));
    assert.equal(await captureMissingPlaintextEditOriginal(envelope, { ...repository, findMany: async () => [source] }, 1, 55), undefined);
    await assert.rejects(captureMissingPlaintextEditOriginal(envelope, { ...repository, findMany: async () => [source, { ...source, id: 'duplicate' }] }, 1, 55), /ambiguous/);
    await assert.rejects(captureMissingPlaintextEditOriginal(envelope, { ...repository, findUnique: async () => ({ ...envelope, messageTimestamp: envelope.messageTimestamp + 1 }) }, 1, 55), /rotated/);
  }
});

test('unknown preview/edit/image metadata and conflicting target direction cannot be ignored', () => {
  for (const body of [
    { extendedTextMessage: { ...preview, previewType: 1 } }, { extendedTextMessage: { ...preview, inviteLinkGroupTypeV2: 1 } },
    { extendedTextMessage: { ...preview, title: 123 } }, { extendedTextMessage: { ...preview, foreign: true } },
    { imageMessage: { ...jpeg, foreign: true } }, { imageMessage: { ...jpeg, fileSha256: 'bad' } },
    { imageMessage: jpeg, conversation: 'mixed' },
  ]) assert.throws(() => classifyCachedHistoryRecord(edit(body), false));
  const envelope = edit({ imageMessage: jpeg });
  envelope.message.protocolMessage.key = { ...source.key, fromMe: true };
  assert.throws(() => classifyCachedHistoryRecord(envelope, false));
});
