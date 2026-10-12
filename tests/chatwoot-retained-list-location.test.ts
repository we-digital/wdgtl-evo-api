import assert from 'node:assert/strict';
import test from 'node:test';

import axios from 'axios';
import { proto } from 'baileys';

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';

const location = () => ({
  degreesLatitude: 10.5,
  degreesLongitude: -20.25,
  sequenceNumber: { low: -797805463, high: 417183, unsigned: false },
  jpegThumbnail: Buffer.from('synthetic-thumbnail').toString('base64'),
  contextInfo: { mentionedJid: [], groupMentions: [] },
});
const list = () => ({
  listType: 1,
  description: 'Choose one\nNative body',
  buttonText: 'Open menu',
  sections: [
    {
      rows: [
        { rowId: 'row-1', title: 'One' },
        { rowId: 'row-2', title: 'Two', description: 'Detail' },
      ],
    },
  ],
});
const response = () => ({
  title: 'Two',
  listType: 1,
  singleSelectReply: { selectedRowId: 'row-2' },
  contextInfo: {
    stanzaId: 'quoted-native',
    participant: '628111111111@s.whatsapp.net',
    quotedMessage: { listMessage: list() },
  },
});
const row = (type: string, value: any, outgoing = false, suffix = type) => ({
  id: `db-${suffix}`,
  instanceId: 'synthetic-instance',
  messageTimestamp: 1700000000,
  status: outgoing ? 'SERVER_ACK' : 'READ',
  messageType: type,
  key: { id: `native-${suffix}`, remoteJid: '628111111111@s.whatsapp.net', fromMe: outgoing },
  message: {
    [type]: value,
    messageContextInfo: { threadId: [], messageSecret: Buffer.alloc(32, 1).toString('base64') },
  },
});
const fixtures = () => [
  row('liveLocationMessage', location()),
  row('liveLocationMessage', location(), true, 'out-location'),
  row('listMessage', list()),
  row('listResponseMessage', response(), true),
];

for (const source of fixtures()) {
  test(`ordinary typed ${source.id} preserves the native protobuf payload`, () => {
    const before = structuredClone(source);
    const decoded = proto.Message.decode(proto.Message.encode(proto.Message.fromObject(source.message)).finish());
    assert.ok((decoded as any)[source.messageType]);
    assert.equal(classifyCachedHistoryRecord(source, false), 'ordinary');
    assert.deepEqual(source, before);
  });
}

const negatives: [string, any][] = [
  ['NaN latitude', row('liveLocationMessage', { ...location(), degreesLatitude: NaN })],
  ['invalid longitude', row('liveLocationMessage', { ...location(), degreesLongitude: 181 })],
  ['string coordinate', row('liveLocationMessage', { ...location(), degreesLatitude: '10' })],
  ['unknown live field', row('liveLocationMessage', { ...location(), caption: 'not rendered' })],
  [
    'malformed native Long',
    row('liveLocationMessage', { ...location(), sequenceNumber: { low: 1, high: -1, unsigned: false } }),
  ],
  ['bad thumbnail', row('liveLocationMessage', { ...location(), jpegThumbnail: 'not-base64' })],
  ['product list', row('listMessage', { ...list(), listType: 2 })],
  ['unknown action', row('listMessage', { ...list(), productListInfo: {} })],
  [
    'duplicate row',
    row('listMessage', { ...list(), sections: [{ rows: [list().sections[0].rows[0], list().sections[0].rows[0]] }] }),
  ],
  ['empty menu', row('listMessage', { ...list(), sections: [] })],
  ['empty button', row('listMessage', { ...list(), buttonText: '' })],
  ['non-text description', row('listMessage', { ...list(), description: {} })],
  ['missing selected ID', row('listResponseMessage', { ...response(), singleSelectReply: {} })],
  [
    'unknown response action',
    row('listResponseMessage', { ...response(), singleSelectReply: { selectedRowId: 'row-2', action: 'run' } }),
  ],
  ['empty response label', row('listResponseMessage', { ...response(), title: '' })],
  [
    'competing ordinary primary',
    { ...row('listMessage', list()), message: { listMessage: list(), conversation: 'competing' } },
  ],
  [
    'sidecar overriding renderer',
    { ...row('listMessage', list()), message: { listMessage: list(), messageContextInfo: { stanzaId: 'competing' } } },
  ],
];
for (const [name, source] of negatives) {
  test(`holds ${name}`, () => assert.throws(() => classifyCachedHistoryRecord(source, false)));
}

