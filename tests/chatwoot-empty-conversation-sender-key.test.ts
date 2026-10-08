import assert from 'node:assert/strict';
import test from 'node:test';

import { proto } from 'baileys';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';

const peer = 'synthetic@g.us';
const envelope = () => ({
  conversation: '',
  senderKeyDistributionMessage: { groupId: peer, axolotlSenderKeyDistributionMessage: 'AQID' },
});
const classify = (message: unknown, key: unknown = { remoteJid: peer }) =>
  classifyCachedHistoryRecord({ messageType: 'conversation', message, key }, false);

test('positive decoded sender-key envelope with an empty conversation is control in both directions', () => {
  for (const fromMe of [false, true]) {
    for (const context of [false, true]) {
      const message = { ...envelope(), ...(context ? { messageContextInfo: {} } : {}) };
      const before = JSON.stringify(message);
      assert.equal(classify(message, { remoteJid: peer, fromMe }), 'encryption_control');
      assert.equal(JSON.stringify(message), before);
    }
  }
});

test('sender-key sidecars never hide nonempty or whitespace conversation text', () => {
  for (const conversation of ['ordinary text', ' ', '\n', '🧾']) {
    assert.equal(classify({ ...envelope(), conversation }), 'ordinary');
  }
});

test('missing, malformed or foreign group evidence remains ordinary', () => {
  const sidecar = envelope().senderKeyDistributionMessage;
  for (const senderKeyDistributionMessage of [
    undefined,
    null,
    {},
    [],
    { ...sidecar, groupId: '' },
    { ...sidecar, groupId: 'synthetic@s.whatsapp.net' },
    { ...sidecar, axolotlSenderKeyDistributionMessage: '' },
    { ...sidecar, axolotlSenderKeyDistributionMessage: { 0: 1 } },
    { ...sidecar, unexpected: true },
  ]) {
    assert.equal(classify({ conversation: '', senderKeyDistributionMessage }), 'ordinary');
  }
  assert.equal(classify(envelope(), { remoteJid: 'another@g.us' }), 'ordinary');
  assert.equal(classify(envelope(), null), 'ordinary');
});

test('unknown keys and additional ordinary media are never classified as control', () => {
  for (const extra of [
    'imageMessage',
    'documentMessage',
    'audioMessage',
    'extendedTextMessage',
    'unknownData',
    'mediaUrl',
  ]) {
    const message = { ...envelope(), [extra]: extra === 'mediaUrl' ? 'synthetic' : { text: 'ordinary' } };
    if (extra === 'mediaUrl') assert.equal(classify(message), 'ordinary');
    else assert.throws(() => classify(message));
  }
});

test('legacy sender-key-only classifier and unavailable edit behavior are retained', () => {
  assert.equal(
    classifyCachedHistoryRecord(
      { messageType: 'unknown', message: { senderKeyDistributionMessage: envelope().senderKeyDistributionMessage } },
      false,
    ),
    'encryption_control',
  );
  assert.equal(
    classifyCachedHistoryRecord({ messageType: 'conversation', message: null }, true),
    'unavailable_text_edit',
  );
});

test('actual protobuf decoded empty conversation retains positive sender-key proof', () => {
  const message = proto.Message.decode(
    proto.Message.encode({
      conversation: '',
      senderKeyDistributionMessage: { groupId: peer, axolotlSenderKeyDistributionMessage: Buffer.from([1, 2, 3]) },
    }).finish(),
  ).toJSON();
  assert.deepEqual(message, envelope());
  assert.equal(classify(message), 'encryption_control');
  assert.equal(classifyCachedHistoryRecord({ messageType: 'conversation', message }, false), 'ordinary');
  assert.equal(
    classifyCachedHistoryRecord({ messageType: 'conversation', message, key: { remoteJid: peer } }, true),
    'ordinary',
  );
});
