import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalInboundBody,
  isNativeRetransmission,
  resolveInboundNativeBody,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-native-source';
import { inboundPayloadHash } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';

const b64 = (seed: number, size = 32) => Buffer.alloc(size, seed).toString('base64');
const numeric = (base64: string) =>
  Object.fromEntries([...Buffer.from(base64, 'base64')].map((byte, i) => [String(i), byte]));
const skd = (seed: number) => ({ groupId: '120363000000000000@g.us', axolotlSenderKeyDistributionMessage: b64(seed, 8) });

function media(type: string, extra: Record<string, any> = {}): any {
  return {
    id: 'native-' + type,
    instanceId: 'one',
    key: { id: 'WD79', remoteJid: '120363000000000000@g.us', fromMe: false, participant: '1@lid' },
    messageType: type,
    pushName: 'sender',
    status: 'DELIVERY_ACK',
    messageTimestamp: 1700000000,
    message: {
      [type]: { caption: 'synthetic', mimetype: 'x/y', mediaKey: b64(1), fileSha256: b64(2), fileEncSha256: b64(3) },
      senderKeyDistributionMessage: skd(4),
      ...extra,
    },
  };
}
function blankCopy(of: any): any {
  return {
    ...structuredClone(of),
    id: 'native-blank',
    messageType: 'conversation',
    messageTimestamp: of.messageTimestamp + 8,
    message: { conversation: '', senderKeyDistributionMessage: skd(5) },
  };
}

test('group media followed by a blank sender-key copy of the same key resolves to the media (was InboundNativeSourceAmbiguous)', () => {
  const image = media('imageMessage', { mediaUrl: 'https://s3.synthetic/a.jpg' });
  const frozen = structuredClone(image);
  frozen.message.imageMessage.mediaKey = numeric(image.message.imageMessage.mediaKey);
  delete frozen.message.mediaUrl;
  const resolved = resolveInboundNativeBody([image, blankCopy(image)], frozen);
  // The provider-original native row, as a single source would deliver it.
  assert.equal(inboundPayloadHash(resolved), inboundPayloadHash(canonicalInboundBody(image)));
  assert.equal(resolved.messageType, 'imageMessage');
  assert.equal(resolved.messageTimestamp, image.messageTimestamp);
  const document = media('documentMessage');
  assert.doesNotThrow(() => resolveInboundNativeBody([document, blankCopy(document)], document));
});

test('a document retransmitted with a newer timestamp, other sender key, context and mediaUrl is the same source', () => {
  const original = media('documentMessage', { messageContextInfo: { messageSecret: b64(6) } });
  const copy = structuredClone(original);
  copy.id = 'native-copy';
  copy.messageTimestamp += 2;
  copy.message.senderKeyDistributionMessage = skd(7);
  delete copy.message.messageContextInfo;
  copy.message.mediaUrl = 'https://s3.synthetic/b.pdf';
  copy.message.documentMessage.directPath = '/refreshed';
  const resolved = resolveInboundNativeBody([original, copy], original);
  assert.equal(inboundPayloadHash(resolved), inboundPayloadHash(canonicalInboundBody(original)));
  for (const type of ['videoMessage', 'audioMessage', 'stickerMessage']) {
    const row = media(type);
    const later = { ...structuredClone(row), id: 'later', messageTimestamp: row.messageTimestamp + 3 };
    assert.doesNotThrow(() => resolveInboundNativeBody([row, later], row), type);
  }
});

for (const change of ['caption', 'fileSha256', 'mediaKey', 'participant', 'edited', 'outgoing', 'otherType', 'noAnchor']) {
  test(`media retransmission reconciliation still refuses ${change}`, () => {
    const original = media('documentMessage');
    const stored = structuredClone(original);
    const copy = structuredClone(original);
    copy.id = 'native-copy';
    copy.messageTimestamp += 2;
    if (['caption', 'fileSha256', 'mediaKey'].includes(change)) copy.message.documentMessage[change] = b64(9);
    if (change === 'participant') copy.key.participant = '2@lid';
    if (change === 'edited') copy.status = 'EDITED';
    if (change === 'outgoing') for (const row of [original, stored, copy]) row.key.fromMe = true;
    if (change === 'otherType') {
      copy.messageType = 'imageMessage';
      copy.message = { imageMessage: original.message.documentMessage };
    }
    const sources = change === 'noAnchor' ? [copy, { ...structuredClone(copy), messageTimestamp: 1 }] : [original, copy];
    assert.throws(() => resolveInboundNativeBody(sources, stored), /InboundNativeSourceAmbiguous/);
  });
}

test('a blank copy never replaces media whose own content rows disagree', () => {
  const original = media('imageMessage');
  const changed = structuredClone(original);
  changed.id = 'changed';
  changed.message.imageMessage.caption = 'other';
  assert.throws(
    () => resolveInboundNativeBody([original, changed, blankCopy(original)], original),
    /InboundNativeSourceAmbiguous/,
  );
});

test('notify retransmissions of a stored key are not stored again; new content types and reactions still are', () => {
  const image = media('imageMessage');
  assert.equal(isNativeRetransmission([], blankCopy(image)), true);
  assert.equal(isNativeRetransmission([{ messageType: 'imageMessage', status: 'DELIVERY_ACK' }], blankCopy(image)), true);
  assert.equal(isNativeRetransmission([{ messageType: 'imageMessage', status: 'DELIVERY_ACK' }], image), true);
  assert.equal(isNativeRetransmission([], image), false);
  // A placeholder row (undecryptable first copy) is followed by the real content.
  assert.equal(isNativeRetransmission([{ messageType: 'unknown', status: null }], image), false);
  const text = { ...image, messageType: 'conversation', message: { conversation: 'hello' } };
  assert.equal(isNativeRetransmission([{ messageType: 'conversation', status: 'DELIVERY_ACK' }], text), true);
  assert.equal(isNativeRetransmission([{ messageType: 'conversation', status: 'EDITED' }], text), false);
  const reaction = { ...image, messageType: 'reactionMessage', message: { reactionMessage: { text: 'x' } } };
  assert.equal(isNativeRetransmission([{ messageType: 'reactionMessage', status: null }], reaction), false);
});
