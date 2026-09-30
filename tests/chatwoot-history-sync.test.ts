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
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
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

test('treats exact raw and canonical Chatwoot source ids as the same retained history message', async () => {
  const originalGetConnection = postgresClient.getChatwootConnection;
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  try {
    postgresClient.getChatwootConnection = (() => ({
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return {
          rows: [{ source_id: 'ABC' }, { source_id: 'WAID:DEF' }, { source_id: 'unrequested' }],
        };
      },
    })) as any;

    const existing = await chatwootImport.getExistingSourceIds(['ABC', 'WAID:DEF'], undefined, 42);

    assert.deepEqual(existing, new Set(['WAID:ABC', 'WAID:DEF']));
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].params, [['WAID:ABC', 'ABC', 'WAID:DEF', 'DEF'], 42]);
    assert.match(queries[0].sql, /source_id = ANY\(\$1\)/);
    assert.match(queries[0].sql, /inbox_id = \$2/);
  } finally {
    postgresClient.getChatwootConnection = originalGetConnection;
  }
});

test('fails closed when retained Chatwoot source ids cannot be read', async () => {
  const originalGetConnection = postgresClient.getChatwootConnection;

  try {
    postgresClient.getChatwootConnection = (() => ({
      query: async () => {
        throw new Error('destination unavailable');
      },
    })) as any;

    await assert.rejects(chatwootImport.getExistingSourceIds(['ABC'], undefined, 42), /destination unavailable/);
  } finally {
    postgresClient.getChatwootConnection = originalGetConnection;
  }
});

test('heals an authoritative outbound bridge under the serialized message lock', async () => {
  const originalGetConnection = postgresClient.getChatwootConnection;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const outbound = {
    ...message({ id: 'outbound-bridge', remoteJid: '123@g.us', fromMe: true }),
    chatwootMessageId: 123,
    chatwootInboxId: 7,
    chatwootConversationId: 9,
  } as Message;

  try {
    postgresClient.getChatwootConnection = (() => ({
      connect: async () => ({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (/^SELECT id, inbox_id/.test(sql.trim())) {
            return {
              rows: [{ id: 123, inbox_id: 7, conversation_id: 9, message_type: 1, source_id: null }],
            };
          }
          return { rows: [], rowCount: 1 };
        },
        release: () => undefined,
      }),
    })) as any;

    const reconciled = await chatwootImport.reconcileOutboundHistoryBindings([outbound], 7);

    assert.deepEqual(reconciled, new Set(['WAID:outbound-bridge']));
    assert.deepEqual(
      queries.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(' ')),
      ['BEGIN', 'LOCK TABLE messages', 'SELECT id, inbox_id,', 'UPDATE messages SET', 'COMMIT'],
    );
    assert.deepEqual(queries[3].params, ['WAID:outbound-bridge', 123]);
  } finally {
    postgresClient.getChatwootConnection = originalGetConnection;
  }
});

test('fails closed when an outbound bridge would duplicate a Chatwoot source id', async () => {
  const originalGetConnection = postgresClient.getChatwootConnection;
  const queries: string[] = [];
  const outbound = {
    ...message({ id: 'outbound-conflict', remoteJid: '123@g.us', fromMe: true }),
    chatwootMessageId: 123,
    chatwootInboxId: 7,
    chatwootConversationId: 9,
  } as Message;

  try {
    postgresClient.getChatwootConnection = (() => ({
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql.trim());
          if (/^SELECT id, inbox_id/.test(sql.trim())) {
            return {
              rows: [
                { id: 123, inbox_id: 7, conversation_id: 9, message_type: 1, source_id: null },
                { id: 124, inbox_id: 7, conversation_id: 9, message_type: 1, source_id: 'WAID:outbound-conflict' },
              ],
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      }),
    })) as any;

    await assert.rejects(
      chatwootImport.reconcileOutboundHistoryBindings([outbound], 7),
      /conflicts with an existing Chatwoot source id/,
    );
    assert.equal(queries.at(-1), 'ROLLBACK');
    assert.ok(!queries.some((sql) => sql.startsWith('UPDATE messages')));
  } finally {
    postgresClient.getChatwootConnection = originalGetConnection;
  }
});

