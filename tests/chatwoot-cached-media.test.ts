import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareCachedRecoveryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import axios from 'axios';

const bytes = Buffer.from('synthetic-owned-pdf');
function doc(type = 'documentMessage') {
  return {
    id: 'native-doc',
    instanceId: 'synthetic-instance',
    messageType: type,
    status: 'PENDING',
    messageTimestamp: 1700000000,
    key: { id: 'doc', fromMe: false, remoteJid: '628111111111@s.whatsapp.net' },
    message: {
      [type]: {
        fileName: 'synthetic.pdf',
        mimetype: 'application/pdf',
        fileLength: bytes.length,
        fileSha256: createHash('sha256').update(bytes).digest('base64'),
      },
    },
  } as any;
}
const media = {
  id: 'owned-media',
  messageId: 'native-doc',
  instanceId: 'synthetic-instance',
  type: 'document',
  mimetype: 'application/pdf',
  fileName: 'synthetic-instance/628111111111@s.whatsapp.net/document/123_synthetic.pdf',
} as any;

test('owned bytes preserve digest and all four supported incoming media types; foreign authority and corruption refuse', async () => {
  for (const type of ['document', 'image', 'audio', 'video']) {
    const d = doc(`${type}Message`);
    const m = { ...media, type, fileName: media.fileName.replace('/document/', `/${type}/`) };
    const prepared = await prepareCachedRecoveryMedia(
      [d],
      async () => m,
      async () => bytes,
    );
    assert.equal(prepared.get(d.id)?.bytes.equals(bytes), true);
  }
  for (const changed of [
    { ...media, instanceId: 'foreign' },
    { ...media, fileName: 'foreign/key' },
    { ...media, mimetype: 'text/plain' },
    null,
  ]) {
    await assert.rejects(
      prepareCachedRecoveryMedia(
        [doc()],
        async () => changed,
        async () => bytes,
      ),
    );
  }
  await assert.rejects(
    prepareCachedRecoveryMedia(
      [doc()],
      async () => media,
      async () => Buffer.from('corrupted'),
    ),
  );
  await assert.rejects(
    prepareCachedRecoveryMedia(
      [{ ...doc(), key: { ...doc().key, fromMe: null } }],
      async () => media,
      async () => bytes,
    ),
  );
});