test('literal recovery read, stock renderer and SQL projection preserve all four sources, direction and original dates', async (t) => {
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Server construction is replaced before loading the literal service.
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const originalPool = postgresClient.getChatwootConnection;
  const originalRequest = axios.request;
  postgresClient.getChatwootConnection = (() => ({ query: async () => ({ rows: [] }) })) as any;
  axios.request = (async () => assert.fail('No HTTP/provider requests in this synthetic path')) as any;
  t.after(() => {
    postgresClient.getChatwootConnection = originalPool;
    axios.request = originalRequest;
  });
  const service = Object.create(ChatwootService.prototype) as any;
  let rows = fixtures();
  const before = structuredClone(rows);
  const persisted = new Map<string, any>();
  let guards = 0;
  const provider = { accountId: '1', importMessages: true, enabled: true, nameInbox: 'synthetic', token: 'synthetic' };
  service.isImportHistoryAvailable = () => true;
  service.getProvider = async () => provider;
  service.getStoredHistoryRecoveryInbox = async () => ({ id: 99 });
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: false }) };
  service.resolvePhoneJidForLid = async () => null;
  service.readRecoveryMedia = async () => assert.fail('No native/provider download for ordinary location/list');
  service.readCachedRecoveryObject = async () => assert.fail('No storage download for ordinary location/list');
  service.getGroupIdentityNames = async () => new Map();
  service.waMonitor = { waInstances: {} };
  service.pgClient = { query: async () => ({ rows: [] }) };
  service.prismaRepository = {
    message: {
      findMany: async ({ where }: any) => {
        assert.equal(where.Instance.name, 'synthetic');
        return rows;
      },
    },
    messageUpdate: { findMany: async () => [] },
    media: { findFirst: async () => null },
  };
  const methods = [
    'activateHistorySourceGuards',
    'reconcileOutboundHistoryBindings',
    'getVerifiedRecoverySourceIds',
    'reconcileProviderHistoryEdits',
    'getChatwootUser',
    'getExistingSourceIds',
    'selectOrCreateFksFromChatwoot',
    'insertHistoryMessagesSerialized',
  ] as const;
  const originals = methods.map((name) => (chatwootImport as any)[name]);
  t.after(() =>
    methods.forEach((name, i) => {
      (chatwootImport as any)[name] = originals[i];
    }),
  );
  chatwootImport.activateHistorySourceGuards = async (ids: string[], inbox: number) => {
    assert.equal(inbox, 99);
    assert.equal(ids.length, 4);
    guards++;
  };
  chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
  chatwootImport.reconcileProviderHistoryEdits = async () => new Map();
  chatwootImport.getVerifiedRecoverySourceIds = async (requested: any[], inbox: number) => {
    assert.equal(inbox, 99);
    return new Set(requested.map((r) => `WAID:${r.key.id}`).filter((id) => persisted.has(id)));
  };
  chatwootImport.getExistingSourceIds = async () => new Set(persisted.keys());
  (chatwootImport as any).getChatwootUser = async () => ({ user_id: '7', user_type: 'User' });
  chatwootImport.selectOrCreateFksFromChatwoot = async (_provider, inbox, _times, byIdentity) => {
    assert.equal(inbox.id, 99);
    assert.deepEqual([...byIdentity.keys()], ['628111111111@s.whatsapp.net']);
    return new Map([
      [
        '628111111111@s.whatsapp.net',
        { identity_key: '628111111111@s.whatsapp.net', contact_id: '5', conversation_id: '123' },
      ],
    ]) as any;
  };
  (chatwootImport as any).insertHistoryMessagesSerialized = async (statements: any[], scope: any) => {
    assert.ok(guards > 0);
    assert.deepEqual(scope, {
      accountId: 1,
      inboxId: 99,
      peers: ['628111111111@s.whatsapp.net'],
      conversationIds: [123],
    });
    let count = 0;
    for (const statement of statements) {
      assert.match(statement.sql, /INSERT INTO messages/);
      assert.match(statement.sql, /FALSE/);
      for (let i = 2; i < statement.params.length; i += 8) {
        const [content, conversationId, direction, senderType, senderId, sourceId, epoch, attributes] =
          statement.params.slice(i, i + 8);
        assert.equal(conversationId, '123');
        assert.equal(epoch, 1700000000);
        assert.equal(attributes, '{}');
        persisted.set(sourceId, { content, direction, senderType, senderId });
        count++;
      }
    }
    return count;
  };
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
      message: structuredClone(message),
      sourceId: `WAID:${message.key.id}`,
      expectedDirection: message.key.fromMe ? 'outgoing' : 'incoming',
    })),
  });
  const result = await service.syncStoredHistoryRecoveryBatch(
    { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
    request(),
  );
  assert.equal(result.importedMessages, 4);
  assert.equal(result.placeholderMessages, 0);
  assert.equal(
    result.outcomes.every((outcome: any) => outcome.status === 'imported'),
    true,
  );
  for (const native of rows) {
    const saved = persisted.get(`WAID:${native.key.id}`);
    assert.equal(saved.direction, native.key.fromMe ? '1' : '0');
    assert.equal(saved.senderType, native.key.fromMe ? 'User' : 'Contact');
    assert.equal(saved.senderId, native.key.fromMe ? '7' : '5');
    assert.equal(saved.content, service.getConversationMessage(native.message));
  }
  const menu = persisted.get('WAID:native-listMessage').content;
  for (const value of ['Choose one\nNative body', 'Open menu', 'One', 'Two', 'Detail', 'row-1', 'row-2'])
    assert.ok(menu.includes(value));
  assert.ok(!menu.includes('undefined'));
  assert.ok(persisted.get('WAID:native-listResponseMessage').content.includes('row-2'));
  assert.ok(persisted.get('WAID:native-liveLocationMessage').content.includes('query=10.5,-20.25'));
  assert.deepEqual(rows, before);
  const repeat = await service.syncStoredHistoryRecoveryBatch(
    { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
    request(),
  );
  assert.equal(repeat.importedMessages, 0);
  assert.equal(persisted.size, 4);
  const foreign = request();
  foreign.expectedInboxId = 98;
  await assert.rejects(service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, foreign), (error: any) =>
    JSON.stringify(error).includes('destination changed'),
  );
  const wrongDirection = request();
  wrongDirection.messages[0].expectedDirection = 'outgoing';
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, wrongDirection),
    (error: any) => JSON.stringify(error).includes('identity does not match'),
  );
  const stale = request();
  rows = rows.map((r, i) => (i === 0 ? { ...r, messageTimestamp: 1700000001 } : r));
  await assert.rejects(service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, stale), (error: any) =>
    JSON.stringify(error).includes('source version changed'),
  );
  assert.equal(persisted.size, 4);
  const malformed = fixtures();
  (malformed[2].message as any).listMessage.productListInfo = { productSections: [] };
  rows = malformed;
  const previousGuards = guards;
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request()),
    /Retained list or live location is unsupported/,
  );
  assert.equal(guards, previousGuards, 'Malformed subtype fails before source guard/write admission');
  assert.equal(persisted.size, 4);
});
