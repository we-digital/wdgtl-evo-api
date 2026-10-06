import assert from 'node:assert/strict';
import test from 'node:test';
import {
  albumImageCount,
  preserveAlbumContainers,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-album';
import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';

function fixture(count = 2) {
  const key = { id: 'album', remoteJid: 'synthetic@g.us', fromMe: false, participant: 'synthetic@s.whatsapp.net' };
  const parent = {
    id: 'parent',
    instanceId: 'owned',
    key,
    messageTimestamp: 1,
    status: 'READ',
    messageType: 'albumMessage',
    message: {
      albumMessage: { expectedImageCount: count, expectedVideoCount: 0 },
      messageContextInfo: { messageSecret: Buffer.alloc(32).toString('base64'), threadId: [] },
    },
  };
  const children = Array.from({ length: count }, (_, index) => ({
    id: 'child' + index,
    instanceId: 'owned',
    key: { ...key, id: 'image' + index },
    messageType: 'imageMessage',
    messageTimestamp: 2 + index,
    chatwootMessageId: 100 + index,
    chatwootInboxId: 114,
    chatwootConversationId: 500,
    message: {
      imageMessage: { mimetype: 'image/jpeg', fileLength: { low: 2048, high: 0, unsigned: true } },
      messageContextInfo: {
        messageAssociation: {
          associationType: 1,
          parentMessageKey: { id: 'album', remoteJid: key.remoteJid, fromMe: true },
        },
      },
    },
  }));
  const targets = children.map((child) => ({
    message: {
      id: child.chatwootMessageId,
      source_id: 'WAID:' + child.key.id,
      account_id: 1,
      inbox_id: 114,
      message_type: 0,
      private: false,
      content: 'existing caption/context unchanged',
      content_attributes: {
        we_digital_ingress: {
          version: 2,
          provider: 'evo_whatsapp',
          scope: 'group',
          direction: 'inbound',
          from_me: false,
        },
      },
    },
    conversation: { account_id: 1, inbox_id: 114, display_id: 500, contact_id: 8 },
    contact_inbox: { inbox_id: 114, contact_id: 8 },
    contact: { id: 8, account_id: 1 },
    binding: { provider: 'whatsapp', peer: key.remoteJid },
    media: [
      {
        attachment: { file_type: 0 },
        storage: { name: 'file' },
        blob: { content_type: 'image/jpeg', byte_size: 2048 },
      },
    ],
  }));
  const queries: string[] = [];
  const repository = {
    findMany: async (query: any) =>
      query.where.OR || query.where.message ? structuredClone(children) : [structuredClone(parent)],
  };
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: structuredClone(targets) };
      },
      release() {},
    }),
  };
  return { parent, children, targets, repository, pool, queries };
}
for (const count of [2, 7, 4])
  test(`preserves all ${count} scoped images and raw sender-relative bits without a write`, async () => {
    const f = fixture(count),
      before = structuredClone({ parent: f.parent, children: f.children, targets: f.targets });
    assert.equal(classifyCachedHistoryRecord(f.parent, false), 'album_container');
    const p = await preserveAlbumContainers([f.parent], f.repository, f.pool, 1, 114);
    await p.assertCurrent();
    assert.equal(p.proofs.get('WAID:album').children.length, count);
    assert.ok(p.proofs.get('WAID:album').children.every((child: any) => child.nestedFromMe === true));
    assert.deepEqual({ parent: f.parent, children: f.children, targets: f.targets }, before);
    assert.ok(f.queries.every((sql) => /^(SELECT|BEGIN READ ONLY|COMMIT|SET LOCAL)/.test(sql)));
  });

test('malformed and unknown album variants hard-stop before a destination query', () => {
  for (const change of [
    (f: any) => (f.parent.message.albumMessage.expectedVideoCount = 1),
    (f: any) => (f.parent.message.albumMessage.expectedImageCount = 14),
    (f: any) => (f.parent.message.extra = {}),
    (f: any) => (f.parent.message.messageContextInfo.messageSecret = 'bad'),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => albumImageCount(f.parent));
    assert.equal(f.queries.length, 0);
  }
});