for (const scenario of [
  { name: 'canonical existing source', sourceId: 'WAID:legacy-outbound', accepted: true },
  { name: 'raw existing source', sourceId: 'legacy-outbound', accepted: true },
  { name: 'unbound source', sourceId: null, accepted: false },
  { name: 'conflicting source', sourceId: 'WAID:another-source', accepted: false },
  { name: 'wrong inbox', sourceId: 'WAID:legacy-outbound', inboxId: 8, accepted: false },
  { name: 'wrong conversation', sourceId: 'WAID:legacy-outbound', conversationId: 10, accepted: false },
  { name: 'incoming bridge', sourceId: 'WAID:legacy-outbound', messageType: 0, accepted: false },
  { name: 'explicit conflicting binding', sourceId: 'WAID:legacy-outbound', bindingInboxId: 8, accepted: false },
]) {
  test(`legacy outbound inbox omission: ${scenario.name}`, async () => {
    const originalGetConnection = postgresClient.getChatwootConnection;
    const queries: string[] = [];
    const outbound = {
      ...message({ id: 'legacy-outbound', remoteJid: '123@g.us', fromMe: true }),
      chatwootMessageId: 123,
      chatwootInboxId: scenario.bindingInboxId ?? null,
      chatwootConversationId: 9,
    } as Message;
    try {
      postgresClient.getChatwootConnection = (() => ({
        connect: async () => ({
          query: async (sql: string) => {
            queries.push(sql.trim());
            return {
              rows: /^SELECT id, inbox_id/.test(sql.trim())
                ? [
                    {
                      id: 123,
                      inbox_id: scenario.inboxId ?? 7,
                      conversation_id: scenario.conversationId ?? 9,
                      message_type: scenario.messageType ?? 1,
                      source_id: scenario.sourceId,
                    },
                  ]
                : [],
              rowCount: 1,
            };
          },
          release: () => undefined,
        }),
      })) as any;
      if (scenario.accepted) {
        assert.deepEqual(
          await chatwootImport.reconcileOutboundHistoryBindings([outbound], 7),
          new Set(['WAID:legacy-outbound']),
        );
        assert.ok(queries.some((sql) => sql.includes('FOR UPDATE')));
        assert.equal(queries.at(-1), 'COMMIT');
        if (scenario.sourceId.startsWith('WAID:')) assert.ok(!queries.some((sql) => sql.startsWith('UPDATE')));
      } else {
        await assert.rejects(
          chatwootImport.reconcileOutboundHistoryBindings([outbound], 7),
          /Outbound history binding/,
        );
        assert.ok(!queries.some((sql) => sql.startsWith('UPDATE')));
        if (queries.length) assert.equal(queries.at(-1), 'ROLLBACK');
      }
    } finally {
      postgresClient.getChatwootConnection = originalGetConnection;
    }
  });
}

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
  assert.deepEqual(Array.from(chatwootImport.createMessagesMapByIdentity(selected).keys()), ['628333@s.whatsapp.net']);
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

  const result = await normalizeStoredHistoryMessages([lidMessage, unresolved, group], [storedMapping]);

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

test('rejects non-importable history content before Chatwoot identity creation', () => {
  const protocolOnly = {
    ...message({ id: 'protocol-only', remoteJid: '628111@s.whatsapp.net' }),
    messageType: 'protocolMessage',
    message: { protocolMessage: { type: 0 } },
  } as Message;
  const chatwootService = {
    getConversationMessage: () => '',
  } as any;

  const importable = chatwootImport.getImportableHistoryMessages(chatwootService, [protocolOnly]);

  assert.equal(importable.size, 0);
});

