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
const skd = (seed: number) => ({
  groupId: '120363000000000000@g.us',
  axolotlSenderKeyDistributionMessage: b64(seed, 8),
});

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

for (const change of [
  'caption',
  'fileSha256',
  'mediaKey',
  'participant',
  'edited',
  'outgoing',
  'otherType',
  'noAnchor',
]) {
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
    const sources =
      change === 'noAnchor' ? [copy, { ...structuredClone(copy), messageTimestamp: 1 }] : [original, copy];
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
  assert.equal(
    isNativeRetransmission([{ messageType: 'imageMessage', status: 'DELIVERY_ACK', key: image.key }], blankCopy(image)),
    true,
  );
  assert.equal(
    isNativeRetransmission([{ messageType: 'imageMessage', status: 'DELIVERY_ACK', key: image.key }], image),
    true,
  );
  assert.equal(isNativeRetransmission([], image), false);
  // A placeholder row (undecryptable first copy) is followed by the real content.
  assert.equal(isNativeRetransmission([{ messageType: 'unknown', status: null, key: image.key }], image), false);
  const text = { ...image, messageType: 'conversation', message: { conversation: 'hello' } };
  assert.equal(
    isNativeRetransmission([{ messageType: 'conversation', status: 'DELIVERY_ACK', key: image.key }], text),
    true,
  );
  assert.equal(
    isNativeRetransmission([{ messageType: 'conversation', status: 'EDITED', key: image.key }], text),
    false,
  );
  const reaction = { ...image, messageType: 'reactionMessage', message: { reactionMessage: { text: 'x' } } };
  assert.equal(
    isNativeRetransmission([{ messageType: 'reactionMessage', status: null, key: image.key }], reaction),
    false,
  );
});

// ---- Copies that differ only in sender addressing (prod 2026-11-11) ----

const LID = '111111111111111@lid';
const PN = '628000000001@s.whatsapp.net';
function lidCopy(of: any, extra: Record<string, any> = {}) {
  const copy = structuredClone(of);
  copy.id = 'native-lid-' + Math.random();
  copy.key = { ...of.key, participant: LID, participantAlt: PN, addressingMode: 'lid' };
  copy.pushName = 'notify name';
  copy.messageTimestamp = of.messageTimestamp + 76;
  return Object.assign(copy, extra);
}
function bareCopy(of: any) {
  const copy = structuredClone(of);
  copy.id = 'native-bare-' + Math.random();
  copy.key = { id: of.key.id, remoteJid: of.key.remoteJid, fromMe: of.key.fromMe };
  copy.pushName = 'saved contact name';
  delete copy.message.senderKeyDistributionMessage;
  if (copy.message[copy.messageType]) delete copy.message[copy.messageType].jpegThumbnail;
  return copy;
}
const text = (fromMe = false): any => ({
  id: 'native-text',
  instanceId: 'one',
  key: {
    id: '3EB0',
    remoteJid: '120363000000000000@g.us',
    fromMe,
    participant: LID,
    participantAlt: PN,
    addressingMode: 'lid',
  },
  messageType: 'conversation',
  pushName: 'notify name',
  status: 'READ',
  messageTimestamp: 1700000000,
  contextInfo: { stanzaId: 'Q1' },
  message: { conversation: 'synthetic', messageContextInfo: { messageSecret: b64(7) } },
});

test('a LID-addressed media copy and a copy that names no sender are one message (was InboundNativeSourceAmbiguous)', () => {
  const stored = lidCopy(media('imageMessage'));
  const sources = [bareCopy(stored), stored];
  const resolved = resolveInboundNativeBody(sources, stored);
  assert.equal(inboundPayloadHash(resolved), inboundPayloadHash(canonicalInboundBody(stored)));
  assert.equal(resolved.key.participant, LID);
  const document = lidCopy(media('documentMessage'));
  assert.doesNotThrow(() => resolveInboundNativeBody([bareCopy(document), document], document));
});

test('three copies of one group text (no sender, LID+PN, LID+PN) resolve to the provider original', () => {
  const stored = text();
  const second = { ...structuredClone(stored), id: 'native-text-2', messageTimestamp: stored.messageTimestamp + 1 };
  second.message.messageContextInfo = { messageSecret: b64(7), deviceListMetadata: {} };
  const resolved = resolveInboundNativeBody([bareCopy(stored), stored, second], stored);
  assert.equal(inboundPayloadHash(resolved), inboundPayloadHash(canonicalInboundBody(stored)));
});

