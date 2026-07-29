import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dedupeHistoryMessagesBySourceId,
  normalizeStoredHistoryMessages,
  toCanonicalHistoryJid,
  toChatwootSourceId,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import { chatwootImport } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import { Message } from '@prisma/client';

const message = ({
  id,
  remoteJid,
  remoteJidAlt,
  fromMe = false,
  participant,
  participantAlt,
  pushName,
  timestamp = 1_700_000_000,
}: {
  id: string;
  remoteJid: string;
  remoteJidAlt?: string;
  fromMe?: boolean;
  participant?: string;
  participantAlt?: string;
  pushName?: string;
  timestamp?: number;
}) =>
  ({
    id,
    key: { id, remoteJid, remoteJidAlt, participant, participantAlt, fromMe },
    pushName,
    message: { conversation: id },
    messageTimestamp: timestamp,
  }) as Message;

test('normalizes Chatwoot source ids exactly once', () => {
  assert.equal(toChatwootSourceId('ABC'), 'WAID:ABC');
  assert.equal(toChatwootSourceId('WAID:ABC'), 'WAID:ABC');
});

test('deduplicates stored history rows by canonical Chatwoot source id', () => {
  const first = message({ id: 'duplicate', remoteJid: '628111@s.whatsapp.net' });
  const duplicate = message({ id: 'WAID:duplicate', remoteJid: '628222@s.whatsapp.net' });
  const unique = message({ id: 'unique', remoteJid: '628333@s.whatsapp.net' });

  const result = dedupeHistoryMessagesBySourceId([first, duplicate, unique]);

  assert.deepEqual(result.messages, [first, unique]);
  assert.equal(result.duplicateMessages, 1);
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

test('can include groups and provisional LIDs without inventing phone mappings', async () => {
  const group = message({
    id: 'group',
    remoteJid: '123-456@g.us',
    participant: '628123@s.whatsapp.net',
    pushName: 'Participant',
  });
  const unresolved = message({ id: 'unresolved', remoteJid: '222:7@lid', pushName: 'LID Contact' });

  const result = await normalizeStoredHistoryMessages([group, unresolved], [], undefined, {
    includeGroups: true,
    includeUnresolvedLids: true,
  });

  assert.equal(result.messages.length, 2);
  assert.equal(result.stats.groupMessages, 1);
  assert.equal(result.stats.provisionalLidMessages, 1);
  assert.equal((result.messages[1].key as any).remoteJid, '222@lid');
});

test('canonicalizes device-specific phone and LID identities', () => {
  assert.equal(toCanonicalHistoryJid('628123:7@s.whatsapp.net'), '628123@s.whatsapp.net');
  assert.equal(toCanonicalHistoryJid('222:7@lid'), '222@lid');
  assert.equal(toCanonicalHistoryJid('123-456@g.us'), '123-456@g.us');
});

test('attributes imported incoming group content to the stored participant', () => {
  const group = message({
    id: 'hello',
    remoteJid: '123-456@g.us',
    participant: '999@lid',
    participantAlt: '628123@s.whatsapp.net',
    pushName: 'Participant',
  });
  const chatwootService = {
    getConversationMessage: (content: any) => content.conversation,
  } as any;

  assert.equal(
    chatwootImport.getHistoryContentMessage(chatwootService, group as any),
    '**+628123 - Participant:**\n\nhello',
  );
});
