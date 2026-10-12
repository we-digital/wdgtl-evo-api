import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync } from 'node:crypto';
import test from 'node:test';
import { proto } from 'baileys';
import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import {
  qualifySupersededHistoryEdit,
  SUPERSEDED_HISTORY_EDIT_REASON,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-superseded-history-edit';
function fixture(edit: any, metadata?: any, extraBody: any = {}) {
  const participant = '123456789@s.whatsapp.net';
  const key = { id: 'original', remoteJid: '123456@g.us', fromMe: true };
  const secret = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(12, 8);
  const plaintext = Buffer.from(
    proto.Message.encode(
      proto.Message.fromObject({
        protocolMessage: { type: 14, key, editedMessage: edit },
        ...(metadata === undefined ? {} : { messageContextInfo: metadata }),
        ...extraBody,
      }),
    ).finish(),
  );
  const derived = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      Buffer.alloc(0),
      Buffer.from('original' + participant + participant + 'Message Edit'),
      32,
    ),
  );
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const original: any = {
    id: 'db-original',
    instanceId: 'synthetic',
    key: { ...key, fromMe: false, participant },
    messageTimestamp: 100,
    messageType: 'conversation',
    message: { conversation: 'before', messageContextInfo: { messageSecret: secret.toString('base64') } },
    chatwootMessageId: 314,
    chatwootInboxId: 99,
    chatwootConversationId: 40,
  };
  const envelope: any = {
    id: 'db-edit',
    messageTimestamp: 110,
    instanceId: 'synthetic',
    key: { id: 'edit', remoteJid: key.remoteJid, fromMe: false, participant },
    messageType: 'secretEncryptedMessage',
    message: {
      secretEncryptedMessage: {
        secretEncType: 2,
        targetMessageKey: key,
        encIv: iv.toString('base64'),
        encPayload: ciphertext.toString('base64'),
      },
    },
  };
  return { envelope, original };
}

function history() {
  const { envelope: older, original } = fixture({ conversation: 'older payload' });
  const { envelope: newer } = fixture({ conversation: 'latest payload' });
  newer.id = 'db-newer';
  newer.key.id = 'newer';
  newer.messageTimestamp = 120;
  const olderState = { sourceRows: [older, original], targetUpdates: [], competitors: [newer] };
  const newerState = { sourceRows: [newer, original], targetUpdates: [], competitors: [] };
  return { older, original, newer, olderState, newerState };
}

test('authenticates both ordered envelopes and produces a newer-source preservation receipt without changing any source', () => {
  const h = history(),
    before = JSON.stringify(h),
    q = qualifySupersededHistoryEdit(h.older, h.original, h.olderState, h.newerState);
  assert.equal(q.audit.reason, SUPERSEDED_HISTORY_EDIT_REASON);
  assert.equal(q.audit.newerSourceId, 'WAID:newer');
  assert.equal((q.recovered.message as any).conversation, 'latest payload');
  assert.equal(q.recovered.messageTimestamp, h.original.messageTimestamp);
  assert.deepEqual(q.recovered.key, h.original.key);
  assert.equal(JSON.stringify(h), before);
});

for (const [name, mutate] of [
  ['duplicate provider source ID', (h: any) => (h.newer.key.id = h.older.key.id)],
  ['oversized newer dependency', (h: any) => (h.newer.message.messageContextInfo = { padding: 'x'.repeat(65536) })],
  ['unknown newer envelope sidecar', (h: any) => (h.newer.message.futureUnknown = 'unqualified')],
  ['equal timestamps', (h: any) => (h.newer.messageTimestamp = h.older.messageTimestamp)],
  ['multiple competitors', (h: any) => h.olderState.competitors.push({ ...h.newer, id: 'third' })],
  ['newer competitor still exists', (h: any) => h.newerState.competitors.push({ ...h.newer, id: 'third' })],
  ['native original edited', (h: any) => (h.original.status = 'EDITED')],
  ['native edit update', (h: any) => h.newerState.targetUpdates.push({ status: 'EDITED' })],
  [
    'source version rotated',
    (h: any) => (h.newerState.sourceRows = [{ ...h.newer, messageTimestamp: 121 }, h.original]),
  ],
  ['missing newer source', (h: any) => (h.newerState.sourceRows = [h.original])],
  ['wrong instance', (h: any) => (h.newer.instanceId = 'other')],
  ['wrong peer', (h: any) => (h.newer.key.remoteJid = '999999@g.us')],
  ['wrong direction', (h: any) => (h.newer.key.fromMe = true)],
  ['wrong author', (h: any) => (h.newer.key.participant = '999999@s.whatsapp.net')],
  ['wrong target', (h: any) => (h.newer.message.secretEncryptedMessage.targetMessageKey.id = 'different')],
  [
    'newer authentication failure',
    (h: any) => (h.newer.message.secretEncryptedMessage.encPayload = Buffer.alloc(32).toString('base64')),
  ],
  [
    'older authentication failure',
    (h: any) => (h.older.message.secretEncryptedMessage.encPayload = Buffer.alloc(32).toString('base64')),
  ],
  ['unsupported newer type', (h: any) => (h.newer.messageType = 'protocolMessage')],
] as const)
  test(`preservation refuses ${name}`, () => {
    const h = history();
    mutate(h);
    assert.throws(() => qualifySupersededHistoryEdit(h.older, h.original, h.olderState, h.newerState));
  });

