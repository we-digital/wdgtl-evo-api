import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { preserveAlbumContainers } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-album';

function fixture() {
  const parent = {
    id: 'parent',
    instanceId: 'owned',
    key: { id: 'album', fromMe: false, remoteJid: 'synthetic@g.us', participant: 'synthetic@s.whatsapp.net' },
    messageType: 'albumMessage',
    messageTimestamp: 4,
    status: 'READ',
    message: { albumMessage: { expectedImageCount: 3, expectedVideoCount: 0 } },
  };
  const companion: any = {
    id: 'metadata',
    instanceId: 'owned',
    key: { id: 'album', fromMe: false, remoteJid: 'synthetic@g.us' },
    messageType: 'unknown',
    messageTimestamp: 1,
    status: 'READ',
    message: { messageContextInfo: { threadId: [], messageSecret: Buffer.alloc(32, 7).toString('base64') } },
  };
  const rows: any[] = [companion, parent];
  let queries = 0;
  const repository = {
    findMany: async (args: any) => {
      assert.deepEqual(args.where, { instanceId: 'owned', key: { path: ['id'], equals: 'album' } });
      assert.equal(args.take, 17);
      assert.deepEqual(args.orderBy, { id: 'asc' });
      queries++;
      return structuredClone(rows);
    },
  };
  const pool = {
    connect: async () => {
      throw new Error('Container-only disposition must not claim destination children');
    },
  };
  return { parent, companion, rows, repository, pool, queries: () => queries };
}

test('known same-key metadata companion preserves only raw container with declared counts, no complete-child claim', async () => {
  const f = fixture(),
    before = structuredClone(f.rows);
  const result = await preserveAlbumContainers([f.parent], f.repository, f.pool, 1, 108);
  await result.assertCurrent();
  const proof = result.proofs.get('WAID:album');
  assert.equal(proof.version, 2);
  assert.equal(proof.disposition, 'container_only');
  assert.equal(proof.expectedImages, 3);
  assert.equal(proof.childrenComplete, false);
  assert.equal(proof.childrenQueried, false);
  assert.equal(proof.children, undefined);
  assert.equal(proof.destinationSnapshotSHA256, undefined);
  assert.deepEqual(JSON.parse(proof.sourceNativeJSON), f.parent);
  assert.deepEqual(JSON.parse(proof.sameKeyNativeJSON), f.rows);
  assert.equal(proof.sourceNativeSHA256, createHash('sha256').update(proof.sourceNativeJSON).digest('hex'));
  assert.equal(proof.sameKeyNativeSHA256, createHash('sha256').update(proof.sameKeyNativeJSON).digest('hex'));
  assert.deepEqual(f.rows, before);
  assert.equal(f.queries(), 2);
});

