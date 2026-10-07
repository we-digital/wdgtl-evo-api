import assert from 'node:assert/strict';
import test, { TestContext } from 'node:test';
import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { UNAVAILABLE_ORIGINAL_EDIT_REASON } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ignored-history-edit';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
function fixture(targetType = 'imageMessage') {
  const target: any = {
    id: 'original',
    instanceId: 'synthetic-instance',
    messageType: targetType,
    status: 'EDITED',
    message: null,
    key: { id: 'original-key', fromMe: false, remoteJid: '123@g.us' },
    messageTimestamp: 1700000000,
    chatwootMessageId: null,
    chatwootInboxId: null,
    chatwootConversationId: null,
  };
  const source: any = {
    ...target,
    id: 'envelope',
    messageType: 'secretEncryptedMessage',
    status: 'DELIVERY_ACK',
    key: { id: 'edit-key', fromMe: false, remoteJid: '123@g.us' },
    messageTimestamp: 1700000001,
    message: {
      secretEncryptedMessage: {
        secretEncType: 2,
        targetMessageKey: { id: 'original-key', fromMe: true, remoteJid: '123@g.us' },
        encIv: Buffer.alloc(12).toString('base64'),
        encPayload: Buffer.alloc(16).toString('base64'),
      },
    },
  };
  const update: any = { id: 'update', instanceId: target.instanceId, messageId: target.id, status: 'EDITED' };
  return { source, target, update, state: { sourceRows: [source, target], targetUpdates: [update], competitors: [] } };
}

