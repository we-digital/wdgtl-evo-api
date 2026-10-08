import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from 'jsonschema';
import { requestGroupHistorySchema } from '../src/validate/chat.schema';

const serverPath = require.resolve('../src/api/server.module.ts');
require.cache[serverPath] = {
  id: serverPath,
  filename: serverPath,
  loaded: true,
  exports: new Proxy({}, { get: () => ({}) }),
  children: [],
  paths: [],
} as NodeModule;
const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
const { BaileysStartupService } = require('../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');
const group = '120363000000001@g.us';
const owner = '628100000001@s.whatsapp.net';

function fixture(inboxId = 40) {
  const service = Object.create(ChatwootService.prototype) as any;
  const provider = { enabled: true, accountId: '1' };
  let creations = 0;
  service.isImportHistoryAvailable = () => false;
  service.clientCw = async () => ({ provider });
  service.getInbox = async () => ({ id: inboxId });
  service.providerConversationRequest = async () => ({
    enabled: true,
    provider: 'whatsapp',
    whatsapp_group_roster_contract_version: 1,
  });
  service.findProviderContact = async () => null;
  service.canonicalProviderConversation = async (_instance, _provider, inbox, peer, _body, metadata) => {
    assert.equal(inbox, inboxId);
    assert.equal(peer, group);
    assert.equal(metadata.subject, 'Synthetic group');
    creations++;
    return inboxId * 100;
  };
  service.waMonitor = {
    waInstances: {
      synthetic: {
        localSettings: { groupsIgnore: false },
        client: {
          authState: { creds: { me: { id: owner, lid: '999999@lid' } } },
          groupFetchAllParticipating: async (emitUpdates) => {
            assert.equal(emitUpdates, false);
            return {
              [group]: {
                id: group,
                subject: 'Synthetic group',
                participants: [{ id: '999999@lid', phoneNumber: owner }],
              },
            };
          },
        },
      },
    },
  };
  return { service, creations: () => creations, instance: { instanceName: 'synthetic' } };
}

test('roster discovery never recreates an empty card in dry-run or apply for each inbox', async () => {
  for (const inboxId of [40, 42]) {
    const f = fixture(inboxId);
    const dry = await f.service.syncParticipatingGroups(f.instance);
    assert.equal(dry.groups[0].conversationId, null);
    assert.equal(f.creations(), 0);
    const result = await f.service.syncParticipatingGroups(f.instance, false);
    assert.equal(result.inboxId, inboxId);
    assert.equal(result.groups[0].conversationId, null);
    assert.equal(result.groups[0].missing, true);
    assert.equal(f.creations(), 0);
  }
});

test('reuses an existing conversation and rejects another inbox or an unauthenticated session', async () => {
  const f = fixture();
  f.service.findProviderContact = async () => ({ id: 10 });
  const conversation = { id: 4000, inbox_id: 40, contact_id: 10, peer: group, provider: 'whatsapp' };
  f.service.providerConversationRequest = async (_provider, _method, data) =>
    data.peer ? { conversation } : { enabled: true, provider: 'whatsapp', whatsapp_group_roster_contract_version: 1 };
  assert.equal((await f.service.syncParticipatingGroups(f.instance, false)).groups[0].missing, false);
  assert.equal(f.creations(), 0);
  conversation.inbox_id = 42;
  await assert.rejects(f.service.syncParticipatingGroups(f.instance, false), /identity conflicts/);
  f.service.waMonitor.waInstances.synthetic.client.authState.creds.me = null;
  await assert.rejects(
    f.service.syncParticipatingGroups(f.instance, false),
    (error: any) =>
      error.status === 400 && error.message?.includes('An authenticated provider and its bound inbox are required'),
  );
  assert.equal(f.creations(), 0);
});

test('fresh authenticated joined-group membership works when metadata omits the receiver participant', async () => {
  const f = fixture();
  f.service.waMonitor.waInstances.synthetic.client.groupFetchAllParticipating = async (emitUpdates) => {
    assert.equal(emitUpdates, false);
    return { [group]: { id: group, subject: 'Synthetic group', participants: [] } };
  };
  const result = await f.service.syncParticipatingGroups(f.instance, false);
  assert.equal(result.groups[0].conversationId, null);
  assert.equal(result.groups[0].missing, true);
  assert.equal(f.creations(), 0);
});

