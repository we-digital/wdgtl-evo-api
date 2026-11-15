process.env.CHATWOOT_AVATAR_SYNC = 'off';

import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';

const GROUP = '120363000000888@g.us';
const pn = (n: number) => `6281000000${String(n).padStart(3, '0')}@s.whatsapp.net`;

const provider = {
  id: 'provider-gc',
  instanceId: 'instance-gc',
  enabled: true,
  accountId: '1',
  token: 'provider-token',
  url: 'https://chatwoot.example.invalid',
  nameInbox: 'WA - Test',
  signMsg: false,
  signDelimiter: null,
  reopenConversation: true,
  conversationPending: false,
};
const instance = { instanceId: 'instance-gc', instanceName: 't-test' };
const admission = {
  deliveryId: 'd-1',
  timestampSeconds: 0,
  receivedAt: new Date(),
  routeInstanceId: instance.instanceId,
  routeProviderId: provider.id,
};

/** A Chatwoot with a unique contact identifier and create-or-return provider bindings. */
function fakeChatwoot() {
  const contacts = new Map<string, { id: number; identifier: string; name: string }>();
  const conversations = new Map<string, { id: number; database_id: number; contact_id: number }>();
  const calls = { contactCreates: 0, conversationPosts: 0, patches: [] as any[] };
  return {
    contacts,
    conversations,
    calls,
    findProviderContact: async (_instance: unknown, peer: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return contacts.get(peer) ?? null;
    },
    createContact: async (
      _i: unknown,
      _phone: string,
      _inbox: number,
      _isGroup: boolean,
      name: string,
      _a: unknown,
      jid: string,
    ) => {
      calls.contactCreates++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Chatwoot answers 422 on a second identifier; createContact then returns the existing one.
      const contact = contacts.get(jid) ?? { id: 300 + contacts.size, identifier: jid, name };
      contacts.set(jid, contact);
      return contact;
    },
    providerConversationRequest: async (_provider: unknown, method: string, data: any) => {
      if (method === 'GET') return { enabled: true, provider: 'whatsapp' };
      calls.conversationPosts++;
      const conversation = conversations.get(data.peer) ?? {
        id: 70 + conversations.size,
        database_id: 7000 + conversations.size,
        contact_id: data.contact_id,
      };
      conversations.set(data.peer, conversation);
      return { ...conversation, inbox_id: data.inbox_id, provider: 'whatsapp', peer: data.peer, status: 'open' };
    },
  };
}

function fakeSocket() {
  const calls: string[] = [];
  return {
    calls,
    socket: {
      user: { id: '6280000000001:23@s.whatsapp.net' },
      onWhatsApp: async (...jids: string[]) => jids.map((jid) => ({ jid, exists: true })),
      groupCreate: async (subject: string, participants: string[]) => {
        calls.push(`create:${subject}:${participants.join(',')}`);
        return { id: GROUP, participants: participants.map((id) => ({ id })) };
      },
      groupParticipantsUpdate: async (_jid: string, participants: string[], action: string) => {
        calls.push(`${action}:${participants.join(',')}`);
        return participants.map((jid) => ({ status: action === 'add' && jid === pn(2) ? '403' : '200', jid }));
      },
      updateProfilePicture: async () => calls.push('picture'),
      groupInviteCode: async () => 'Invite42',
      groupMetadata: async () => assert.fail('the subject comes from the request'),
    },
  };
}

