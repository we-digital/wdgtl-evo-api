import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeStoredHistoryMessages,
  toChatwootSourceId,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import { Message } from '@prisma/client';

const message = ({
  id,
  remoteJid,
  remoteJidAlt,
  fromMe = false,
  timestamp = 1_700_000_000,
}: {
  id: string;
  remoteJid: string;
  remoteJidAlt?: string;
  fromMe?: boolean;
  timestamp?: number;
}) =>
  ({
    id,
    key: { id, remoteJid, remoteJidAlt, fromMe },
    message: { conversation: id },
    messageTimestamp: timestamp,
  }) as Message;

test('normalizes Chatwoot source ids exactly once', () => {
  assert.equal(toChatwootSourceId('ABC'), 'WAID:ABC');
  assert.equal(toChatwootSourceId('WAID:ABC'), 'WAID:ABC');
});

test('reuses stored LID mappings and skips groups and unresolved LIDs', async () => {
  const storedMapping = message({
    id: 'mapping',
    remoteJid: '111@lid',
    remoteJidAlt: '628111@s.whatsapp.net',
  });
  const lidMessage = message({ id: 'lid-message', remoteJid: '111@lid' });
  const unresolved = message({ id: 'unresolved', remoteJid: '222@lid' });
  const group = message({ id: 'group', remoteJid: '123@g.us' });

  const result = await normalizeStoredHistoryMessages(
    [lidMessage, unresolved, group],
    [storedMapping],
  );

  assert.equal(result.messages.length, 1);
  assert.equal((result.messages[0].key as any).remoteJid, '628111@s.whatsapp.net');
  assert.equal(result.stats.groupMessages, 1);
  assert.equal(result.stats.unresolvedLidMessages, 1);
  assert.equal(result.stats.unresolvedLidChats, 1);
});

test('uses the live resolver once per unresolved LID', async () => {
  const first = message({ id: 'first', remoteJid: '333@lid' });
  const second = message({ id: 'second', remoteJid: '333@lid', fromMe: true });
  const calls: string[] = [];

  const result = await normalizeStoredHistoryMessages([first, second], [], async (lid) => {
    calls.push(lid);
    return '628333@s.whatsapp.net';
  });

  assert.deepEqual(calls, ['333@lid']);
  assert.equal(result.messages.length, 2);
  assert.equal(result.stats.unresolvedLidMessages, 0);
  assert.ok(result.messages.every((item) => (item.key as any).remoteJid === '628333@s.whatsapp.net'));
});