test('primary history request requires current membership and a unique same-instance native anchor', async () => {
  const service = Object.create(BaileysStartupService.prototype) as any;
  service.instance = { id: 'source-instance' };
  service.localSettings = { groupsIgnore: false };
  let requests = 0;
  const native = { key: { id: 'native', remoteJid: group, fromMe: false }, messageTimestamp: 1000 };
  service.prismaRepository = {
    message: {
      findMany: async ({ where }) => {
        assert.equal(where.instanceId, 'source-instance');
        return [native];
      },
    },
  };
  service.client = {
    authState: { creds: { me: { id: owner } } },
    groupMetadata: async () => ({ participants: [{ id: owner }] }),
    fetchMessageHistory: async (count, key, timestamp) => {
      assert.equal(count, 50);
      assert.equal(key.remoteJid, group);
      if (key.id) assert.equal(timestamp, 1000000);
      requests++;
      return 'primary-request';
    },
    sendMessage: () => {
      throw Error('customer send forbidden');
    },
  };
  await service.requestGroupHistory({ remoteJid: group, count: 50, messageId: 'native' });
  await service.requestGroupHistory({ remoteJid: group, count: 50 });
  native.key.remoteJid = '120363000000002@g.us';
  await assert.rejects(
    service.requestGroupHistory({ remoteJid: group, count: 50, messageId: 'native' }),
    (error: any) => JSON.stringify(error).includes('native group message'),
  );
  service.client.groupMetadata = async () => ({ participants: [] });
  await assert.rejects(service.requestGroupHistory({ remoteJid: group, count: 50 }), (error: any) =>
    JSON.stringify(error).includes('participate'),
  );
  assert.equal(requests, 2);
});

test('history request schema bounds count and prohibits non-group and extra payloads', () => {
  assert.equal(validate({ remoteJid: group, count: 50 }, requestGroupHistorySchema).valid, true);
  for (const data of [
    { remoteJid: owner, count: 50 },
    { remoteJid: group, count: 501 },
    { remoteJid: group, count: 0 },
    { remoteJid: group, count: 50, message: 'invented' },
  ]) {
    assert.equal(validate(data, requestGroupHistorySchema).valid, false);
  }
});

test('actual roster writer sends only protected silent contact/conversation metadata', async (t) => {
  const { createServer } = await import('node:http');
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/accounts/1/contacts') res.end(JSON.stringify({ payload: { id: 10 } }));
    else if (req.url === '/api/v1/accounts/1/provider_conversations')
      res.end(
        JSON.stringify({
          id: 4000,
          database_id: 40000,
          contact_id: 10,
          inbox_id: 40,
          provider: 'whatsapp',
          peer: group,
          status: 'open',
        }),
      );
    else {
      res.statusCode = 400;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const service = Object.create(ChatwootService.prototype) as any;
  const provider = { enabled: true, accountId: '1', token: 'synthetic', url: 'https://synthetic.example.test' };
  service.logger = { warn() {} };
  service.configService = {
    get: () => ({ NATIVE_BRIDGE_TOKEN: 's'.repeat(43), TRUSTED_BASE_URL: 'https://synthetic.example.test' }),
  };
  service.getClientCwConfig = () => ({ basePath: base, headers: { 'api-access-token': 'synthetic' } });
  const axios = require('axios').default;
  const originalRequest = axios.request;
  axios.request = async (options) => {
    assert.equal(new URL(options.url).origin, 'https://synthetic.example.test');
    const response = await fetch(base + new URL(options.url).pathname, {
      method: options.method,
      headers: { ...options.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(options.data),
    });
    return { data: await response.json() };
  };
  t.after(() => {
    axios.request = originalRequest;
  });
  service.clientCw = async () => ({ provider });
  service.findProviderContact = async () => null;
  const id = await service.canonicalProviderConversation(
    { instanceName: 'synthetic' },
    provider,
    40,
    group,
    { key: { remoteJid: group } },
    { subject: 'Synthetic group' },
  );
  assert.equal(id, 4000);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers['x-chatwoot-history-import'], '1');
    assert.equal(request.headers['x-chatwoot-history-inbox-id'], '40');
    assert.equal(request.headers['x-chatwoot-native-bridge-token'], 's'.repeat(43));
    assert.equal(request.body.message, undefined);
    assert.equal(request.body.content, undefined);
  }
});