function serviceFixture(chatwoot = fakeChatwoot(), socket = fakeSocket()) {
  const cache = new Map<string, unknown>();
  const service = new ChatwootService(
    {
      waInstances: {
        [instance.instanceName]: {
          client: socket.socket,
          connectionStatus: { state: 'open' },
          localSettings: { groupsIgnore: false },
          resolvePhoneJidForLid: async () => null,
        },
      },
    } as any,
    {
      get: (key: string) =>
        key === 'CACHE'
          ? { REDIS: { ENABLED: false } }
          : { PROVIDER_CONVERSATION_BINDINGS: true, NATIVE_BRIDGE_TOKEN: 'bridge', BOT_CONTACT: false },
    } as any,
    {} as any,
    {
      has: async (key: string) => cache.has(key),
      get: async (key: string) => cache.get(key),
      set: async (key: string, value: unknown) => void cache.set(key, value),
      delete: async (key: string) => void cache.delete(key),
    } as any,
  ) as any;
  service.logger = { error: () => undefined, warn: () => undefined, verbose: () => undefined, info: () => undefined };
  service.clientCw = async () => ({ provider, client: {} });
  service.authenticatedClientCw = async () => ({ provider, client: {}, instance });
  service.getInbox = async () => ({ id: 42 });
  service.findProviderContact = chatwoot.findProviderContact;
  service.createContact = chatwoot.createContact;
  service.providerConversationRequest = chatwoot.providerConversationRequest;
  const rosterSyncs: string[] = [];
  service.syncWhatsappGroupParticipants = async (_i: unknown, _p: unknown, _c: number, peer: string) =>
    void rosterSyncs.push(peer);
  return { service, chatwoot, socket, rosterSyncs };
}

let sequence = 0;
const createBody = (requestId = `req-${Date.now()}-${++sequence}`) => ({
  event: 'group_create_request',
  v: 1,
  request_id: requestId,
  account: { id: 1 },
  inbox: { id: 42 },
  subject: 'Canary group',
  picture: { mime: 'image/jpeg', base64: Buffer.from('jpeg').toString('base64') },
  invitees: [
    { key: 'c:1', kind: 'contact', jid: pn(1), admin: false },
    { key: 'c:2', kind: 'contact', jid: pn(2), admin: false },
    { key: 'i:3', kind: 'colleague_inbox', jid: pn(3), admin: true },
    // The instance's own number (a colleague picking its own inbox): never invited.
    { key: 'i:self', kind: 'colleague_inbox', jid: '6280000000001@s.whatsapp.net', admin: true },
  ],
  actor: { user_id: 7, name: 'Mila' },
});

const withEnv = async (values: Record<string, string | undefined>, run: () => Promise<void>) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key];
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
};

test('gate off: nothing is created and the bus/HTTP error carries the code', async () => {
  await withEnv({ CHATWOOT_GROUP_CREATE_INSTANCES: '' }, async () => {
    const { service, socket } = serviceFixture();
    await assert.rejects(service.receiveWebhook(instance, createBody(), admission), (error: any) => {
      assert.equal(error.message, 'group_create_disabled');
      assert.equal(error.status, 403);
      assert.deepEqual(error.body, { status: 'error', code: 'group_create_disabled' });
      return true;
    });
    assert.deepEqual(socket.calls, []);
  });
  await withEnv({ CHATWOOT_GROUP_CREATE_INSTANCES: 'some-other-instance' }, async () => {
    const { service } = serviceFixture();
    await assert.rejects(
      service.receiveWebhook(instance, createBody(), admission),
      (error: any) => error.message === 'group_create_disabled',
    );
  });
});

test('an unsigned request, a peer allowlist, a disconnected socket and a foreign inbox are refused', async () => {
  await withEnv({ CHATWOOT_GROUP_CREATE_INSTANCES: 't-test' }, async () => {
    const { service } = serviceFixture();
    await assert.rejects(
      service.receiveWebhook(instance, createBody(), undefined),
      (error: any) => error.status === 401,
    );

    await withEnv({ CHATWOOT_BUS_OUTBOUND_PEERS: '120363431310229945@g.us' }, async () => {
      await assert.rejects(
        service.receiveWebhook(instance, createBody(), admission),
        (error: any) => error.message === 'allowlist_deployment',
      );
    });

    const offline = serviceFixture();
    offline.service.waMonitor.waInstances[instance.instanceName].connectionStatus = { state: 'close' };
    await assert.rejects(
      offline.service.receiveWebhook(instance, createBody(), admission),
      (error: any) => error.message === 'not_connected',
    );

    await assert.rejects(
      service.receiveWebhook(instance, { ...createBody(), inbox: { id: 6 } }, admission),
      (error: any) => error.message === 'invalid_request',
    );
  });
});

