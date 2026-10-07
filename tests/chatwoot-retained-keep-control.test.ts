import assert from 'node:assert/strict';
import test from 'node:test';

import { proto } from 'baileys';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';

const key = { id: 'synthetic-kept-original', remoteJid: '123456789@s.whatsapp.net', fromMe: false };
const record = (keep: unknown, extra = {}) => ({
  messageType: 'keepInChatMessage',
  message: { keepInChatMessage: keep, ...extra },
});

test('native protobuf keep and undo are bookkeeping controls without destination changes', () => {
  for (const keepType of [proto.KeepType.KEEP_FOR_ALL, proto.KeepType.UNDO_KEEP_FOR_ALL]) {
    const decoded = proto.Message.KeepInChatMessage.decode(
      proto.Message.KeepInChatMessage.encode({ key, keepType, timestampMs: 1790000000000 }).finish(),
    );
    assert.equal(classifyCachedHistoryRecord(record(decoded), false), 'metadata_control');
    for (const remoteJid of ['123456789@g.us', '123456789-1234@g.us', '123456789@lid']) {
      assert.equal(
        classifyCachedHistoryRecord(record({ key: { ...key, remoteJid }, keepType, timestampMs: 100 }), false),
        'metadata_control',
      );
    }
  }
});

test('keep control rejects unknown enum, missing identity, invalid timestamp and contradictory content', () => {
  const valid = { key, keepType: 1, timestampMs: { low: -41088549, high: 416, unsigned: false } };
  for (const invalid of [
    null,
    [],
    { ...valid, keepType: 0 },
    { ...valid, keepType: 3 },
    { ...valid, keepType: '1' },
    { ...valid, timestampMs: -1 },
    { ...valid, timestampMs: undefined },
    { ...valid, timestampMs: { low: 0, high: 2097152, unsigned: false } },
    { ...valid, key: { ...key, fromMe: 'false' } },
    { ...valid, key: { ...key, id: '' } },
    { ...valid, key: { ...key, remoteJid: '123456789@g.us ' } },
    { ...valid, unexpected: true },
  ]) {
    assert.throws(() => classifyCachedHistoryRecord(record(invalid), false));
  }
  assert.throws(() => classifyCachedHistoryRecord(record(valid, { conversation: 'ordinary content' }), false));
  assert.throws(() => classifyCachedHistoryRecord(record(valid, { messageContextInfo: [] }), false));
});