test('bulk roster read stays account/inbox/peer scoped and avoids per-group HTTP reads', async () => {
  const f = fixture();
  f.service.isImportHistoryAvailable = () => true;
  const row = {
    contact_id: 10,
    contact_account_id: 1,
    identifier: group,
    database_id: 40000,
    conversation_id: 4000,
    conversation_account_id: 1,
    inbox_id: 40,
    binding_provider: 'whatsapp',
    binding_peer: group,
  };
  let reads = 0;
  f.service.pgClient = {
    query: async (sql, params) => {
      assert.match(sql, /ct.account_id = \$1/);
      assert.match(sql, /c.inbox_id = \$2/);
      assert.deepEqual(params, [1, 40, [group]]);
      assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
      reads++;
      return { rows: [row] };
    },
  };
  f.service.findProviderContact = () => {
    throw Error('per-group HTTP read forbidden');
  };
  const result = await f.service.syncParticipatingGroups(f.instance, false);
  assert.equal(result.groups[0].conversationId, 4000);
  assert.equal(result.groups[0].missing, false);
  assert.equal(reads, 1);
  assert.equal(f.creations(), 0);
  for (const changed of [
    { ...row, contact_account_id: 2 },
    { ...row, inbox_id: 42 },
    { ...row, binding_peer: '120363000000002@g.us' },
    { ...row, binding_provider: 'telegram_mtproto' },
  ]) {
    f.service.pgClient.query = async () => ({ rows: [changed] });
    await assert.rejects(f.service.syncParticipatingGroups(f.instance, false), /identity conflicts/);
  }
  f.service.pgClient.query = async () => ({ rows: [row, row] });
  await assert.rejects(f.service.syncParticipatingGroups(f.instance, false), /identity conflicts/);
});

