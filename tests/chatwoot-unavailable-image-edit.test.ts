import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';

test('cached controls stay controls and empty images require retained edit evidence', () => {
  assert.equal(
    classifyCachedHistoryRecord(
      {
        messageType: 'reactionMessage',
        message: {
          reactionMessage: { text: '', key: { id: 'target', remoteJid: 'synthetic@g.us' } },
        },
      },
      false,
    ),
    'reaction_control',
  );
  assert.equal(
    classifyCachedHistoryRecord(
      {
        messageType: 'unknown',
        message: {
          messageContextInfo: {},
          senderKeyDistributionMessage: { groupId: 'synthetic@g.us', axolotlSenderKeyDistributionMessage: 'synthetic' },
        },
      },
      false,
    ),
    'encryption_control',
  );
  assert.equal(
    classifyCachedHistoryRecord({ messageType: 'imageMessage', message: {} }, true),
    'unavailable_image_edit',
  );
  assert.equal(
    classifyCachedHistoryRecord(
      {
        messageType: 'conversation',
        message: {
          conversation: 'synthetic',
          senderKeyDistributionMessage: {},
        },
      },
      false,
    ),
    'ordinary',
  );
  for (const record of [
    { messageType: 'imageMessage', message: {} },
    { messageType: 'unknown', message: { protocolMessage: {} } },
    { messageType: 'reactionMessage', message: { reactionMessage: {} } },
    { messageType: 'unknown', message: { senderKeyDistributionMessage: {} } },
    { messageType: 'conversation', message: { conversation: 'text', unknownData: {} } },
  ])
    assert.throws(() => classifyCachedHistoryRecord(record, false));
});

test('empty edited image proves one destination and leaves all message fields untouched in both directions', async () => {
  const originalPool = postgresClient.getChatwootConnection;
  try {
    for (const fromMe of [false, true]) {
      const queries: string[] = [];
      const target = { id: 314, message_type: fromMe ? 1 : 0, conversation_id: 40, private: false, has_image: true };
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: sql.includes('SELECT m.id') ? [target] : [] };
        },
        release() {},
      };
      postgresClient.getChatwootConnection = (() => ({ connect: async () => client })) as any;
      const outcome = await chatwootImport.reconcileProviderHistoryEdits(
        [
          {
            key: { id: 'synthetic-image', fromMe },
            messageType: 'imageMessage',
            message: {},
            chatwootMessageId: 314,
            chatwootInboxId: 99,
            chatwootConversationId: 40,
          } as any,
        ],
        99,
        { accountId: '1' } as any,
        {
          applyWhatsappProviderEdit: async () => assert.fail('Missing source must never clear caption or attachments'),
        } as any,
      );
      assert.equal(outcome.get('WAID:synthetic-image'), 'preserved_existing_source_payload_unavailable');
      assert.equal(queries.at(-1), 'COMMIT');
      assert.equal(
        queries.some((sql) => /^\s*(UPDATE|INSERT|DELETE)\b/.test(sql)),
        false,
      );
      assert.match(queries[1], /c.inbox_id = \$2/);
      assert.match(queries[1], /active_storage_blobs/);
    }
  } finally {
    postgresClient.getChatwootConnection = originalPool;
  }
});

test('missing/conflicting image, wrong direction or stale binding refuses ACK without writing', async () => {
  const originalPool = postgresClient.getChatwootConnection;
  const valid = { id: 314, message_type: 0, conversation_id: 40, private: false, has_image: true };
  try {
    for (const rows of [
      [],
      [valid, valid],
      [{ ...valid, message_type: 1 }],
      [{ ...valid, has_image: false }],
      [{ ...valid, private: true }],
      [{ ...valid, id: 315 }],
      [{ ...valid, conversation_id: 41 }],
    ]) {
      const queries: string[] = [];
      postgresClient.getChatwootConnection = (() => ({
        connect: async () => ({
          query: async (sql: string) => {
            queries.push(sql);
            return { rows: sql.includes('SELECT m.id') ? rows : [] };
          },
          release() {},
        }),
      })) as any;
      await assert.rejects(
        chatwootImport.reconcileProviderHistoryEdits(
          [
            {
              key: { id: 'synthetic-image', fromMe: false },
              messageType: 'imageMessage',
              message: {},
              chatwootMessageId: 314,
              chatwootInboxId: 99,
              chatwootConversationId: 40,
            } as any,
          ],
          99,
          { accountId: '1' } as any,
          {} as any,
        ),
        /unique matching destination image/,
      );
      assert.equal(queries.at(-1), 'ROLLBACK');
      assert.equal(
        queries.some((sql) => /^\s*(UPDATE|INSERT|DELETE)\b/.test(sql)),
        false,
      );
    }
  } finally {
    postgresClient.getChatwootConnection = originalPool;
  }
});

