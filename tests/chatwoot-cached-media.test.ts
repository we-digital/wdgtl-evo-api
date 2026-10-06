import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import axios from 'axios';
import pg from 'pg';

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { prepareCachedRecoveryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import { retainedTemplate } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';

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
  type: 'documentMessage',
  mimetype: 'application/pdf',
  fileName: 'synthetic-instance/628111111111@s.whatsapp.net/documentMessage/1700000000000_synthetic.pdf',
} as any;

test('owned bytes preserve digest and all four supported incoming media types; foreign authority and corruption refuse', async () => {
  for (const type of ['document', 'image', 'audio', 'video']) {
    const d = doc(`${type}Message`);
    const m = {
      ...media,
      type: `${type}Message`,
      fileName: media.fileName.replace('/documentMessage/', `/${type}Message/`),
    };
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load only after the inert server fixture is installed.
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
  let stored = false;
  let wireType = 'document';
  let currentMedia = media;
  let expectedContent = 'synthetic-caption';
  let corruptStored = false;
  let persistedEpoch = 1700000000.321;
  let proofs = 0;
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
    media: { findFirst: async () => currentMedia },
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
    new Set(
      requested
        .filter((row) => row.messageType === 'conversation' || (stored && row.id === 'native-doc'))
        .map((row) => `WAID:${row.key.id}`),
    );
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
      rows:
        sql.includes('a.meta ?') && !stored
          ? []
          : sql.includes('active_storage_blobs')
            ? [
                {
                  id: 7,
                  attachment_id: 8,
                  source_id: 'WAID:doc',
                  peer: doc().key.remoteJid,
                  file_type: wireType === 'video' ? 2 : 3,
                  message_type: rows[249].key.fromMe ? 1 : 0,
                  private: false,
                  account_id: 1,
                  conversation_account: 1,
                  conversation_inbox: 99,
                  byte_size: bytes.length,
                  content_type: currentMedia.mimetype,
                  filename: 'synthetic.pdf',
                  attachment_meta: {
                    whatsapp_history_media_type: wireType,
                    whatsapp_history_sha256: createHash('sha256').update(bytes).digest('hex'),
                  },
                  checksum: createHash('md5').update(bytes).digest('base64'),
                  created_at: pg.types.getTypeParser(1114)('2023-11-14 22:13:20'),
                  created_at_epoch: persistedEpoch,
                  conversation_id: 123,
                  display_id: 345,
                  content: expectedContent,
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
                      ...(['associatedChildMessage', 'templateMessage'].includes(rows[249].messageType)
                        ? {
                            source: {
                              message_type: rows[249].messageType,
                              sha256: createHash('sha256').update(JSON.stringify(rows[249])).digest('hex'),
                            },
                          }
                        : {}),
                      ...(rows[249].message.templateMessage
                        ? { template: retainedTemplate(rows[249].message).metadata }
                        : {}),
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
    if (config.method === 'GET') {
      proofs++;
      assert.equal(config.url.endsWith('/inboxes/99/conversations/345/messages/7'), true);
      assert.equal(config.params.provider_receiver_fingerprint.length, 64);
      assert.equal(config.params.history_media_proof, '1');
      if (corruptStored) throw new Error('synthetic stored object absent/corrupt');
      return {
        data: {
          whatsapp_history_media_proof: {
            verified: true,
            message_id: 7,
            source_id: 'WAID:doc',
            attachment_id: 8,
            media_type: wireType,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            byte_size: bytes.length,
          },
        },
      };
    }
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
      expectedContent,
    ])
      assert.equal(body.includes(value), true, value);
    if (unknownWrite) throw new Error('synthetic response lost');
    stored = true;
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
  assert.equal(proofs, 2);
  for (const invalidEpoch of [1700000001.321, Number.NaN]) {
    persistedEpoch = invalidEpoch;
    await assert.rejects(
      service.verifyRecoveryMediaDestination(
        rows[249],
        provider,
        99,
        {
          filename: 'synthetic.pdf',
          mimetype: 'application/pdf',
          size: bytes.length,
          digest: createHash('sha256').update(bytes).digest(),
        },
        bytes,
        { conversationId: 123, displayId: 345, content: 'synthetic-caption', attributes: {} },
      ),
      /cached_media_import_postimage_unconfirmed/,
    );
  }
  persistedEpoch = 1700000000.321;
  const retained = await service.syncStoredHistoryRecoveryBatch(
    { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
    request(),
  );
  assert.equal(retained.importedMessages, 0);
  assert.equal(posts, 1);
  corruptStored = true;
  guards = 0;
  editCalls = 0;
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic', instanceId: 'synthetic-instance' }, request()),
    /stored_bytes_unconfirmed/,
  );
  assert.equal(guards + editCalls, 0);
  assert.equal(posts, 1);
  corruptStored = false;
  stored = false;
  rows[249] = { ...doc(), key: { ...doc().key, fromMe: true } };
  const outgoing = await service.syncStoredHistoryRecoveryBatch(
    { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
    request(),
  );
  assert.equal(outgoing.importedMessages, 1);
  assert.equal(posts, 2);
  for (const wrapper of ['associatedChildMessage', 'templateMessage']) {
    stored = false;
    wireType = 'video';
    const video = { ...doc().message.documentMessage, mimetype: 'video/mp4', caption: 'synthetic-caption' };
    currentMedia = {
      ...media,
      type: 'videoMessage',
      mimetype: 'video/mp4',
      fileName: media.fileName.replace('/documentMessage/', '/videoMessage/'),
    };
    const flow = {
      buttons: [
        {
          name: 'cta_url',
          buttonParamsJson: JSON.stringify({ display_text: 'button', url: 'https://example.test/path' }),
        },
      ],
      messageParamsJson: JSON.stringify({ bottom_sheet: true }),
    };
    rows[249] = {
      ...doc(),
      messageType: wrapper,
      message:
        wrapper === 'associatedChildMessage'
          ? { associatedChildMessage: { message: { videoMessage: video } } }
          : {
              templateMessage: {
                templateId: 'synthetic',
                interactiveMessageTemplate: {
                  body: { text: 'body' },
                  header: { hasMediaAttachment: true, videoMessage: video },
                  nativeFlowMessage: flow,
                },
              },
            },
    };
    expectedContent = wrapper === 'templateMessage' ? 'body\nbutton: https://example.test/path' : 'synthetic-caption';
    const before = JSON.stringify(rows);
    const imported = await service.syncStoredHistoryRecoveryBatch(
      { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
      request(),
    );
    assert.equal(imported.importedMessages, 1);
    const postCount = posts;
    const replay = await service.syncStoredHistoryRecoveryBatch(
      { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
      request(),
    );
    assert.equal(replay.importedMessages, 0);
    assert.equal(posts, postCount);
    assert.equal(JSON.stringify(rows), before);
  }
  wireType = 'document';
  currentMedia = media;
  expectedContent = 'synthetic-caption';
  guards = 0;
  editCalls = 0;
  posts = 0;
  stored = false;
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

test('tagged document preserves native UTC epoch across non-UTC pg Dates, replay and MIME presentation', async (t) => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  const pgDate = pg.types.getTypeParser(1114)('2023-11-14 22:13:20') as Date;
  assert.equal(pgDate.getTime(), 1700000000000 + 3 * 3600 * 1000);
  t.after(() => {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  });
  const modulePath = require.resolve('../src/api/server.module.ts');
  const previousModule = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {},
    children: [],
    paths: [],
  } as NodeModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load only after the inert server fixture is installed.
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service = Object.create(ChatwootService.prototype) as any;
  const originalPool = postgresClient.getChatwootConnection;
  const originalAxios = axios.request;
  t.after(() => {
    postgresClient.getChatwootConnection = originalPool;
    axios.request = originalAxios;
    if (previousModule) require.cache[modulePath] = previousModule;
    else delete require.cache[modulePath];
  });
  service.configService = {
    get: () => ({ TRUSTED_BASE_URL: 'https://synthetic.invalid', NATIVE_BRIDGE_TOKEN: 'synthetic-only' }),
  };
  service.assertSilentHistoryMediaCapability = async () => ({ receiver_fingerprint: 'f'.repeat(64) });
  const message = doc();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const row = {
    id: 7,
    attachment_id: 8,
    source_id: 'WAID:doc',
    message_type: 0,
    private: false,
    created_at: pgDate,
    created_at_epoch: 1700000000.321,
    display_id: 345,
    peer: message.key.remoteJid,
    byte_size: bytes.length,
    file_type: 0,
    attachment_meta: { whatsapp_history_sha256: digest, whatsapp_history_media_type: 'document' },
  };
  postgresClient.getChatwootConnection = (() => ({ query: async () => ({ rows: [row] }) })) as any;
  let gets = 0;
  axios.request = (async (config: any) => {
    gets++;
    assert.equal(config.params.provider_media_type, 'document');
    return {
      data: {
        whatsapp_history_media_proof: {
          verified: true,
          message_id: 7,
          source_id: 'WAID:doc',
          attachment_id: 8,
          sha256: digest,
          byte_size: bytes.length,
          media_type: 'document',
        },
      },
    };
  }) as any;
  const provider = { accountId: '1', url: 'https://synthetic.invalid', token: 'synthetic-only' } as any;
  await service.assertTaggedHistoryMediaStored(
    [message],
    { instanceId: 'synthetic-instance', instanceName: 'synthetic' },
    provider,
    99,
  );
  assert.equal(gets, 1);
  await service.assertTaggedHistoryMediaStored([message], { instanceName: 'synthetic' }, provider, 99);
  assert.equal(gets, 2);
  row.created_at_epoch++;
  await assert.rejects(
    service.assertTaggedHistoryMediaStored([message], { instanceName: 'synthetic' }, provider, 99),
    /tagged_destination_unconfirmed/,
  );
  row.created_at_epoch--;
  const correctEpoch = row.created_at_epoch;
  row.created_at_epoch = Number.NaN;
  await assert.rejects(
    service.assertTaggedHistoryMediaStored([message], { instanceName: 'synthetic' }, provider, 99),
    /tagged_destination_unconfirmed/,
  );
  row.created_at_epoch = correctEpoch;
  row.attachment_meta.whatsapp_history_media_type = 'image';
  await assert.rejects(
    service.assertTaggedHistoryMediaStored([message], { instanceName: 'synthetic' }, provider, 99),
    /tagged_destination_unconfirmed/,
  );
  row.attachment_meta.whatsapp_history_media_type = 'document';
  await assert.rejects(
    service.assertTaggedHistoryMediaStored(
      [{ ...message, messageType: 'stickerMessage' }],
      { instanceName: 'synthetic' },
      provider,
      99,
    ),
    /native_digest_unavailable/,
  );
  row.attachment_meta.whatsapp_history_sha256 = '0'.repeat(64);
  await assert.rejects(
    service.assertTaggedHistoryMediaStored([message], { instanceName: 'synthetic' }, provider, 99),
    /tagged_destination_unconfirmed/,
  );
  row.attachment_meta.whatsapp_history_sha256 = digest;
  row.peer = 'foreign@s.whatsapp.net';
  await assert.rejects(
    service.assertTaggedHistoryMediaStored([message], { instanceName: 'synthetic' }, provider, 99),
    /tagged_destination_unconfirmed/,
  );
  assert.equal(gets, 2);
});
