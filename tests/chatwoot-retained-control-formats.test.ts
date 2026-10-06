import assert from 'node:assert/strict';
import test from 'node:test';

import { proto } from 'baileys';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';

const key = { id: 'synthetic-original', remoteJid: 'synthetic@g.us', fromMe: false };
const record = (reactionMessage: unknown, extra = {}) => ({
  messageType: 'reactionMessage',
  message: { reactionMessage, ...extra },
});

test('retained reaction removals accept the native protobuf nullable and missing text forms', () => {
  const decoded = proto.Message.ReactionMessage.decode(proto.Message.ReactionMessage.encode({ key }).finish());
  assert.equal(decoded.text, null);
  for (const reaction of [decoded, { key }, { key, text: null }, { key, text: '' }, { key, text: 'synthetic' }]) {
    assert.equal(classifyCachedHistoryRecord(record(reaction), false), 'reaction_control');
  }
});

test('reaction removal typing keeps malformed target and contradictory payload refusal', () => {
  for (const reaction of [
    null,
    [],
    { key, text: 1 },
    { key, text: false },
    { key, text: {} },
    { text: null },
    { key: { ...key, id: '' }, text: null },
    { key: { id: key.id }, text: null },
  ]) {
    assert.throws(() => classifyCachedHistoryRecord(record(reaction), false), /unclassifiable/);
  }
  assert.throws(
    () => classifyCachedHistoryRecord(record({ key, text: null }, { conversation: 'synthetic' }), false),
    /unknown or contradictory/,
  );
});

test('native sidecars do not turn known controls into contradictory visible bodies', () => {
  const sidecar = { groupId: 'synthetic@g.us', axolotlSenderKeyDistributionMessage: 'synthetic' };
  const pin = { key, type: 1 };
  const secret = { secretEncType: 2, targetMessageKey: key, encIv: 'synthetic', encPayload: 'synthetic' };
  for (const [messageType, primary, category] of [
    ['pinInChatMessage', pin, 'pin_control'],
    ['secretEncryptedMessage', secret, 'encrypted_edit'],
    ['albumMessage', { expectedImageCount: 2, expectedVideoCount: 0 }, 'album_container'],
  ] as const) {
    const message = { [messageType]: primary, senderKeyDistributionMessage: sidecar };
    assert.equal(classifyCachedHistoryRecord({ messageType, message }, false), category);
    assert.throws(() =>
      classifyCachedHistoryRecord({ messageType, message: { ...message, conversation: 'foreign' } }, false),
    );
    assert.throws(() =>
      classifyCachedHistoryRecord(
        { messageType, message: { ...message, senderKeyDistributionMessage: { ...sidecar, unexpected: true } } },
        false,
      ),
    );
  }
});

test('known native metadata controls retain only their exact protocol shape', () => {
  const context = { threadId: [], messageSecret: Buffer.alloc(32, 1).toString('base64') };
  const long = { low: 100, high: 0, unsigned: false };
  const notice = {
    messageHistoryMetadata: {
      messageCount: long,
      oldestMessageTimestamp: long,
      historyReceivers: ['synthetic@s.whatsapp.net'],
    },
  };
  const noticeRecord = {
    messageType: 'unknown',
    message: { messageContextInfo: context, messageHistoryNotice: notice },
  };
  assert.equal(classifyCachedHistoryRecord(noticeRecord, false), 'metadata_control');
  for (const low of [-2147483649, 2147483648])
    assert.throws(() =>
      classifyCachedHistoryRecord(
        {
          ...noticeRecord,
          message: {
            ...noticeRecord.message,
            messageHistoryNotice: {
              messageHistoryMetadata: { ...notice.messageHistoryMetadata, messageCount: { ...long, low } },
            },
          },
        },
        false,
      ),
    );

  const limitRecord = {
    messageType: 'unknown',
    message: {
      messageContextInfo: {
        ...context,
        limitSharingV2: { trigger: 1, initiatedByMe: false, sharingLimited: true, limitSharingSettingTimestamp: long },
      },
    },
  };
  assert.equal(classifyCachedHistoryRecord(limitRecord, false), 'metadata_control');
  assert.equal(
    classifyCachedHistoryRecord(
      { messageType: 'placeholderMessage', message: { placeholderMessage: { type: 0 } } },
      false,
    ),
    'metadata_control',
  );
  for (const invalid of [
    { ...noticeRecord, message: { ...noticeRecord.message, conversation: 'visible' } },
    { ...noticeRecord, message: { ...noticeRecord.message, messageHistoryNotice: { ...notice, extra: true } } },
    { messageType: 'unknown', message: { messageContextInfo: { threadId: [] } } },
    { messageType: 'placeholderMessage', message: { placeholderMessage: { type: 1 } } },
    { messageType: 'unknown', message: { messageContextInfo: { ...context, limitSharingV2: { trigger: 99 } } } },
  ])
    assert.throws(() => classifyCachedHistoryRecord(invalid, false));
});