test('an outgoing group text with an unattributed copy resolves; repeated identical outgoing rows still refuse', () => {
  const stored = text(true);
  stored.key = { ...stored.key, participantAlt: undefined };
  delete stored.key.participantAlt;
  assert.doesNotThrow(() => resolveInboundNativeBody([bareCopy(stored), stored, structuredClone(stored)], stored));
  const repeat = { ...structuredClone(stored), messageTimestamp: stored.messageTimestamp + 4 };
  assert.throws(() => resolveInboundNativeBody([stored, repeat], stored), /InboundNativeSourceAmbiguous/);
});

test('a LID copy and its phone-number form are the same sender; a blank copy without sender key is content-free', () => {
  const stored = lidCopy(media('imageMessage'));
  const pnOnly = structuredClone(stored);
  pnOnly.id = 'pn-only';
  pnOnly.key = { id: stored.key.id, remoteJid: stored.key.remoteJid, fromMe: false, participant: PN };
  assert.doesNotThrow(() => resolveInboundNativeBody([stored, pnOnly], stored));
  const blank = {
    ...structuredClone(stored),
    id: 'blank',
    messageType: 'conversation',
    message: { conversation: '', messageContextInfo: {} },
  };
  assert.doesNotThrow(() => resolveInboundNativeBody([stored, blank], stored));
});

for (const change of [
  'otherPerson',
  'caption',
  'mediaKey',
  'fileSha256',
  'text',
  'replyTarget',
  'edited',
  'overLimit',
  'noAnchor',
])
  test(`addressing reconciliation never merges ${change}`, () => {
    const isText = change === 'text' || change === 'replyTarget';
    const stored = isText ? text() : lidCopy(media('imageMessage'));
    const other = bareCopy(stored);
    if (change === 'otherPerson')
      other.key = { ...stored.key, participant: '222222222222222@lid', participantAlt: '628000000002@s.whatsapp.net' };
    if (['caption', 'mediaKey', 'fileSha256'].includes(change))
      other.message.imageMessage[change] = change === 'caption' ? 'other' : b64(9);
    if (change === 'text') other.message.conversation = 'other';
    if (change === 'replyTarget') other.contextInfo = { stanzaId: 'Q2' };
    if (change === 'edited') other.status = 'EDITED';
    const sources =
      change === 'overLimit'
        ? [stored, ...Array.from({ length: 4 }, () => bareCopy(stored))]
        : change === 'noAnchor'
          ? [
              { ...bareCopy(stored), messageTimestamp: 1 },
              { ...structuredClone(stored), messageTimestamp: 2 },
            ]
          : [other, stored];
    assert.throws(() => resolveInboundNativeBody(sources, stored), /InboundNativeSourceAmbiguous/);
  });

test('a group copy that names its sender is stored when every stored copy names nobody', () => {
  const stored = lidCopy(media('imageMessage'));
  assert.equal(isNativeRetransmission([bareCopy(stored)], stored), false);
  assert.equal(isNativeRetransmission([stored], bareCopy(stored)), true);
  assert.equal(
    isNativeRetransmission([stored], { ...stored, messageType: 'conversation', message: { conversation: '' } }),
    true,
  );
});

test('an album-child copy and the same photo stored plain resolve to one message; another photo refuses', async () => {
  const { resolveInboundNativeBody } = await import(
    '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-native-source'
  );
  const b64 = (byte: number) => Buffer.alloc(32, byte).toString('base64');
  const image = (byte: number) => ({
    mimetype: 'image/jpeg',
    mediaKey: b64(byte),
    fileSha256: b64(byte + 1),
    fileEncSha256: b64(byte + 2),
  });
  const key = { id: 'ALBUM1', remoteJid: '120363000000000077@g.us', fromMe: false };
  const child = {
    key: { ...key, participant: '62800000000002@s.whatsapp.net' },
    messageType: 'associatedChildMessage',
    message: { associatedChildMessage: { message: { imageMessage: image(5), messageContextInfo: {} } } },
    messageTimestamp: 1_700_000_000,
    pushName: 'Sender',
  };
  const plain = { key, messageType: 'imageMessage', message: { imageMessage: image(5) }, messageTimestamp: 1_700_000_000 };
  assert.equal(resolveInboundNativeBody([child, plain] as any, child as any).messageType, 'associatedChildMessage');
  const other = { ...plain, message: { imageMessage: image(9) } };
  assert.throws(() => resolveInboundNativeBody([child, other] as any, child as any), /InboundNativeSourceAmbiguous/);
});