test('batch accounts controls and unavailable edit explicitly; repeat does not import and source drift stops before writes', async (t) => {
  const modulePath = require.resolve('../src/api/server.module.ts');
  const previousModule = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  t.after(() => {
    if (previousModule) require.cache[modulePath] = previousModule;
    else delete require.cache[modulePath];
  });
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service = Object.create(ChatwootService.prototype) as any;
  service.isImportHistoryAvailable = () => true;
  service.getProvider = async () => ({ accountId: '1', importMessages: true, enabled: true });
  service.getStoredHistoryRecoveryInbox = async () => ({ id: 99 });
  service.resolvePhoneJidForLid = async () => null;
  const messages = [
    { id: 'db-text', messageType: 'conversation', message: { conversation: 'synthetic' } },
    { id: 'db-image', messageType: 'imageMessage', message: {}, status: 'EDITED' },
    {
      id: 'db-reaction',
      status: 'EDITED',
      messageType: 'reactionMessage',
      message: {
        reactionMessage: {
          text: 'synthetic',
          key: { id: 'target', remoteJid: 'synthetic@g.us' },
        },
      },
    },
    {
      id: 'db-control',
      status: 'EDITED',
      messageType: 'unknown',
      message: {
        senderKeyDistributionMessage: {
          groupId: 'synthetic@g.us',
          axolotlSenderKeyDistributionMessage: 'synthetic',
        },
      },
    },
  ].map((message) => ({
    ...message,
    messageTimestamp: 1790774000,
    key: { id: message.id, fromMe: false, remoteJid: '6281111111111@s.whatsapp.net' },
  }));
  let authoritative = messages;
  service.prismaRepository = {
    message: { findMany: async () => authoritative },
    messageUpdate: { findMany: async () => [] },
  };
  const methods = [
    'activateHistorySourceGuards',
    'reconcileOutboundHistoryBindings',
    'getVerifiedRecoverySourceIds',
    'reconcileProviderHistoryEdits',
    'importHistoryMessages',
  ] as const;
  const originals = methods.map((method) => chatwootImport[method]);
  t.after(() => {
    methods.forEach((method, i) => {
      (chatwootImport as any)[method] = originals[i];
    });
  });
  let guardCalls = 0;
  chatwootImport.activateHistorySourceGuards = async () => {
    guardCalls++;
  };
  chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
  chatwootImport.getVerifiedRecoverySourceIds = async () => new Set(['WAID:db-text', 'WAID:db-image']);
  chatwootImport.reconcileProviderHistoryEdits = async (edits) => {
    assert.equal(
      edits.every((edit) => edit.id === 'db-image'),
      true,
    );
    return new Map(edits.length ? [['WAID:db-image', 'preserved_existing_source_payload_unavailable' as const]] : []);
  };
  chatwootImport.importHistoryMessages = async () => assert.fail('Existing messages/controls must not be imported');
  const request = {
    contractVersion: '2026-08-28',
    dryRun: false,
    scope: 'all',
    unresolvedLidMode: 'skip',
    refreshLidMappings: false,
    recoveryMode: 'maximize',
    expectedDestinationKey: 'chatwoot:1:99',
    expectedInboxId: 99,
    messages: messages.map((message) => ({ sourceId: `WAID:${message.id}`, expectedDirection: 'incoming', message })),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic-recovery' }, request);
    assert.deepEqual(
      { existing: result.existingMessages, skipped: result.skippedMessages, imported: result.importedMessages },
      { existing: 2, skipped: 2, imported: 0 },
    );
    assert.deepEqual(
      result.outcomes.map((outcome: any) => outcome.reason),
      [
        'already_in_destination',
        'preserved_existing_source_payload_unavailable',
        'known_reaction_control',
        'known_encryption_control',
      ],
    );
    assert.equal(result.placeholderMessages, 0);
  }
  const missing = { ...messages[0], id: 'db-new', key: { ...messages[0].key, id: 'db-new' } };
  authoritative = [...messages, missing];
  const missingRequest = {
    ...request,
    messages: authoritative.map((message) => ({
      sourceId: `WAID:${message.id}`,
      expectedDirection: 'incoming',
      message,
    })),
  };
  const present = new Set(['WAID:db-text', 'WAID:db-image']);
  let importCalls = 0;
  service.getGroupIdentityNames = async () => ({});
  service.getConversationMessage = (message: any) => message?.conversation || '';
  service.waMonitor = { waInstances: {} };
  chatwootImport.getVerifiedRecoverySourceIds = async (selected) =>
    new Set(selected.map((message: any) => `WAID:${message.key.id}`).filter((id) => present.has(id)));
  chatwootImport.importHistoryMessages = async (_instance, _service, _inbox, _provider, batch) => {
    assert.deepEqual(
      batch.messages.map((message) => message.id),
      ['db-new'],
    );
    importCalls++;
    present.add('WAID:db-new');
    return 1;
  };
  const first = await service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic-recovery' }, missingRequest);
  const repeat = await service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic-recovery' }, missingRequest);
  assert.equal(first.importedMessages, 1);
  assert.equal(repeat.importedMessages, 0);
  assert.equal(repeat.existingMessages, 3);
  assert.equal(importCalls, 1);

  authoritative = messages.map((message) =>
    message.id === 'db-image'
      ? {
          ...message,
          message: { imageMessage: { caption: 'newly available' } },
        }
      : message,
  );
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic-recovery' }, request),
    (error: any) => error.message?.[0]?.includes('source version changed'),
  );
  assert.equal(guardCalls, 4);
  authoritative = messages.map((message) =>
    message.id === 'db-control'
      ? {
          ...message,
          message: { unknownMessage: {} },
        }
      : message,
  );
  const unknownRequest = {
    ...request,
    messages: authoritative.map((message) => ({
      sourceId: `WAID:${message.id}`,
      expectedDirection: 'incoming',
      message,
    })),
  };
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic-recovery' }, unknownRequest),
    /unknown or contradictory/,
  );
  assert.equal(guardCalls, 4);
});