function destination() {
  return {
    id: 314,
    message_type: 0,
    private: false,
    content: 'latest payload',
    content_attributes: { edited: true, edited_at: '2026-01-01T00:00:00Z' },
    display_id: 40,
    provider_peer: '123456@g.us',
    message_snapshot: { content: 'latest payload', sender_id: 17 },
    attachments: [{ attachment: { id: 18 }, blob: { key: 'original-owned-blob', byte_size: 123 } }],
  };
}

test('only exact authenticated latest destination may acknowledge the older source; all SQL is read-only', async (t) => {
  const prior = postgresClient.getChatwootConnection;
  t.after(() => {
    postgresClient.getChatwootConnection = prior;
  });
  const h = history(),
    q = qualifySupersededHistoryEdit(h.older, h.original, h.olderState, h.newerState),
    row = destination();
  const before = JSON.stringify({ h, row }),
    queries: string[] = [];
  postgresClient.getChatwootConnection = (() => ({
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [row] };
    },
  })) as any;
  const proof = await chatwootImport.captureSupersededHistoryEdit(
    h.older,
    h.original,
    99,
    { accountId: '1' } as any,
    q,
  );
  assert.equal(proof.newerSourceEdit.reason, SUPERSEDED_HISTORY_EDIT_REASON);
  assert.equal(proof.destinationMessageId, 314);
  assert.equal(proof.newerSourceEdit.newerNativeId, h.newer.id);
  assert.equal(queries.length, 3);
  assert(queries.every((sql) => /^SELECT/.test(sql)));
  assert.equal(JSON.stringify({ h, row }), before);
});

for (const [name, mutate] of [
  ['older destination payload', (r: any) => (r.content = 'older payload')],
  ['unmarked edit', (r: any) => (r.content_attributes.edited = false)],
  ['missing edit timestamp', (r: any) => delete r.content_attributes.edited_at],
  ['deleted destination', (r: any) => (r.content_attributes.deleted = true)],
  ['wrong direction', (r: any) => (r.message_type = 1)],
  ['wrong scoped peer', (r: any) => (r.provider_peer = '999999@g.us')],
  ['private destination', (r: any) => (r.private = true)],
  ['wrong native pointer owner', (r: any) => (r.id = 315)],
  ['missing original file', (r: any) => (r.attachments = [{ blob: null }])],
] as const)
  test(`destination preservation refuses ${name} without writes`, async (t) => {
    const prior = postgresClient.getChatwootConnection;
    t.after(() => {
      postgresClient.getChatwootConnection = prior;
    });
    const h = history(),
      q = qualifySupersededHistoryEdit(h.older, h.original, h.olderState, h.newerState),
      row = destination();
    mutate(row);
    postgresClient.getChatwootConnection = (() => ({
      query: async (sql: string) => {
        assert(/^SELECT/.test(sql));
        return { rows: [row] };
      },
    })) as any;
    await assert.rejects(
      chatwootImport.captureSupersededHistoryEdit(h.older, h.original, 99, { accountId: '1' } as any, q),
    );
  });

test('changed full destination snapshot during qualification refuses acknowledgment', async (t) => {
  const prior = postgresClient.getChatwootConnection;
  t.after(() => {
    postgresClient.getChatwootConnection = prior;
  });
  const h = history(),
    q = qualifySupersededHistoryEdit(h.older, h.original, h.olderState, h.newerState),
    row = destination();
  let reads = 0;
  postgresClient.getChatwootConnection = (() => ({
    query: async (sql: string) => {
      assert(/^SELECT/.test(sql));
      reads++;
      return { rows: [reads === 3 ? { ...row, message_snapshot: { ...row.message_snapshot, sender_id: 18 } } : row] };
    },
  })) as any;
  await assert.rejects(
    chatwootImport.captureSupersededHistoryEdit(h.older, h.original, 99, { accountId: '1' } as any, q),
    /rotated/,
  );
});