test(
  'exact roster SQL on isolated synthetic PostgreSQL preserves routes and rejects duplicate identities',
  {
    skip: !process.env.GROUP_ROSTER_LAB_SOCKET,
  },
  async () => {
    const { Client } = require('pg');
    const client = new Client({ host: process.env.GROUP_ROSTER_LAB_SOCKET, port: 55470, database: 'postgres' });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE contacts (id integer,account_id integer,identifier text);
      CREATE TEMP TABLE conversations (id integer,display_id integer,account_id integer,inbox_id integer,contact_id integer,status integer);
      CREATE TEMP TABLE provider_conversation_bindings (conversation_id integer,provider text,peer text);`);
      await client.query('INSERT INTO contacts VALUES(10,1,$1),(20,2,$1)', [group]);
      await client.query(
        'INSERT INTO conversations VALUES(40000,4000,1,40,10,0),(42000,4200,1,42,10,1),(50000,5000,2,40,20,0)',
      );
      await client.query(
        "INSERT INTO provider_conversation_bindings VALUES(40000,'whatsapp',$1),(42000,'whatsapp',$1),(50000,'whatsapp',$1)",
        [group],
      );
      const f = fixture();
      f.service.pgClient = client;
      f.service.isImportHistoryAvailable = () => true;
      f.service.findProviderContact = () => {
        throw Error('HTTP lookup forbidden');
      };
      assert.equal((await f.service.syncParticipatingGroups(f.instance)).groups[0].conversationId, 4000);
      f.service.getInbox = async () => ({ id: 42 });
      assert.equal((await f.service.syncParticipatingGroups(f.instance)).groups[0].conversationId, 4200);
      await client.query('INSERT INTO contacts VALUES(11,1,$1)', [group]);
      await assert.rejects(f.service.syncParticipatingGroups(f.instance), /identity conflicts/);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  },
);

test('existing unbound group stays read-only until a real message needs canonical resolution', async () => {
  const f = fixture();
  f.service.isImportHistoryAvailable = () => true;
  const row = {
    contact_id: 10,
    contact_account_id: 1,
    identifier: group,
    database_id: 40000,
    conversation_id: 4000,
    conversation_account_id: 1,
    inbox_id: 40,
    binding_provider: null,
    binding_peer: null,
  };
  f.service.pgClient = { query: async () => ({ rows: [row] }) };
  const dry = await f.service.syncParticipatingGroups(f.instance);
  assert.equal(dry.groups[0].conversationId, 4000);
  assert.equal(dry.groups[0].missing, false);
  assert.equal(f.creations(), 0, 'dry-run never repairs metadata');
  const applied = await f.service.syncParticipatingGroups(f.instance, false);
  assert.equal(applied.groups[0].conversationId, 4000);
  assert.equal(f.creations(), 0, 'roster lookup must not call a create-capable resolver');
  row.binding_provider = 'whatsapp';
  row.binding_peer = group;
  await f.service.syncParticipatingGroups(f.instance, false);
  assert.equal(f.creations(), 0, 'an exact existing binding needs no metadata write');
});

test('roster lookup cannot recreate an observed group through a resolver that raced with deletion', async () => {
  const f = fixture();
  f.service.isImportHistoryAvailable = () => true;
  f.service.pgClient = {
    query: async () => ({
      rows: [
        {
          contact_id: 10,
          contact_account_id: 1,
          identifier: group,
          database_id: 40000,
          conversation_id: 4000,
          conversation_account_id: 1,
          inbox_id: 40,
          binding_provider: null,
          binding_peer: null,
        },
      ],
    }),
  };
  f.service.canonicalProviderConversation = async () => {
    throw Error('create-capable resolver forbidden');
  };
  const result = await f.service.syncParticipatingGroups(f.instance, false);
  assert.equal(result.groups[0].conversationId, 4000);
});

test('group reaction requires its existing original and never recreates a deleted empty card', async () => {
  for (const destination of [null, { chatwootConversationId: 4000, chatwootMessageId: 4001 }]) {
    const f = fixture();
    f.service.logger = {
      info() {},
      warn() {},
      error(error) {
        throw error;
      },
    };
    f.service.getConversationMessage = async () => null;
    f.service.isMediaMessage = () => false;
    f.service.getAdsMessage = () => ({});
    f.service.isInteractiveButtonMessage = () => false;
    f.service.getNativeEventTarget = async (_instance, id, key) => {
      assert.equal(id, 'original');
      assert.deepEqual(key, { remoteJid: group, fromMe: false });
      return destination;
    };
    f.service.createConversation = () => {
      throw Error('reaction cannot create a conversation');
    };
    let reactions = 0;
    f.service.applyNativeChatwootReaction = async (_instance, conversationId) => {
      assert.equal(conversationId, 4000);
      reactions++;
    };
    await f.service.processWhatsappEvent('messages.upsert', f.instance, {
      key: { id: 'reaction', remoteJid: group, fromMe: false },
      message: { reactionMessage: { key: { id: 'original', remoteJid: group, fromMe: false }, text: 'synthetic' } },
    });
    assert.equal(reactions, destination ? 1 : 0);
    assert.equal(f.creations(), 0);
  }
});

test('real group ingress resolves the canonical peer rather than trusting a deleted conversation cache', async () => {
  const f = fixture();
  f.service.logger = {
    warn() {},
    error(error) {
      throw error;
    },
  };
  f.service.providerConversationsEnabled = async () => true;
  let resolutions = 0;
  f.service.canonicalProviderConversation = async (instance, provider, inboxId, peer, body, roster) => {
    assert.equal(instance.instanceName, 'synthetic');
    assert.equal(provider.accountId, '1');
    assert.equal(inboxId, 40);
    assert.equal(peer, group);
    assert.equal(body.key.id, 'ordinary');
    assert.equal(roster, undefined);
    resolutions++;
    return 4000;
  };
  f.service.cache = {
    get() {
      throw Error('stale legacy cache must not be used');
    },
  };
  const body = { key: { id: 'ordinary', remoteJid: group, fromMe: false }, message: { conversation: 'synthetic' } };
  assert.equal(await f.service.createConversation(f.instance, body), 4000);
  assert.equal(resolutions, 1);
});