async function assertMixedIgnoredNullBatch(t: TestContext) {
  const modulePath = require.resolve('../src/api/server.module.ts');
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  t.after(() => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Inert server module is installed before service load.
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const f = fixture('conversation');
  f.target.chatwootMessageId = 50;
  f.target.chatwootInboxId = null;
  f.target.chatwootConversationId = 8;
  f.source = {
    ...f.target,
    id: 'second-null',
    messageType: 'imageMessage',
    key: { ...f.target.key, id: 'second-null-key' },
  };
  const rows = [
    f.source,
    f.target,
    ...Array.from({ length: 248 }, (_, i) => ({
      ...f.target,
      id: `ordinary-${i}`,
      status: 'DELIVERY_ACK',
      messageType: 'conversation',
      key: { ...f.target.key, id: `ordinary-key-${i}` },
      message: { conversation: 'synthetic' },
      chatwootMessageId: null, chatwootInboxId: null, chatwootConversationId: null, chatwootContactInboxSourceId: null,
    })),
  ];
  const service = Object.create(ChatwootService.prototype) as any;
  const provider = {
    accountId: '1',
    importMessages: true,
    enabled: true,
    token: 'synthetic',
    url: 'https://cw.synthetic',
  };
  service.isImportHistoryAvailable = () => true;
  service.getProvider = async () => provider;
  service.getStoredHistoryRecoveryInbox = async () => ({ id: 99 });
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true, NATIVE_BRIDGE_TOKEN: 'synthetic' }) };
  service.resolvePhoneJidForLid = async () => null;
  service.getGroupIdentityNames = async () => new Map();
  service.waMonitor = { waInstances: {} };
  service.prismaRepository = {
    message: {
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id),
      findMany: async ({ where }: any) =>
        where.key
          ? [f.target]
          : where.id?.not
            ? []
            : where.id?.in
              ? rows.filter((r) => where.id.in.includes(r.id))
              : rows,
    },
    messageUpdate: {
      findMany: async ({ where }: any) => [
        { ...f.update, messageId: where.messageId },
        { ...f.update, id: 'second-update', messageId: where.messageId },
      ],
    },
    media: { findFirst: async () => assert.fail('No media GET') },
    $transaction: async (work: any) => work({
      $queryRaw: async (sql: any) => rows.filter((row) => row.key.id === sql.values[1]),
      message: { updateMany: async ({ where, data }: any) => {
        const selected = rows.filter((row) => where.id.in.includes(row.id));
        selected.forEach((row) => Object.assign(row, data));
        return { count: selected.length };
      } },
    }),
  };
  const names = [
    'activateHistorySourceGuards',
    'reconcileOutboundHistoryBindings',
    'getVerifiedRecoverySourceIds',
    'importHistoryMessages',
  ] as const;
  const original = names.map((name) => chatwootImport[name]);
  const oldPool = postgresClient.getChatwootConnection;
  t.after(() => {
    names.forEach((name, i) => {
      (chatwootImport as any)[name] = original[i];
    });
    postgresClient.getChatwootConnection = oldPool;
  });
  let guards = 0;
  let captures = 0;
  chatwootImport.activateHistorySourceGuards = async () => {
    guards++;
  };
  chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
  chatwootImport.getVerifiedRecoverySourceIds = async (requested: any[]) =>
    new Set(
      requested
        .filter((row) => row.messageType === 'conversation' && row.message !== null)
        .map((row) => `WAID:${row.key.id}`),
    );
  chatwootImport.importHistoryMessages = async () => assert.fail('No replacement/placeholder import');
  const alias = (values: any[]) => {
    const index = Number(String(values[2][0]).replace(/^WAID:/, '').split('-').pop());
    return { rows: Number.isInteger(index) && String(values[2][0]).includes('ordinary-key-') ? [{ id: 1000 + index }] : [] };
  };
  postgresClient.getChatwootConnection = (() => ({
    query: async (sql: string, values: any[]) => {
      assert.equal(sql.trim().startsWith('SELECT'), true);
      captures++;
      return sql.startsWith('SELECT id FROM messages') ? alias(values) : { rows: [] };
    },
    connect: async () => {
      let nativeIndex = -1;
      return {
        query: async (sql: string, values: any[]) => {
          captures++;
          assert.ok(['COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('BEGIN') || sql.startsWith('SELECT') || sql.startsWith('SET LOCAL'));
          if (sql.startsWith('SELECT conversation_id')) {
            nativeIndex = Number(values[0]) - 1000;
            return { rows: [{ conversation_id: 8, source_id: `WAID:ordinary-key-${nativeIndex}`, message_type: 0, private: false }] };
          }
          if (sql.startsWith('SELECT public.provider_message_conversation_route')) return { rows: [{ id: 8 }] };
          if (sql.startsWith('SELECT id FROM messages')) return alias(values);
          if (sql.startsWith('SELECT c.id')) return { rows: [{ id: 8, display_id: 8, inbox_id: 99, source_id: 'synthetic-ci' }] };
          if (sql.includes('SELECT b.peer')) return { rows: [{ peer: '123@g.us' }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  })) as any;
  const input = {
    contractVersion: '2026-08-28',
    dryRun: false,
    scope: 'all',
    unresolvedLidMode: 'skip',
    recoveryMode: 'maximize',
    refreshLidMappings: false,
    expectedInboxId: 99,
    expectedDestinationKey: 'chatwoot:1:99',
    messages: rows.map((message) => ({ message, sourceId: `WAID:${message.key.id}`, expectedDirection: 'incoming' })),
  };
  const result = await service.syncStoredHistoryRecoveryBatch(
    { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
    input,
  );
  assert.equal(guards, 1);
  assert.ok(captures >= 6);
  assert.equal(result.importedMessages, 0);
  assert.equal(result.nativeBindings.length, 248);
  assert.equal(result.nativeBindings.every((binding: any) => binding.status === 'bound'), true);
  assert.equal(rows.slice(2).every((row: any, index: number) => row.chatwootMessageId === 1000 + index && row.chatwootInboxId === 99), true);
  assert.equal(f.target.chatwootInboxId, null); // Ignored NULL edit is never presented as a bound destination.
  assert.equal(result.outcomes.length, 250);
  assert.equal(result.outcomes.filter((o: any) => o.status === 'existing').length, 248);
  for (const outcome of result.outcomes.filter((o: any) => o.status === 'skipped')) {
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.recovery, 'unsupported');
    assert.equal(outcome.reason, UNAVAILABLE_ORIGINAL_EDIT_REASON);
    assert.equal(outcome.unavailableOriginalEdit.version, 2);
    assert.equal(outcome.unavailableOriginalEdit.destinationState, 'unqualified');
    assert.equal(outcome.unavailableOriginalEdit.destinationAbsent, undefined);
    assert.equal(JSON.parse(outcome.unavailableOriginalEdit.orderingJSON).targetUpdates.length, 2);
  }
}

test('whole mixed250 ignores two known NULL edits with stale pointers while preserving248 ordinary sources', async (t) => {
  await assertMixedIgnoredNullBatch(t);
});
