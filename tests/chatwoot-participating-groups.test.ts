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
  service.clientCw = async () => ({ provider });
  service.getInbox = async () => ({ id: inboxId });
  service.providerConversationsEnabled = async () => true;
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

test('dry-run does not create and apply remains scoped to each participating inbox', async () => {
  for (const inboxId of [40, 42]) {
    const f = fixture(inboxId);
    const dry = await f.service.syncParticipatingGroups(f.instance);
    assert.equal(dry.groups[0].conversationId, null);
    assert.equal(f.creations(), 0);
    const result = await f.service.syncParticipatingGroups(f.instance, false);
    assert.equal(result.inboxId, inboxId);
    assert.equal(result.groups[0].conversationId, inboxId * 100);
    assert.equal(f.creations(), 1);
  }
});

test('reuses an existing conversation and rejects another inbox or unknown owner', async () => {
  const f = fixture();
  f.service.findProviderContact = async () => ({ id: 10 });
  const conversation = { id: 4000, inbox_id: 40, contact_id: 10, peer: group, provider: 'whatsapp' };
  f.service.providerConversationRequest = async () => ({ conversation });
  assert.equal((await f.service.syncParticipatingGroups(f.instance, false)).groups[0].missing, false);
  assert.equal(f.creations(), 0);
  conversation.inbox_id = 42;
  await assert.rejects(f.service.syncParticipatingGroups(f.instance, false), /identity conflicts/);
  f.service.waMonitor.waInstances.synthetic.client.authState.creds.me = { id: '628100000099@s.whatsapp.net' };
  await assert.rejects(f.service.syncParticipatingGroups(f.instance, false), /owner identity/);
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