test('native declared-type conflicts and unavailable audio are preservation categories only for edits', () => {
  const conflict = {
    messageType: 'conversation',
    message: { extendedTextMessage: { text: 'retained conflicting text' } },
  };
  assert.equal(classifyCachedHistoryRecord(conflict, true), 'conflicting_text_edit');
  assert.throws(() => classifyCachedHistoryRecord(conflict, false));
  assert.throws(() =>
    classifyCachedHistoryRecord({ ...conflict, message: { ...conflict.message, conversation: 'extra' } }, true),
  );
  for (const message of [null, {}]) {
    assert.equal(classifyCachedHistoryRecord({ messageType: 'audioMessage', message }, true), 'unavailable_audio_edit');
    assert.throws(() => classifyCachedHistoryRecord({ messageType: 'audioMessage', message }, false));
  }
});

test('album native device, limit-sharing and quoted-reply sidecars retain dependency classification', () => {
  const secret = Buffer.alloc(32, 2).toString('base64');
  const hash = Buffer.alloc(10, 3).toString('base64');
  const unsigned = { low: 1700000000, high: 0, unsigned: true };
  const sidecar = { groupId: 'synthetic@g.us', axolotlSenderKeyDistributionMessage: 'synthetic' };
  const device = {
    senderKeyHash: hash,
    senderTimestamp: unsigned,
    recipientKeyHash: hash,
    recipientTimestamp: unsigned,
    senderKeyIndexes: [],
    recipientKeyIndexes: [],
  };
  const contexts = [
    { messageSecret: secret, threadId: [], deviceListMetadataVersion: 2, deviceListMetadata: device },
    {
      messageSecret: secret,
      threadId: [],
      limitSharingV2: {
        trigger: 1,
        initiatedByMe: false,
        sharingLimited: true,
        limitSharingSettingTimestamp: { low: -100, high: 400, unsigned: false },
      },
    },
  ];
  for (const context of contexts) {
    const record = {
      messageType: 'albumMessage',
      message: {
        senderKeyDistributionMessage: sidecar,
        messageContextInfo: context,
        albumMessage: {
          expectedImageCount: 3,
          expectedVideoCount: 0,
          contextInfo: {
            stanzaId: 'synthetic-quote',
            participant: 'synthetic@s.whatsapp.net',
            quotedType: 0,
            quotedMessage: { extendedTextMessage: { text: 'retained quote' } },
          },
        },
      },
    };
    const before = JSON.stringify(record);
    assert.equal(classifyCachedHistoryRecord(record, false), 'album_container');
    assert.equal(JSON.stringify(record), before);
    assert.throws(() =>
      classifyCachedHistoryRecord(
        {
          ...record,
          message: {
            ...record.message,
            albumMessage: {
              ...record.message.albumMessage,
              contextInfo: { ...record.message.albumMessage.contextInfo, quotedType: 4 },
            },
          },
        },
        false,
      ),
    );
  }
  const invalid = {
    messageType: 'albumMessage',
    message: {
      albumMessage: { expectedImageCount: 3, expectedVideoCount: 0 },
      messageContextInfo: { ...contexts[0], deviceListMetadataVersion: 3 },
    },
  };
  assert.throws(() => classifyCachedHistoryRecord(invalid, false));
});