test('literal whole250 service preflights before writes and uses silent original multipart with exact postimage', async (t) => {
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
  const provider = {
    accountId: '1',
    importMessages: true,
    enabled: true,
    token: 'synthetic',
    url: 'https://cw.synthetic',
  };
  const binding = {
    version: 1,
    provider: 'evo_whatsapp',
    inbox_id: 99,
    instance_id: 'synthetic-instance',
    instance_name: 'synthetic',
    receiver_fingerprint: 'a'.repeat(64),
  };
  service.isImportHistoryAvailable = () => true;
  service.getProvider = async () => provider;
  service.getStoredHistoryRecoveryInbox = async () => ({ id: 99 });
  service.buildEvoRouteBinding = () => binding;
  service.providerConversationRequest = async () => ({
    enabled: true,
    provider: 'whatsapp',
    whatsapp_history_import_contract_version: 1,
    binding,
  });
  service.configService = {
    get: () => ({
      PROVIDER_CONVERSATION_BINDINGS: true,
      NATIVE_BRIDGE_TOKEN: 'synthetic',
      TRUSTED_BASE_URL: 'https://cw.synthetic',
    }),
  };
  service.resolvePhoneJidForLid = async () => null;
  service.readCachedRecoveryObject = async () => bytes;
  service.getGroupIdentityNames = async () => new Map();
  service.getReplyToIds = async () => ({ in_reply_to_external_id: 'quoted' });
  service.ingressAttributes = async () => ({ synthetic_author: 'preserved' });
  service.getConversationMessage = () => 'synthetic-caption';
  service.waMonitor = { waInstances: {} };
  let rows = [
    ...Array.from({ length: 249 }, (_, i) => ({
      ...doc(),
      id: `db-${i}`,
      messageType: 'conversation',
      key: { ...doc().key, id: `key-${i}` },
      message: { conversation: 'synthetic' },
    })),
    doc(),
  ];
  let guards = 0,
    editCalls = 0,
    posts = 0,
    unknownWrite = false;
  service.prismaRepository = {
    message: {
      findMany: async () => rows,
      findUnique: async ({ where }: any) => rows.find((row) => row.id === where.id),
    },
    messageUpdate: { findMany: async () => [] },
    media: { findFirst: async () => media },
  };
  const methods = [
    'activateHistorySourceGuards',
    'reconcileOutboundHistoryBindings',
    'getVerifiedRecoverySourceIds',
    'reconcileProviderHistoryEdits',
    'importHistoryMessages',
    'selectOrCreateFksFromChatwoot',
  ] as const;
  const originals = methods.map((name) => chatwootImport[name]);
  const originalAxios = axios.request;
  const originalPool = postgresClient.getChatwootConnection;
  t.after(() => {
    methods.forEach((name, i) => {
      (chatwootImport as any)[name] = originals[i];
    });
    axios.request = originalAxios;
    postgresClient.getChatwootConnection = originalPool;
  });
  chatwootImport.activateHistorySourceGuards = async () => {
    guards++;
  };
  chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
  chatwootImport.getVerifiedRecoverySourceIds = async (requested: any[]) =>
    new Set(requested.filter((row) => row.messageType === 'conversation').map((row) => `WAID:${row.key.id}`));
  chatwootImport.reconcileProviderHistoryEdits = async () => {
    editCalls++;
    return new Map();
  };
  chatwootImport.importHistoryMessages = async () => assert.fail('No placeholder SQL import');
  chatwootImport.selectOrCreateFksFromChatwoot = async () =>
    new Map([[doc().key.remoteJid, { identity_key: doc().key.remoteJid, contact_id: '5', conversation_id: '123' }]]);
  // Original sendData duplicate check and literal postimage query remain exercised.
  postgresClient.getChatwootConnection = (() => ({
    query: async (sql: string) => ({
      rows: sql.includes('active_storage_blobs')
        ? [
            {
              id: 7,
              message_type: rows[249].key.fromMe ? 1 : 0,
              private: false,
              account_id: 1,
              conversation_account: 1,
              conversation_inbox: 99,
              byte_size: bytes.length,
              content_type: 'application/pdf',
              filename: 'synthetic.pdf',
              metadata: { whatsapp_history_sha256: createHash('sha256').update(bytes).digest('hex') },
              checksum: createHash('md5').update(bytes).digest('base64'),
              created_at: new Date(1700000000000),
              conversation_id: 123,
              display_id: 345,
              content: 'synthetic-caption',
              content_attributes: {
                in_reply_to_external_id: 'quoted',
                synthetic_author: 'preserved',
                provider_history_native: {
                  message_id: 'native-doc',
                  from_me: rows[249].key.fromMe,
                  remote_jid: doc().key.remoteJid,
                  participant: null,
                  participant_alt: null,
                  push_name: null,
                },
              },
            },
          ]
        : sql.includes('provider_conversation_bindings')
          ? [{ id: 123, display_id: 345 }]
          : [],
    }),
  })) as any;
  axios.request = (async (config: any) => {
    posts++;
    assert.equal(config.url.endsWith('/conversations/345/messages'), true);
    assert.equal(config.headers['X-Chatwoot-History-Import'], '1');
    assert.equal(config.headers['X-Chatwoot-History-Inbox-Id'], '99');
    assert.equal(config.maxRedirects, 0);
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      config.data.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
      config.data.on('error', reject);
      config.data.on('end', () => resolve(Buffer.concat(chunks).toString()));
      config.data.resume();
    });
    assert.equal(body.includes(bytes.toString()), true);
    for (const value of [
      'external_created_at',
      '1700000000',
      'provider_file_sha256',
      createHash('sha256').update(bytes).digest('hex'),
      'provider_file_bytes',
      'provider_media_type',
      'provider_receiver_fingerprint',
      'in_reply_to_external_id',
      'synthetic_author',
      'WAID:doc',
      'synthetic-caption',
    ])
      assert.equal(body.includes(value), true, value);
    if (unknownWrite) throw new Error('synthetic response lost');
    return { data: { id: 7 } };
  }) as any;
  const request = () => ({
    contractVersion: '2026-08-28',
    dryRun: false,
    scope: 'direct',
    unresolvedLidMode: 'skip',
    recoveryMode: 'standard',
    refreshLidMappings: false,
    expectedDestinationKey: 'chatwoot:1:99',
    expectedInboxId: 99,
    messages: rows.map((message) => ({
      message,
      sourceId: `WAID:${message.key.id}`,
      expectedDirection: message.key.fromMe ? 'outgoing' : 'incoming',
    })),
  });
  const result = await service.syncStoredHistoryRecoveryBatch(
    { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
    request(),
  );
  assert.equal(result.selectedMessages, 250);
  assert.equal(result.importedMessages, 1);
  assert.equal(posts, 1);
  assert.equal(result.outcomes.find((outcome: any) => outcome.sourceId === 'WAID:doc').status, 'imported');
  rows[249] = { ...doc(), key: { ...doc().key, fromMe: true } };
  const outgoing = await service.syncStoredHistoryRecoveryBatch(
    { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
    request(),
  );
  assert.equal(outgoing.importedMessages, 1);
  assert.equal(posts, 2);
  guards = 0;
  editCalls = 0;
  posts = 0;
  rows = [
    ...rows.slice(0, 248),
    doc(),
    { ...doc('stickerMessage'), id: 'unsupported', key: { ...doc().key, id: 'unsupported' } },
  ];
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request()),
    /cached_media_authority/,
  );
  assert.equal(guards + editCalls + posts, 0);
  rows = [...rows.slice(0, 248), { ...rows[0], id: 'replacement', key: { ...rows[0].key, id: 'replacement' } }, doc()];
  unknownWrite = true;
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request()),
    /write_outcome_unconfirmed/,
  );
  assert.equal(posts, 1);
});
