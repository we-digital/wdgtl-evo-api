import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import {
  UNAVAILABLE_ORIGINAL_EDIT_REASON,
  unavailableOriginalEditProof,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ignored-history-edit';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';

function fixture() {
  const target: any = {
    id: 'original',
    instanceId: 'synthetic-instance',
    messageType: 'imageMessage',
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

test('native unavailable-original evidence preserves explicit target-key discrepancy and exact hashes', () => {
  const f = fixture();
  const proof = unavailableOriginalEditProof(f.source, f.target, f.state, 1, 99);
  assert.equal(proof.kind, 'encrypted_edit_null_image_original');
  assert.equal(proof.targetDirectionDiscrepancy, 'target_key_differs_from_native_original');
  assert.equal(proof.destinationAbsent, true);
  assert.equal(JSON.parse(proof.sourceNativeJSON).message.secretEncryptedMessage.targetMessageKey.fromMe, true);
  assert.equal(JSON.parse(proof.targetNativeJSON).key.fromMe, false);
  for (const [raw, hash] of [
    [proof.sourceNativeJSON, proof.sourceNativeVersionSHA256],
    [proof.targetNativeJSON, proof.targetNativeVersionSHA256],
    [proof.orderingJSON, proof.orderingSHA256],
  ])
    assert.equal(createHash('sha256').update(raw).digest('hex'), hash);
  const image = unavailableOriginalEditProof(
    f.target,
    f.target,
    { sourceRows: [f.target], targetUpdates: [f.update], competitors: [] },
    1,
    99,
  );
  assert.equal(image.kind, 'null_image_original');
  assert.equal(image.sourceId, image.targetSourceId);
  assert.equal('destinationMessageId' in image, false);
});

test('available/ordinary/unknown/ambiguous/rotated native originals never enter unavailable disposition', () => {
  const f = fixture();
  const negatives: Array<() => void> = [
    () => {
      f.target.message = { imageMessage: { caption: 'available' } };
    },
    () => {
      f.target.messageType = 'conversation';
    },
    () => {
      f.target.status = 'DELIVERY_ACK';
    },
    () => {
      f.target.chatwootMessageId = 1;
    },
    () => {
      f.source.instanceId = 'foreign';
    },
    () => {
      f.source.key.fromMe = true;
    },
    () => {
      f.source.message.secretEncryptedMessage.targetMessageKey.id = 'foreign';
    },
    () => {
      f.source.message.secretEncryptedMessage.targetMessageKey.remoteJid = 'foreign@g.us';
    },
    () => {
      f.state.targetUpdates.push(f.update);
    },
    () => {
      f.state.competitors.push(f.source);
    },
    () => {
      f.state.sourceRows = [f.source, f.source];
    },
  ];
  for (const mutate of negatives) {
    const before = structuredClone(f);
    mutate();
    assert.throws(() => unavailableOriginalEditProof(f.source, f.target, f.state, 1, 99));
    Object.assign(f, before);
  }
});

test('whole mixed250 keeps ordinary existing sources and ACKs two typed unavailable originals without writes', async (t) => {
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
  const f = fixture();
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
    messageUpdate: { findMany: async () => [f.update] },
    media: { findFirst: async () => assert.fail('No media GET') },
  };
  const names = [
    'activateHistorySourceGuards',
    'reconcileOutboundHistoryBindings',
    'getVerifiedRecoverySourceIds',
    'importHistoryMessages',
    'reconcileProviderHistoryEdits',
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
    new Set(requested.filter((row) => row.messageType === 'conversation').map((row) => `WAID:${row.key.id}`));
  chatwootImport.importHistoryMessages = async () => assert.fail('No replacement/placeholder import');
  chatwootImport.reconcileProviderHistoryEdits = async (requested: any[]) => {
    assert.equal(requested.length, 0);
    return new Map();
  };
  postgresClient.getChatwootConnection = (() => ({
    query: async (sql: string) => {
      assert.equal(sql.trim().startsWith('SELECT'), true);
      captures++;
      return { rows: [] };
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
  assert.ok(captures >= 4);
  assert.equal(result.importedMessages, 0);
  assert.equal(result.outcomes.length, 250);
  assert.equal(result.outcomes.filter((o: any) => o.status === 'existing').length, 248);
  for (const outcome of result.outcomes.filter((o: any) => o.status === 'skipped')) {
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.recovery, 'unsupported');
    assert.equal(outcome.reason, UNAVAILABLE_ORIGINAL_EDIT_REASON);
    assert.equal(outcome.unavailableOriginalEdit.destinationAbsent, true);
  }
});

test('absent-target disposition refuses any destination and keeps available original refusal', async (t) => {
  const f = fixture();
  const original = postgresClient.getChatwootConnection;
  let queries = 0;
  t.after(() => {
    postgresClient.getChatwootConnection = original;
  });
  postgresClient.getChatwootConnection = (() => ({
    query: async (sql: string, values: unknown[]) => {
      assert.equal(sql, 'SELECT id FROM messages WHERE inbox_id = $1 AND source_id = ANY($2::text[])');
      assert.deepEqual(values, [99, ['WAID:original-key', 'original-key']]);
      queries++;
      return { rows: [{ id: 77 }] };
    },
  })) as any;
  await assert.rejects(
    chatwootImport.captureUnavailableOriginalEdit(f.source, f.target, f.state, 99, { accountId: '1' } as any),
    /has a destination/,
  );
  assert.equal(queries, 1);
  f.target.message = { imageMessage: { caption: 'available' } };
  await assert.rejects(
    chatwootImport.captureUnavailableOriginalEdit(f.source, f.target, f.state, 99, { accountId: '1' } as any),
    /native update provenance/,
  );
  assert.equal(queries, 1);
});