test('recovery verifies every destination alias and direction instead of counting existence', async () => {
  const previous = postgresClient.getChatwootConnection;
  const valid = {
    source_id: 'WAID:synthetic',
    account_id: 1,
    conversation_account_id: 1,
    conversation_inbox_id: 99,
    message_type: 0,
    private: false,
  };
  const messages = [{ key: { id: 'synthetic', fromMe: false } }] as any;
  try {
    let rows = [valid];
    postgresClient.getChatwootConnection = (() => ({ query: async () => ({ rows }) })) as any;
    assert.deepEqual(
      await chatwootImport.getVerifiedRecoverySourceIds(messages, 99, { accountId: '1' } as any),
      new Set(['WAID:synthetic']),
    );
    for (const invalid of [
      [valid, { ...valid, source_id: 'synthetic' }],
      [{ ...valid, message_type: 1 }],
      [{ ...valid, account_id: 2 }],
      [{ ...valid, conversation_account_id: 2 }],
      [{ ...valid, conversation_inbox_id: 100 }],
      [{ ...valid, private: true }],
    ]) {
      rows = invalid;
      await assert.rejects(
        chatwootImport.getVerifiedRecoverySourceIds(messages, 99, { accountId: '1' } as any),
        /ambiguous/,
      );
    }
    rows = [];
    assert.deepEqual(
      await chatwootImport.getVerifiedRecoverySourceIds(messages, 99, { accountId: '1' } as any),
      new Set(),
    );
  } finally {
    postgresClient.getChatwootConnection = previous;
  }
});

test('new nonempty edited media without checkable content cannot claim reconciliation', async () => {
  await assert.rejects(
    chatwootImport.reconcileProviderHistoryEdits(
      [
        {
          key: { id: 'synthetic-image', fromMe: false },
          messageType: 'imageMessage',
          message: { imageMessage: { mimetype: 'image/png' } },
        } as any,
      ],
      99,
      { accountId: '1' } as any,
      {} as any,
    ),
    /unavailable for reconciliation/,
  );
});