for (const mode of ['latest', 'native-rotated', 'destination-not-latest'] as const) {
  test(`actual stock consumer ${mode} never applies the old payload or sends to the provider`, async (t) => {
    const modulePath = require.resolve('../src/api/server.module.ts'),
      priorModule = require.cache[modulePath];
    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports: new Proxy({}, { get: () => ({}) }),
      children: [],
      paths: [],
    } as NodeModule;
    const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
    const names = [
      'getExistingSourceIds',
      'getVerifiedRecoverySourceIds',
      'activateHistorySourceGuards',
      'reconcileOutboundHistoryBindings',
      'importHistoryMessages',
      'selectOrCreateFksFromChatwoot',
    ] as const;
    const methods = names.map((n) => chatwootImport[n]),
      priorPool = postgresClient.getChatwootConnection;
    t.after(() => {
      names.forEach((n, i) => ((chatwootImport as any)[n] = methods[i]));
      postgresClient.getChatwootConnection = priorPool;
      if (priorModule) require.cache[modulePath] = priorModule;
      else delete require.cache[modulePath];
    });
    const h = history(),
      before = JSON.stringify(h),
      row = destination(),
      service: any = Object.create(ChatwootService.prototype);
    let nativeReads = 0,
      edits = 0,
      sends = 0;
    service.isImportHistoryAvailable = () => true;
    service.getProvider = async () => ({ accountId: '1', enabled: true, importMessages: true });
    service.getStoredHistoryRecoveryInbox = async () => ({ id: 99 });
    service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true, NATIVE_BRIDGE_TOKEN: 'synthetic' }) };
    service.resolvePhoneJidForLid = async () => null;
    service.getGroupIdentityNames = async () => new Map();
    service.waMonitor = { waInstances: {} };
    service.prismaRepository = {
      message: {
        findMany: async ({ where }: any) => {
          if (where.OR) {
            nativeReads++;
            return where.messageTimestamp.gte <= 110
              ? [mode === 'native-rotated' && nativeReads > 1 ? { ...h.newer, messageTimestamp: 121 } : h.newer]
              : [];
          }
          if (where.key) return [h.original];
          if (where.id?.in) return [h.older, h.original, h.newer].filter((x) => where.id.in.includes(x.id));
          return [h.older];
        },
        findUnique: async ({ where }: any) => [h.older, h.original, h.newer].find((x) => x.id === where.id),
      },
      messageUpdate: { findMany: async () => [] },
      media: { findFirst: async () => null },
    };
    service.assertTaggedHistoryMediaStored = async () => new Set();
    service.applyWhatsappProviderEdit = async () => {
      edits++;
      throw Error('unexpected edit write');
    };
    service.sendData = async () => {
      sends++;
      throw Error('unexpected provider send');
    };
    chatwootImport.getExistingSourceIds = async () => new Set();
    chatwootImport.getVerifiedRecoverySourceIds = async (messages: any[]) =>
      new Set(messages.filter((x) => x.id === h.original.id).map((x) => 'WAID:' + x.key.id));
    chatwootImport.activateHistorySourceGuards = async () => {};
    chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
    chatwootImport.importHistoryMessages = async (_i, _s, _ib, _p, data: any) => {
      assert.deepEqual(data.messages, []);
      return 0;
    };
    chatwootImport.selectOrCreateFksFromChatwoot = async () => new Map();
    if (mode === 'destination-not-latest') row.content = 'older payload';
    postgresClient.getChatwootConnection = (() => ({
      query: async (sql: string) => {
        assert(/^SELECT/.test(sql));
        return { rows: [row] };
      },
    })) as any;
    const request = {
      contractVersion: '2026-08-28',
      dryRun: false,
      scope: 'all',
      unresolvedLidMode: 'skip',
      recoveryMode: 'maximize',
      refreshLidMappings: false,
      expectedDestinationKey: 'chatwoot:1:99',
      expectedInboxId: 99,
      messages: [{ message: h.older, sourceId: 'WAID:edit', expectedDirection: 'incoming' }],
    };
    const result = service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request);
    if (mode === 'latest') {
      const done = await result;
      assert.equal(done.outcomes.length, 1);
      assert.equal(done.outcomes[0].status, 'skipped');
      assert.equal(done.outcomes[0].reason, SUPERSEDED_HISTORY_EDIT_REASON);
      assert.equal(done.outcomes[0].ignoredEditPreservation.newerSourceEdit.newerSourceId, 'WAID:newer');
      assert.equal(done.appliedMessages, 0);
    } else await assert.rejects(result);
    assert.equal(edits, 0);
    assert.equal(sends, 0);
    assert.equal(JSON.stringify(h), before);
  });
}