test('legacy full-history import creates FKs only for identities with importable content', async () => {
  const unsupportedOnlyInstance = { instanceName: 'unsupported-only-history' } as any;
  const mixedInstance = { instanceName: 'mixed-history' } as any;
  const unsupportedOnly = {
    ...message({ id: 'unsupported-only', remoteJid: '628111@s.whatsapp.net' }),
    messageType: 'protocolMessage',
    message: { protocolMessage: { type: 0 } },
  } as Message;
  const supported = message({ id: 'supported', remoteJid: '628222@s.whatsapp.net' });
  const unsupportedMixed = {
    ...message({ id: 'unsupported-mixed', remoteJid: '628333@s.whatsapp.net' }),
    messageType: 'protocolMessage',
    message: { protocolMessage: { type: 0 } },
  } as Message;
  const chatwootService = {
    getConversationMessage: (content: any) => content?.conversation || '',
  } as any;
  const inbox = { id: 7 } as any;
  const provider = { accountId: 1, token: 'token', ignoreJids: [], nameInbox: 'history' } as any;
  const originalGetConnection = postgresClient.getChatwootConnection;
  const originalGetChatwootUser = chatwootImport.getChatwootUser;
  const originalGetExistingSourceIds = chatwootImport.getExistingSourceIds;
  const originalSelectOrCreateFks = chatwootImport.selectOrCreateFksFromChatwoot;
  const originalImportHistoryContacts = chatwootImport.importHistoryContacts;
  const fkIdentityBatches: string[][] = [];
  const insertedParams: unknown[][] = [];
  const transactionQueries: string[] = [];

  try {
    postgresClient.getChatwootConnection = (() => ({
      connect: async () => ({
        query: async (sql: string, params: unknown[] = []) => {
          transactionQueries.push(sql.trim());
          if (/^INSERT INTO messages/.test(sql.trim())) {
            insertedParams.push(params);
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
        release: () => undefined,
      }),
    })) as any;
    chatwootImport.getChatwootUser = (async () => ({ user_type: 'User', user_id: 9 })) as any;
    chatwootImport.getExistingSourceIds = (async () => new Set<string>()) as any;
    chatwootImport.selectOrCreateFksFromChatwoot = (async (
      _provider: any,
      _inbox: any,
      _timestamps: any,
      messagesByIdentity: Map<string, Message[]>,
    ) => {
      const identities = Array.from(messagesByIdentity.keys());
      fkIdentityBatches.push(identities);
      return new Map(
        identities.map((identity) => [identity, { identity_key: identity, contact_id: '11', conversation_id: '22' }]),
      );
    }) as any;
    chatwootImport.importHistoryContacts = (async () => 0) as any;

    chatwootImport.addHistoryMessages(unsupportedOnlyInstance, [unsupportedOnly]);
    assert.equal(
      await chatwootImport.importHistoryMessages(unsupportedOnlyInstance, chatwootService, inbox, provider),
      0,
    );
    assert.deepEqual(fkIdentityBatches, []);
    assert.deepEqual(insertedParams, []);

    chatwootImport.addHistoryMessages(mixedInstance, [supported, unsupportedMixed]);
    assert.equal(await chatwootImport.importHistoryMessages(mixedInstance, chatwootService, inbox, provider), 1);
    assert.deepEqual(fkIdentityBatches, [['628222@s.whatsapp.net']]);
    assert.equal(insertedParams.length, 1);
    assert.ok(insertedParams[0].includes('WAID:supported'));
    assert.ok(!insertedParams[0].includes('WAID:unsupported-mixed'));
    assert.equal(transactionQueries[0], 'BEGIN');
    assert.equal(transactionQueries[1], 'LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE');
    assert.match(transactionQueries[2], /^INSERT INTO messages/);
    assert.equal(transactionQueries[3], 'COMMIT');
  } finally {
    postgresClient.getChatwootConnection = originalGetConnection;
    chatwootImport.getChatwootUser = originalGetChatwootUser;
    chatwootImport.getExistingSourceIds = originalGetExistingSourceIds;
    chatwootImport.selectOrCreateFksFromChatwoot = originalSelectOrCreateFks;
    chatwootImport.importHistoryContacts = originalImportHistoryContacts;
    chatwootImport.clearAll(unsupportedOnlyInstance);
    chatwootImport.clearAll(mixedInstance);
  }
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
    validate(
      { ...validRequest, messages: Array.from({ length: 501 }, () => validRequest.messages[0]) },
      chatwootHistorySyncBatchSchema,
    ).valid,
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
        expectedDirection: 'incoming',
        message: {
          id: 'database-id-1',
          key: { id: 'message-1', fromMe: false },
          messageTimestamp: 1_700_000_000,
        },
      },
    ],
  };

  assert.equal(validate(validRequest, chatwootHistoryRecoveryBatchSchema).valid, true);
  assert.equal(validate({ ...validRequest, recoveryMode: 'unknown' }, chatwootHistoryRecoveryBatchSchema).valid, false);
  assert.equal(
    validate({ ...validRequest, contractVersion: '2026-08-01' }, chatwootHistoryRecoveryBatchSchema).valid,
    false,
  );
  assert.equal(
    validate({ ...validRequest, expectedInboxId: undefined }, chatwootHistoryRecoveryBatchSchema).valid,
    false,
  );
  assert.equal(
    validate(
      { ...validRequest, messages: [{ ...validRequest.messages[0], expectedDirection: undefined }] },
      chatwootHistoryRecoveryBatchSchema,
    ).valid,
    false,
  );
  assert.equal(
    validate(
      { ...validRequest, messages: [{ ...validRequest.messages[0], expectedDirection: 'sideways' }] },
      chatwootHistoryRecoveryBatchSchema,
    ).valid,
    false,
  );
});