test('create end to end: group, Chatwoot conversation, outcomes; the status lookup answers the stored reply', async () => {
  await withEnv({ CHATWOOT_GROUP_CREATE_INSTANCES: 't-test' }, async () => {
    const { service, chatwoot, socket, rosterSyncs } = serviceFixture();
    const body = createBody();
    const reply = await service.receiveWebhook(instance, body, admission);
    assert.equal(reply.status, 'ok');
    assert.equal(reply.group_peer, GROUP);
    assert.deepEqual(reply.conversation, { id: 70, database_id: 7000 });
    assert.equal(chatwoot.contacts.get(GROUP)?.name, 'Canary group (GROUP)');
    assert.deepEqual(socket.calls, [
      `create:Canary group:${pn(1)}`,
      `add:${pn(2)}`,
      `add:${pn(3)}`,
      `promote:${pn(3)}`,
      'picture',
    ]);
    assert.deepEqual(
      reply.invitees.map(({ key, outcome, reason, admin }: any) => [key, outcome, reason, admin]),
      [
        ['c:1', 'added', null, null],
        ['c:2', 'skipped', 'privacy', null],
        ['i:3', 'added', null, 'promoted'],
      ],
    );
    assert.equal(reply.invite_link, 'https://chat.whatsapp.com/Invite42');
    assert.equal(reply.picture, 'set');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(rosterSyncs, [GROUP]);

    // Another ChatwootService of the same process (each channel builds its own) shares the store.
    const other = serviceFixture(chatwoot);
    const status = await other.service.receiveWebhook(
      instance,
      { event: 'group_create_status', v: 1, request_id: body.request_id, account: { id: 1 }, inbox: { id: 42 } },
      admission,
    );
    assert.deepEqual(status, reply);
    const repeat = await other.service.receiveWebhook(instance, body, admission);
    assert.deepEqual(repeat, reply);
    assert.deepEqual(other.socket.calls, []);

    const unknown = await service.receiveWebhook(
      instance,
      { event: 'group_create_status', v: 1, request_id: 'never-sent-0001', account: { id: 1 }, inbox: { id: 42 } },
      admission,
    );
    assert.deepEqual(unknown, { status: 'unknown' });
  });
});

test('the status lookup needs the signed admission and creates nothing, even with the gate off', async () => {
  await withEnv({ CHATWOOT_GROUP_CREATE_INSTANCES: '' }, async () => {
    const { service, socket } = serviceFixture();
    const body = {
      event: 'group_create_status',
      v: 1,
      request_id: 'never-sent-0002',
      account: { id: 1 },
      inbox: { id: 42 },
    };
    await assert.rejects(service.receiveWebhook(instance, body, undefined), (error: any) => error.status === 401);
    assert.deepEqual(await service.receiveWebhook(instance, body, admission), { status: 'unknown' });
    assert.deepEqual(socket.calls, []);
  });
});

test('race: the first message in the new group and the create resolve one contact and one conversation', async () => {
  await withEnv({ CHATWOOT_GROUP_CREATE_INSTANCES: 't-test' }, async () => {
    const chatwoot = fakeChatwoot();
    const socket = fakeSocket();
    const creator = serviceFixture(chatwoot, socket);
    // Ingress runs on a different ChatwootService (the channel's own), as in production.
    const ingress = serviceFixture(chatwoot, socket);
    let inbound: Promise<number> | null = null;
    const create = socket.socket.groupCreate;
    socket.socket.groupCreate = async (subject: string, participants: string[]) => {
      const created = await create(subject, participants);
      // An invitee writes the moment the group exists, before the bridge resolved it.
      inbound = ingress.service.createConversation(instance, {
        key: { remoteJid: GROUP, fromMe: true, id: 'IN-1' },
        pushName: 'Anna',
        message: { conversation: 'hi' },
      });
      return created;
    };
    const reply = await creator.service.receiveWebhook(instance, createBody(), admission);
    const inboundConversation = await inbound;
    assert.equal(inboundConversation, reply.conversation.id);
    assert.equal(chatwoot.calls.contactCreates, 1);
    assert.equal(chatwoot.contacts.size, 1);
    assert.equal(chatwoot.conversations.size, 1);
  });
});