test('missing/extra children, duplicate source and foreign direction or destination refuse before accounting', async () => {
  for (const change of [
    (f: any) => f.children.pop(),
    (f: any) => f.children.push(structuredClone(f.children[0])),
    (f: any) => (f.children[1].key.id = f.children[0].key.id),
    (f: any) => (f.children[0].key.fromMe = true),
    (f: any) => (f.children[0].instanceId = 'foreign'),
    (f: any) => (f.children[0].chatwootInboxId = 41),
    (f: any) => (f.targets[0].message.inbox_id = 41),
    (f: any) => (f.targets[0].binding.peer = 'foreign@g.us'),
    (f: any) => (f.targets[0].media[0].blob.byte_size = 2047),
    (f: any) => f.targets.push(structuredClone(f.targets[0])),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(preserveAlbumContainers([f.parent], f.repository, f.pool, 1, 114));
  }
});

test('native and current destination rotation refuse the final ACK proof', async () => {
  for (const change of [
    (f: any) => f.children[0].messageTimestamp++,
    (f: any) => (f.targets[0].message.content = 'later caption'),
  ]) {
    const f = fixture(),
      p = await preserveAlbumContainers([f.parent], f.repository, f.pool, 1, 114);
    change(f);
    await assert.rejects(p.assertCurrent());
  }
});

test('literal official batch returns only preserved-container accounting and missing dependency stops before source guard', async (t) => {
  const modulePath = require.resolve('../src/api/server.module.ts'),
    previousModule = require.cache[modulePath];
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
  const { chatwootImport } = await import('../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper');
  const { postgresClient } = await import('../src/api/integrations/chatbot/chatwoot/libs/postgres.client');
  const f = fixture();
  const service = Object.create(ChatwootService.prototype) as any;
  service.isImportHistoryAvailable = () => true;
  service.getProvider = async () => ({ accountId: '1', importMessages: true, enabled: true });
  service.getStoredHistoryRecoveryInbox = async () => ({ id: 114 });
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: false }) };
  service.prismaRepository = { message: f.repository, messageUpdate: { findMany: async () => [] } };
  const names = [
    'activateHistorySourceGuards',
    'getVerifiedRecoverySourceIds',
    'reconcileOutboundHistoryBindings',
    'reconcileProviderHistoryEdits',
    'importHistoryMessages',
  ] as const;
  const originals = names.map((name) => chatwootImport[name]),
    originalPool = postgresClient.getChatwootConnection;
  t.after(() => {
    names.forEach((name, i) => ((chatwootImport as any)[name] = originals[i]));
    postgresClient.getChatwootConnection = originalPool;
  });
  postgresClient.getChatwootConnection = (() => f.pool) as any;
  let guards = 0;
  chatwootImport.activateHistorySourceGuards = async (ids) => {
    guards++;
    assert.deepEqual(ids, []);
  };
  chatwootImport.getVerifiedRecoverySourceIds = async () => new Set();
  chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
  chatwootImport.reconcileProviderHistoryEdits = async (edits) => {
    assert.equal(edits.length, 0);
    return new Map();
  };
  chatwootImport.importHistoryMessages = async () => assert.fail('No parent or child import allowed');
  const request = {
    contractVersion: '2026-08-28',
    dryRun: false,
    scope: 'all',
    unresolvedLidMode: 'skip',
    recoveryMode: 'maximize',
    refreshLidMappings: false,
    expectedInboxId: 114,
    expectedDestinationKey: 'chatwoot:1:114',
    messages: [{ sourceId: 'WAID:album', expectedDirection: 'incoming', message: structuredClone(f.parent) }],
  };
  const result = await service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic-album' }, request);
  assert.equal(result.appliedMessages, 0);
  assert.equal(result.importedMessages, 0);
  assert.equal(result.outcomes[0].reason, 'preserved_unsupported_album_container');
  assert.equal(result.outcomes[0].albumPreservation.children.length, 2);
  assert.equal(guards, 1);
  f.children.pop();
  await assert.rejects(service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic-album' }, request));
  assert.equal(guards, 1);
});