test('rejects authoritative direction drift before destination mutation and accepts both bound directions', async (t) => {
  const serverModulePath = require.resolve('../src/api/server.module.ts');
  const previousServerModule = require.cache[serverModulePath];
  require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  t.after(() => {
    if (previousServerModule) require.cache[serverModulePath] = previousServerModule;
    else delete require.cache[serverModulePath];
  });
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service = Object.create(ChatwootService.prototype) as any;
  service.isImportHistoryAvailable = () => true;
  service.getProvider = async () => ({ accountId: '1', importMessages: true });
  service.getStoredHistoryRecoveryInbox = async () => ({ id: 99 });

  const originalActivateGuards = chatwootImport.activateHistorySourceGuards;
  const originalReconcileOutbound = chatwootImport.reconcileOutboundHistoryBindings;
  const originalImportHistory = chatwootImport.importHistoryMessages;
  let guardCalls = 0;
  let reconcileCalls = 0;
  let importCalls = 0;

  chatwootImport.activateHistorySourceGuards = (async () => {
    guardCalls += 1;
    throw new Error('control_stop_after_direction_validation');
  }) as any;
  chatwootImport.reconcileOutboundHistoryBindings = (async () => {
    reconcileCalls += 1;
    return new Set<string>();
  }) as any;
  chatwootImport.importHistoryMessages = (async () => {
    importCalls += 1;
    return 0;
  }) as any;

  const recoveryRequest = (messages: Array<{ id: string; sourceId: string; fromMe: boolean }>) => ({
    contractVersion: '2026-08-28' as const,
    dryRun: false as const,
    scope: 'all' as const,
    unresolvedLidMode: 'provisional' as const,
    refreshLidMappings: false,
    recoveryMode: 'maximize' as const,
    expectedDestinationKey: 'chatwoot:1:99',
    expectedInboxId: 99,
    messages: messages.map((entry) => ({
      sourceId: entry.sourceId,
      expectedDirection: entry.fromMe ? ('outgoing' as const) : ('incoming' as const),
      message: { id: entry.id, key: { id: entry.sourceId.slice(5), fromMe: entry.fromMe } },
    })),
  });

  try {
    service.prismaRepository = {
      message: {
        findMany: async () => [{ id: 'database-in', key: { id: 'incoming-id', fromMe: true } }],
      },
    };
    await assert.rejects(
      service.syncStoredHistoryRecoveryBatch(
        { instanceName: 'cycle8-authoritative-drift' },
        recoveryRequest([{ id: 'database-in', sourceId: 'WAID:incoming-id', fromMe: false }]),
      ),
      (error: any) => {
        assert.deepEqual(error?.message, ['Cached history message direction changed in authoritative storage']);
        return true;
      },
    );
    assert.deepEqual({ guardCalls, reconcileCalls, importCalls }, { guardCalls: 0, reconcileCalls: 0, importCalls: 0 });

    service.prismaRepository.message.findMany = async () => [
      { id: 'database-in', key: { id: 'incoming-id', fromMe: false } },
      { id: 'database-out', key: { id: 'outgoing-id', fromMe: true } },
    ];
    await assert.rejects(
      service.syncStoredHistoryRecoveryBatch(
        { instanceName: 'cycle8-bidirectional-control' },
        recoveryRequest([
          { id: 'database-in', sourceId: 'WAID:incoming-id', fromMe: false },
          { id: 'database-out', sourceId: 'WAID:outgoing-id', fromMe: true },
        ]),
      ),
      /control_stop_after_direction_validation/,
    );
    assert.deepEqual({ guardCalls, reconcileCalls, importCalls }, { guardCalls: 1, reconcileCalls: 0, importCalls: 0 });
  } finally {
    chatwootImport.activateHistorySourceGuards = originalActivateGuards;
    chatwootImport.reconcileOutboundHistoryBindings = originalReconcileOutbound;
    chatwootImport.importHistoryMessages = originalImportHistory;
  }
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