test('ingress alone still resolves a group through the same resolver', async () => {
  const chatwoot = fakeChatwoot();
  const socket = fakeSocket();
  socket.socket.groupMetadata = async () => ({ subject: 'Existing group' }) as any;
  const { service } = serviceFixture(chatwoot, socket);
  const id = await service.createConversation(instance, { key: { remoteJid: GROUP, fromMe: true, id: 'IN-2' } });
  assert.equal(id, 70);
  assert.equal(chatwoot.contacts.get(GROUP)?.name, 'Existing group (GROUP)');
});

test('provider self: PATCH with the bare JID once per connect; 404 is tolerated; gated per instance', async () => {
  const { service } = serviceFixture();
  const requests: any[] = [];
  service.privilegedChatwootRequest = async (_provider: unknown, params: any) => {
    requests.push(params);
    throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
  };
  await service.reportProviderSelf(instance);
  assert.deepEqual(requests, []);

  // Per instance: another instance listed does not switch this one on.
  await withEnv({ CHATWOOT_PROVIDER_SELF_REPORT: 'wa-other' }, async () => {
    await service.reportProviderSelf(instance);
  });
  assert.deepEqual(requests, []);
  await withEnv({ CHATWOOT_PROVIDER_SELF_REPORT: 'wa-other,t-test' }, async () => {
    await service.reportProviderSelf(instance);
    await service.reportProviderSelf(instance);
  });
  assert.deepEqual(requests, [
    {
      method: 'PATCH',
      path: '/api/v1/accounts/1/inboxes/42/provider_self',
      data: { whatsapp_jid: '6280000000001@s.whatsapp.net' },
    },
  ]);
});

test('a group whose Chatwoot conversation failed answers in_progress (200) and the status call completes it', async () => {
  await withEnv({ CHATWOOT_GROUP_CREATE_INSTANCES: 't-test' }, async () => {
    const chatwoot = fakeChatwoot();
    const { service, socket, rosterSyncs } = serviceFixture(chatwoot);
    const post = chatwoot.providerConversationRequest;
    let chatwootDown = true;
    service.providerConversationRequest = async (provider: unknown, method: string, data: any) => {
      if (method === 'POST' && chatwootDown)
        throw Object.assign(new Error('Bad Gateway'), { response: { status: 502 } });
      return post(provider, method, data);
    };
    const sleep = global.setTimeout;
    // The three conversation attempts wait 1 s and 2 s; keep the test fast.
    (global as any).setTimeout = (fn: () => void, _ms: number) => sleep(fn, 0);
    let reply: any;
    const body = createBody();
    try {
      reply = await service.receiveWebhook(instance, body, admission);
    } finally {
      (global as any).setTimeout = sleep;
    }
    assert.deepEqual(reply, { status: 'in_progress' });
    assert.equal(socket.calls.filter((call) => call.startsWith('create:')).length, 1);

    const statusBody = {
      event: 'group_create_status',
      v: 1,
      request_id: body.request_id,
      account: { id: 1 },
      inbox: { id: 42 },
    };
    assert.deepEqual(await service.receiveWebhook(instance, statusBody, admission), { status: 'in_progress' });
    // A repeated create never makes a second group.
    assert.deepEqual(await service.receiveWebhook(instance, body, admission), { status: 'in_progress' });
    assert.equal(socket.calls.filter((call) => call.startsWith('create:')).length, 1);

    chatwootDown = false;
    const done = await service.receiveWebhook(instance, statusBody, admission);
    assert.equal(done.status, 'ok');
    assert.equal(done.group_peer, GROUP);
    assert.deepEqual(done.conversation, { id: 70, database_id: 7000 });
    assert.equal(chatwoot.contacts.get(GROUP)?.name, 'Canary group (GROUP)');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(rosterSyncs, [GROUP]);
    assert.deepEqual(await service.receiveWebhook(instance, statusBody, admission), done);
  });
});