test('visible or malformed competing rows, identity mismatch, later ordering and omitted selected version refuse', async () => {
  for (const change of [
    (f: any) => (f.companion.message.conversation = 'visible'),
    (f: any) => (f.companion.message.messageContextInfo.messageSecret = 'bad'),
    (f: any) => f.companion.message.messageContextInfo.threadId.push('unexpected'),
    (f: any) => (f.companion.key.fromMe = true),
    (f: any) => (f.companion.key.remoteJid = 'foreign@g.us'),
    (f: any) => (f.companion.key.participant = 'foreign@s.whatsapp.net'),
    (f: any) => (f.companion.instanceId = 'foreign'),
    (f: any) => (f.companion.messageTimestamp = 5),
    (f: any) => f.rows.push(structuredClone(f.companion)),
    (f: any) => (f.rows[1] = { ...f.parent, status: 'DELIVERED' }),
    (f: any) => f.rows.push(...Array.from({ length: 15 }, (_, i) => ({ ...f.companion, id: 'extra' + i }))),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(preserveAlbumContainers([f.parent], f.repository, f.pool, 1, 108));
  }
});

test('full metadata companion or selected parent rotation refuses final acknowledgment', async () => {
  for (const change of [
    (f: any) => (f.companion.status = 'DELIVERED'),
    (f: any) => (f.rows[1] = { ...f.parent, messageTimestamp: 5 }),
  ]) {
    const f = fixture();
    const result = await preserveAlbumContainers([f.parent], f.repository, f.pool, 1, 108);
    change(f);
    await assert.rejects(result.assertCurrent());
  }
});

test('literal whole250 retains existing ordinary rows and reports only truthful container-only gap', async (t) => {
  const modulePath = require.resolve('../src/api/server.module.ts'),
    previous = require.cache[modulePath];
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
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const { chatwootImport } = await import('../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper');
  const { postgresClient } = await import('../src/api/integrations/chatbot/chatwoot/libs/postgres.client');
  const f = fixture();
  const texts = Array.from({ length: 249 }, (_, i) => ({
    id: 'text' + i,
    instanceId: 'owned',
    key: { ...f.parent.key, id: 'text-key' + i },
    messageType: 'conversation',
    message: { conversation: 'existing synthetic text' },
    messageTimestamp: 4,
    status: 'READ',
  }));
  const selected = [f.parent, ...texts],
    before = structuredClone(selected);
  const service = Object.create(ChatwootService.prototype) as any;
  service.isImportHistoryAvailable = () => true;
  service.getProvider = async () => ({ accountId: '1', importMessages: true, enabled: true });
  service.getStoredHistoryRecoveryInbox = async () => ({ id: 108 });
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: false }) };
  service.prismaRepository = {
    message: {
      findMany: async (args: any) => (args.where.key ? f.repository.findMany(args) : structuredClone(selected)),
    },
    messageUpdate: { findMany: async () => [] },
  };
  const names = [
    'activateHistorySourceGuards',
    'getVerifiedRecoverySourceIds',
    'reconcileOutboundHistoryBindings',
    'reconcileProviderHistoryEdits',
    'importHistoryMessages',
  ] as const;
  const originalMethods = names.map((name) => chatwootImport[name]),
    originalPool = postgresClient.getChatwootConnection;
  t.after(() => {
    names.forEach((name, i) => ((chatwootImport as any)[name] = originalMethods[i]));
    postgresClient.getChatwootConnection = originalPool;
  });
  let guardCalls = 0;
  postgresClient.getChatwootConnection = (() => ({
    ...f.pool,
    query: async (sql: string) => {
      assert.ok(sql.includes("a.meta ? 'whatsapp_history_sha256'"));
      return { rows: [] };
    },
  })) as any;
  chatwootImport.getVerifiedRecoverySourceIds = async () => new Set(texts.map((m) => 'WAID:' + m.key.id));
  chatwootImport.activateHistorySourceGuards = async (ids) => {
    guardCalls++;
    assert.deepEqual(new Set(ids), new Set(texts.map((m) => 'WAID:' + m.key.id)));
  };
  chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
  chatwootImport.reconcileProviderHistoryEdits = async (edits) => {
    assert.equal(edits.length, 0);
    return new Map();
  };
  chatwootImport.importHistoryMessages = async () => assert.fail('No synthetic import or provider write allowed');
  const request = {
    contractVersion: '2026-08-28',
    dryRun: false,
    scope: 'all',
    unresolvedLidMode: 'skip',
    recoveryMode: 'maximize',
    refreshLidMappings: false,
    expectedInboxId: 108,
    expectedDestinationKey: 'chatwoot:1:108',
    messages: selected.map((message) => ({
      sourceId: 'WAID:' + message.key.id,
      expectedDirection: 'incoming',
      message: structuredClone(message),
    })),
  };
  const result = await service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic-album' }, request);
  assert.equal(result.outcomes.length, 250);
  const outcome = result.outcomes.find((o: any) => o.sourceId === 'WAID:album');
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.reason, 'preserved_unsupported_album_container');
  assert.equal(outcome.albumPreservation.version, 2);
  assert.equal(outcome.albumPreservation.childrenComplete, false);
  assert.equal(outcome.albumPreservation.children, undefined);
  assert.equal(result.importedMessages, 0);
  assert.equal(result.appliedMessages, 0);
  assert.equal(guardCalls, 1);
  assert.deepEqual(selected, before);
});
