import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatwootInboxCacheKey,
  dedupeHistoryMessagesBySourceId,
  filterImportableHistoryMessages,
  historyRecoveryDestination,
  matchesHistoryRecoveryDestination,
  normalizeStoredHistoryMessages,
  prepareStoredHistoryRecoveryMessage,
  requiresFullHistorySync,
  resolveProviderClientContext,
  selectUniqueChatwootInbox,
  toCanonicalHistoryJid,
  toChatwootSourceId,
  uniqueHistoryRecoveryInboxId,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import {
  chatwootHistoryRecoveryBatchSchema,
  chatwootHistorySyncBatchSchema,
} from '@api/integrations/chatbot/chatwoot/validate/chatwoot.schema';
import { chatwootImport } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import { Message } from '@prisma/client';
import { validate } from 'jsonschema';

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

test('filters existing and unsupported history before any identity can be materialized', () => {
  const existing = message({ id: 'existing', remoteJid: '628111@s.whatsapp.net' });
  const unsupported = {
    ...message({ id: 'unsupported', remoteJid: '628222@s.whatsapp.net' }),
    message: { protocolMessage: { type: 0 } },
  } as Message;
  const importable = message({ id: 'importable', remoteJid: '628333@s.whatsapp.net' });
  const duplicate = message({ id: 'WAID:importable', remoteJid: '628444@s.whatsapp.net' });

  const selected = filterImportableHistoryMessages(
    [existing, unsupported, importable, duplicate],
    new Set(['WAID:existing']),
    (candidate) => ((candidate.message as any)?.conversation ? 'content' : ''),
  );

  assert.deepEqual(selected, [importable]);
  assert.deepEqual(Array.from(chatwootImport.createMessagesMapByIdentity(selected).keys()), [
    '628333@s.whatsapp.net',
  ]);
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

test('requests full history only for a new or changed authenticated source', () => {
  assert.equal(requiresFullHistorySync(null, '628111@s.whatsapp.net'), true);
  assert.equal(requiresFullHistorySync('628111@s.whatsapp.net', null), false);
  assert.equal(requiresFullHistorySync('628111@s.whatsapp.net', '628222@s.whatsapp.net'), true);
  assert.equal(requiresFullHistorySync('628111:7@s.whatsapp.net', '628111@s.whatsapp.net'), false);
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

test('accepts only the versioned bounded cached history batch contract', () => {
  const validRequest = {
    contractVersion: '2026-08-01',
    dryRun: false,
    scope: 'all',
    unresolvedLidMode: 'provisional',
    refreshLidMappings: false,
    messages: [
      {
        sourceId: 'WAID:message-1',
        message: { id: 'database-id-1', key: { id: 'message-1' }, messageTimestamp: 1_700_000_000 },
      },
    ],
  };

  assert.equal(validate(validRequest, chatwootHistorySyncBatchSchema).valid, true);
  assert.equal(validate({ ...validRequest, contractVersion: 'latest' }, chatwootHistorySyncBatchSchema).valid, false);
  assert.equal(validate({ ...validRequest, dryRun: true }, chatwootHistorySyncBatchSchema).valid, false);
  assert.equal(
    validate({ ...validRequest, messages: Array.from({ length: 501 }, () => validRequest.messages[0]) }, chatwootHistorySyncBatchSchema)
      .valid,
    false,
  );
});

test('renders recoverable WhatsApp history gaps without changing identity or timestamp', () => {
  const reaction = {
    ...message({ id: 'reaction', remoteJid: '628111@s.whatsapp.net', timestamp: 1_700_000_123 }),
    messageType: 'reactionMessage',
    message: { reactionMessage: { text: '👍', key: { id: 'target' } } },
  } as Message;
  const recovered = prepareStoredHistoryRecoveryMessage(reaction);

  assert.equal(recovered.recovery, 'converted');
  assert.equal((recovered.message.key as any).id, 'reaction');
  assert.equal(recovered.message.messageTimestamp, 1_700_000_123);
  assert.deepEqual(recovered.message.message, { conversation: '_WhatsApp reaction: 👍_' });
});

test('creates an explicit placeholder only for missing user-content payloads', () => {
  const missingImage = {
    ...message({ id: 'missing-image', remoteJid: '628111@s.whatsapp.net' }),
    messageType: 'imageMessage',
    message: null,
  } as unknown as Message;
  const protocol = {
    ...message({ id: 'protocol', remoteJid: '628111@s.whatsapp.net' }),
    messageType: 'protocolMessage',
    message: { protocolMessage: { type: 0 } },
  } as Message;

  assert.deepEqual(prepareStoredHistoryRecoveryMessage(missingImage).message.message, {
    conversation: '_<Unavailable WhatsApp image message>_',
  });
  assert.equal(prepareStoredHistoryRecoveryMessage(protocol).recovery, 'native');
});

test('accepts only the destination-aware recovery batch contract', () => {
  const validRequest = {
    contractVersion: '2026-08-28',
    dryRun: false,
    scope: 'all',
    unresolvedLidMode: 'provisional',
    refreshLidMappings: false,
    recoveryMode: 'maximize',
    expectedDestinationKey: 'chatwoot:1:99',
    expectedInboxId: 99,
    messages: [
      {
        sourceId: 'WAID:message-1',
        message: { id: 'database-id-1', key: { id: 'message-1' }, messageTimestamp: 1_700_000_000 },
      },
    ],
  };

  assert.equal(validate(validRequest, chatwootHistoryRecoveryBatchSchema).valid, true);
  assert.equal(
    validate({ ...validRequest, recoveryMode: 'unknown' }, chatwootHistoryRecoveryBatchSchema).valid,
    false,
  );
  assert.equal(
    validate({ ...validRequest, contractVersion: '2026-08-01' }, chatwootHistoryRecoveryBatchSchema).valid,
    false,
  );
  assert.equal(
    validate({ ...validRequest, expectedInboxId: undefined }, chatwootHistoryRecoveryBatchSchema).valid,
    false,
  );
});

test('pins recovery apply to the exact capability destination', () => {
  assert.deepEqual(historyRecoveryDestination('1', 99), {
    destinationKey: 'chatwoot:1:99',
    inboxId: 99,
  });
  assert.equal(matchesHistoryRecoveryDestination('chatwoot:1:99', 99, '1', 99), true);
  assert.equal(matchesHistoryRecoveryDestination('chatwoot:1:99', 99, '1', 100), false);
  assert.equal(matchesHistoryRecoveryDestination('chatwoot:1:99', 100, '1', 99), false);
});

test('selects an inbox only from the captured provider name', () => {
  const inboxes = [
    { id: 45, name: 'WA - Other instance' },
    { id: 99, name: 'WA - Gabby' },
  ];

  assert.deepEqual(selectUniqueChatwootInbox(inboxes, 'WA - Gabby'), {
    id: 99,
    name: 'WA - Gabby',
  });
  assert.equal(selectUniqueChatwootInbox(inboxes, 'WA - Missing'), null);
});

test('refuses ambiguous duplicate inbox names', () => {
  const inboxes = [
    { id: 45, name: 'WA - Gabby' },
    { id: 99, name: 'WA - Gabby' },
  ];

  assert.equal(selectUniqueChatwootInbox(inboxes, 'WA - Gabby'), null);
});

test('namespaces inbox cache entries by provider URL', () => {
  const provider = { accountId: 1, nameInbox: 'WA - Gabby' };
  const first = chatwootInboxCacheKey('instance', { ...provider, url: 'https://first.example/' });
  const second = chatwootInboxCacheKey('instance', { ...provider, url: 'https://second.example' });

  assert.notEqual(first, second);
  assert.equal(first, chatwootInboxCacheKey('instance', { ...provider, url: 'https://first.example' }));
});

test('keeps provider contexts isolated when concurrent loads interleave', async () => {
  let releaseFirst: () => void = () => {};
  const secondLoaded = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const createClient = (provider: { accountId: number }) => ({ accountId: provider.accountId });

  const first = resolveProviderClientContext(async () => {
    await secondLoaded;
    return { accountId: 11 };
  }, createClient);
  const second = resolveProviderClientContext(async () => {
    releaseFirst();
    return { accountId: 22 };
  }, createClient);

  const [firstContext, secondContext] = await Promise.all([first, second]);

  assert.ok(firstContext);
  assert.ok(secondContext);
  assert.equal(firstContext.provider.accountId, 11);
  assert.equal(firstContext.client.accountId, 11);
  assert.equal(secondContext.provider.accountId, 22);
  assert.equal(secondContext.client.accountId, 22);
});

test('accepts only one valid authoritative recovery inbox', () => {
  assert.equal(uniqueHistoryRecoveryInboxId([{ id: 99 }]), 99);
  assert.equal(uniqueHistoryRecoveryInboxId([{ id: '99' }]), 99);
  assert.equal(uniqueHistoryRecoveryInboxId([]), null);
  assert.equal(uniqueHistoryRecoveryInboxId([{ id: 45 }, { id: 99 }]), null);
  assert.equal(uniqueHistoryRecoveryInboxId([{ id: 'not-an-id' }]), null);
});
