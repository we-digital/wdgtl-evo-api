import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { createJid } from '@utils/createJid';

const provider = {
  id: 'provider-1',
  instanceId: 'instance-1',
  enabled: true,
  accountId: '7',
  token: 'provider-token',
  url: 'https://chatwoot.example.invalid',
  nameInbox: 'WA - Test',
  signMsg: false,
  signDelimiter: null,
  reopenConversation: true,
  conversationPending: false,
};

const instance = {
  instanceId: 'instance-1',
  instanceName: 'test-instance',
};

const serviceFixture = (resolvePhoneJidForLid: (lid: string) => Promise<string | null>) => {
  const cache = new Map<string, unknown>();
  const profilePictureLookups: string[] = [];
  const client = {
    contacts: {
      filter: async (_params: unknown): Promise<any> => ({ payload: [], meta: { count: 0 } }),
      create: async () => null,
      listConversations: async () => ({
        payload: [
          {
            id: 77,
            inbox_id: 58,
            status: 'open',
            meta: { sender: { name: 'Contact', identifier: 'contact' } },
          },
        ],
      }),
    },
    conversations: {
      create: async () => null,
      get: async () => null,
      toggleStatus: async () => null,
    },
  };
  const service = new ChatwootService(
    {
      waInstances: {
        [instance.instanceName]: {
          resolvePhoneJidForLid,
          client: {
            groupMetadata: async (jid: string) => ({ JID: jid, subject: 'Test group' }),
          },
          profilePicture: async (jid: string) => {
            profilePictureLookups.push(jid);
            return { profilePictureUrl: null };
          },
        },
      },
    } as any,
    { get: () => ({ BOT_CONTACT: false, MESSAGE_READ: false }) } as any,
    {} as any,
    {
      has: async (key: string) => cache.has(key),
      get: async (key: string) => cache.get(key),
      set: async (key: string, value: unknown) => void cache.set(key, value),
      delete: async (key: string) => void cache.delete(key),
    } as any,
  ) as any;
  service.logger = { error: () => undefined, warn: () => undefined, verbose: () => undefined };
  service.clientCw = async () => ({ provider, client });
  service.getInbox = async () => ({ id: 58 });

  return { service, client, profilePictureLookups };
};

test('canonical provider resolution ignores a stale conversation cache and reuses the inbox-scoped binding', async () => {
  const { service, client, profilePictureLookups } = serviceFixture(async () => null);
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true }) };
  const peer = '120363000000001@g.us';
  await service.cache.set(`${instance.instanceName}:createConversation-${peer}`, 999);
  service.findProviderContact = async () => ({ id: 9, identifier: peer });
  client.contacts.listConversations = async () => assert.fail('legacy first-conversation selection must not run');
  client.conversations.get = async () => assert.fail('legacy cached conversation must not be returned');
  const requests: any[] = [];
  service.providerConversationRequest = async (_provider: unknown, method: string, data: any) => {
    requests.push({ method, data });
    if (method === 'GET') return { enabled: true, provider: 'whatsapp' };
    return { id: 77, database_id: 901, contact_id: 9, inbox_id: 58, provider: 'whatsapp', peer };
  };
  assert.equal(await service.createConversation(instance, { key: { remoteJid: peer, fromMe: false } }), 77);
  assert.deepEqual(requests[1], {
    method: 'POST',
    data: { inbox_id: 58, contact_id: 9, provider: 'whatsapp', peer, aliases: [] },
  });
  assert.deepEqual(profilePictureLookups, []);
});

test('canonical provider resolution fails closed on a conflicting reply without creating a fallback conversation', async () => {
  const { service, client } = serviceFixture(async () => null);
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true }) };
  const peer = '120363000000001@g.us';
  service.findProviderContact = async () => ({ id: 9, identifier: peer });
  client.conversations.create = async () => assert.fail('conflicting writes must not fall back to legacy creation');
  service.providerConversationRequest = async (_provider: unknown, method: string) =>
    method === 'GET'
      ? { enabled: true, provider: 'whatsapp' }
      : { id: 77, database_id: 901, contact_id: 9, inbox_id: 59, provider: 'whatsapp', peer };
  assert.equal(await service.createConversation(instance, { key: { remoteJid: peer, fromMe: false } }), null);
});

test('canonical provider resolution supplies a verified native LID alias to the shared lock', async () => {
  const { service } = serviceFixture(async () => '628100000001@s.whatsapp.net');
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true }) };
  const peer = '628100000001@s.whatsapp.net';
  service.findProviderContact = async () => ({ id: 9, identifier: peer });
  let captured: any;
  service.providerConversationRequest = async (_provider: unknown, method: string, data: any) => {
    if (method === 'GET') return { enabled: true, provider: 'whatsapp' };
    captured = data;
    return { id: 77, database_id: 901, contact_id: 9, inbox_id: 58, provider: 'whatsapp', peer };
  };
  assert.equal(await service.createConversation(instance, { key: { remoteJid: '999999:7@lid', fromMe: false } }), 77);
  assert.deepEqual(captured.aliases, ['999999@lid']);
});

test('preserves canonical LID namespaces for ancillary Baileys lookups', () => {
  assert.equal(createJid('222@lid'), '222@lid');
  assert.equal(createJid('222@hosted.lid'), '222@hosted.lid');
});

test('canonical group reuse preserves a confirmed participant identity without downloading avatars', async () => {
  const { service, profilePictureLookups } = serviceFixture(async () => null);
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true }) };
  const peer = '120363000000001@g.us';
  const participant = '628100000001@s.whatsapp.net';
  const lookups: string[] = [];
  service.findProviderContact = async (_instance: unknown, identifier: string) => {
    lookups.push(identifier);
    return { id: identifier === peer ? 9 : 10, identifier, name: 'Preserved name' };
  };
  service.createContact = async () => assert.fail('existing group and participant must be reused');
  service.syncWhatsappGroupParticipants = async () => [];
  service.providerConversationRequest = async (_provider: unknown, method: string) =>
    method === 'GET'
      ? { enabled: true, provider: 'whatsapp' }
      : { id: 77, database_id: 901, contact_id: 9, inbox_id: 58, provider: 'whatsapp', peer };
  assert.equal(
    await service.createConversation(instance, {
      key: { remoteJid: peer, fromMe: false, participant: '999999:7@lid', participantAlt: participant },
      pushName: 'Provider author',
    }),
    77,
  );
  assert.deepEqual(lookups, [peer, participant]);
  assert.deepEqual(profilePictureLookups, []);
});

test('canonical group reuse creates a missing provisional participant with its LID and no invented phone', async () => {
  const { service, profilePictureLookups } = serviceFixture(async () => null);
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true }) };
  const peer = '120363000000001@g.us';
  service.findProviderContact = async (_instance: unknown, identifier: string) =>
    identifier === peer ? { id: 9, identifier: peer } : null;
  service.findContact = async () => assert.fail('unresolved LID must not be searched as a phone');
  let created: unknown[];
  service.createContact = async (...args: unknown[]) => {
    created = args;
    return { id: 10, identifier: '999999@lid' };
  };
  service.syncWhatsappGroupParticipants = async () => [];
  service.providerConversationRequest = async (_provider: unknown, method: string) =>
    method === 'GET'
      ? { enabled: true, provider: 'whatsapp' }
      : { id: 77, database_id: 901, contact_id: 9, inbox_id: 58, provider: 'whatsapp', peer };
  assert.equal(
    await service.createConversation(instance, {
      key: { remoteJid: peer, fromMe: false, participant: '999999:7@lid' },
      pushName: 'Provider author',
    }),
    77,
  );
  assert.deepEqual(created!.slice(1), ['999999', 58, false, 'Provider author', undefined, '999999@lid']);
  assert.deepEqual(profilePictureLookups, []);
});

test('creates a provisional LID contact when no phone mapping exists', async () => {
  const { service, profilePictureLookups } = serviceFixture(async () => null);
  const identifierLookups: string[] = [];
  const createdContacts: unknown[][] = [];
  service.findContact = async () => {
    throw new Error('phone lookup must not run for a provisional LID');
  };
  service.findContactByIdentifier = async (_instance: unknown, identifier: string) => {
    identifierLookups.push(identifier);
    return null;
  };
  service.createContact = async (...args: unknown[]) => {
    createdContacts.push(args);
    return { id: 9 };
  };

  const body = {
    key: {
      addressingMode: 'lid',
      remoteJid: '222:7@lid',
      fromMe: false,
    },
    pushName: 'LID contact',
  };

  assert.equal(await service.createConversation(instance, body), 77);
  assert.deepEqual(identifierLookups, ['222@lid']);
  assert.equal(createdContacts.length, 1);
  assert.equal(createdContacts[0][1], '222');
  assert.equal(createdContacts[0][6], '222@lid');
  assert.equal(body.key.remoteJidAlt, undefined);
  assert.deepEqual(profilePictureLookups, ['222@lid']);
});

test('reuses a provisional LID contact by its exact identifier', async () => {
  const { service } = serviceFixture(async () => null);
  const provisionalContact = { id: 9, name: 'LID contact', identifier: '222@lid', thumbnail: null };
  const identifierLookups: string[] = [];
  service.findContact = async () => {
    throw new Error('phone lookup must not run for a provisional LID');
  };
  service.findContactByIdentifier = async (_instance: unknown, identifier: string) => {
    identifierLookups.push(identifier);
    return provisionalContact;
  };
  service.createContact = async () => {
    throw new Error('an existing provisional contact must be reused');
  };

  assert.equal(
    await service.createConversation(instance, {
      key: { addressingMode: 'lid', remoteJid: '222:7@lid', fromMe: false },
      pushName: 'LID contact',
    }),
    77,
  );
  assert.deepEqual(identifierLookups, ['222@lid']);
});

test('uses the resolved phone JID and records it as remoteJidAlt', async () => {
  const resolvedPhoneJid = '628123@s.whatsapp.net';
  const resolvedLids: string[] = [];
  const { service } = serviceFixture(async (lid) => {
    resolvedLids.push(lid);
    return resolvedPhoneJid;
  });
  const phoneLookups: string[] = [];
  service.findContact = async (_instance: unknown, phoneNumber: string) => {
    phoneLookups.push(phoneNumber);
    return phoneLookups.length === 1 ? null : { id: 9, name: 'Contact', identifier: resolvedPhoneJid, thumbnail: null };
  };

  const body = {
    key: {
      addressingMode: 'lid',
      remoteJid: '222:7@lid',
      fromMe: false,
    },
    pushName: 'Resolved contact',
  };

  assert.equal(await service.createConversation(instance, body), 77);
  assert.deepEqual(resolvedLids, ['222:7@lid']);
  assert.equal(body.key.remoteJidAlt, resolvedPhoneJid);
  assert.deepEqual(phoneLookups, ['628123', '628123']);
});

test('does not synthesize a phone number for a provisional LID contact', async () => {
  const { service, client } = serviceFixture(async () => null);
  const createPayloads: any[] = [];
  const labeledContactIds: number[] = [];
  client.contacts.create = async ({ data }: any) => {
    createPayloads.push(data);
    return createPayloads.length === 1 ? { payload: { contact: { id: 21 } } } : { id: 22 };
  };
  service.findContact = async () => {
    throw new Error('created contact response should supply the label target');
  };
  service.findContactByIdentifier = async () => {
    throw new Error('created contact response should supply the label target');
  };
  service.addLabelToContact = async (_label: string, contactId: number) => {
    labeledContactIds.push(contactId);
    return true;
  };

  await service.createContact(instance, '222', 58, false, 'Provisional', null, '222@lid');
  await service.createContact(instance, '628123', 58, false, 'Phone', null, '628123@s.whatsapp.net');

  assert.equal(createPayloads[0].identifier, '222@lid');
  assert.equal('phone_number' in createPayloads[0], false);
  assert.equal(createPayloads[1].phone_number, '+628123');
  assert.deepEqual(labeledContactIds, [21, 22]);
});

test('uses a confirmed participantAlt phone JID for an incoming LID-addressed group', async () => {
  const { service, profilePictureLookups } = serviceFixture(async () => null);
  const phoneLookups: string[] = [];
  const identifierLookups: string[] = [];
  service.findContact = async (_instance: unknown, query: string) => {
    phoneLookups.push(query);
    if (query === '628123') return { id: 11, name: 'Participant', identifier: '628123@s.whatsapp.net' };
    if (query === '120363123@g.us') return { id: 12, name: 'Test group', identifier: '120363123@g.us' };
    return null;
  };
  service.findContactByIdentifier = async (_instance: unknown, identifier: string) => {
    identifierLookups.push(identifier);
    return null;
  };
  service.createContact = async () => {
    throw new Error('confirmed participant and group contacts should be reused');
  };

  assert.equal(
    await service.createConversation(instance, {
      key: {
        addressingMode: 'lid',
        remoteJid: '120363123@g.us',
        participant: '222@lid',
        participantAlt: '628123@s.whatsapp.net',
        fromMe: false,
      },
      pushName: 'Participant',
    }),
    77,
  );
  assert.deepEqual(phoneLookups, ['628123', '120363123@g.us']);
  assert.deepEqual(identifierLookups, []);
  assert.deepEqual(profilePictureLookups, ['628123@s.whatsapp.net', '120363123@g.us']);
});

test('preserves a provisional participant LID when a group has no confirmed participantAlt', async () => {
  const { service, profilePictureLookups } = serviceFixture(async () => null);
  const phoneLookups: string[] = [];
  const identifierLookups: string[] = [];
  service.findContact = async (_instance: unknown, query: string) => {
    phoneLookups.push(query);
    if (query === '120363123@g.us') return { id: 12, name: 'Test group', identifier: '120363123@g.us' };
    throw new Error(`unexpected phone lookup for ${query}`);
  };
  service.findContactByIdentifier = async (_instance: unknown, identifier: string) => {
    identifierLookups.push(identifier);
    return { id: 11, name: 'Participant', identifier };
  };
  service.createContact = async () => {
    throw new Error('existing provisional participant and group contacts should be reused');
  };

  assert.equal(
    await service.createConversation(instance, {
      key: {
        addressingMode: 'lid',
        remoteJid: '120363123@g.us',
        participant: '222@lid',
        fromMe: false,
      },
      pushName: 'Participant',
    }),
    77,
  );
  assert.deepEqual(identifierLookups, ['222@lid']);
  assert.deepEqual(phoneLookups, ['120363123@g.us']);
  assert.deepEqual(profilePictureLookups, ['222@lid', '120363123@g.us']);
});

test('reconciles a provisional LID contact after a trusted phone mapping appears', async () => {
  const { service } = serviceFixture(async () => null);
  const updatedContacts: unknown[][] = [];
  const removedLabels: number[] = [];
  let phoneIdentifierReads = 0;
  service.findContactByIdentifier = async (_instance: unknown, identifier: string) => {
    if (identifier === '222@lid') return { id: 9, identifier };
    if (identifier === '628123@s.whatsapp.net') {
      phoneIdentifierReads += 1;
      return phoneIdentifierReads === 1 ? null : { id: 9, identifier };
    }
    return null;
  };
  service.findContact = async () => null;
  service.updateContact = async (...args: unknown[]) => {
    updatedContacts.push(args);
    return { id: 9 };
  };
  service.removeUnresolvedLidLabel = async (contactId: number) => {
    removedLabels.push(contactId);
  };

  assert.deepEqual(await service.reconcileLidIdentity(instance, '222:7@lid', '628123@s.whatsapp.net'), {
    status: 'updated',
  });
  assert.equal(updatedContacts.length, 1);
  assert.deepEqual(updatedContacts[0].slice(1), [9, { identifier: '628123@s.whatsapp.net', phone_number: '+628123' }]);
  assert.deepEqual(removedLabels, [9]);
});

test('provider contact lookup uses exact phone equality without legacy Brazilian merging', async () => {
  const { service, client } = serviceFixture(async () => null);
  service.findContact = async () => assert.fail('legacy phone matching and merging must not run');
  const filters: any[] = [];
  client.contacts.filter = async (query: any) => {
    filters.push(query.payload[0]);
    return query.payload[0].attribute_key === 'identifier'
      ? { payload: [], meta: { count: 0 } }
      : { payload: [{ id: 9, phone_number: '+551100000001', identifier: 'legacy-contact' }], meta: { count: 1 } };
  };
  const found = await service.findProviderContact(instance, '551100000001@s.whatsapp.net');
  assert.equal(found.id, 9);
  assert.deepEqual(
    filters.map((item) => [item.attribute_key, item.filter_operator, item.values]),
    [
      ['identifier', 'equal_to', ['551100000001@s.whatsapp.net']],
      ['phone_number', 'equal_to', ['+551100000001']],
    ],
  );
});

test('provider contact lookup rejects ambiguous phones, contradictory JIDs and incomplete filters', async () => {
  const { service, client } = serviceFixture(async () => null);
  const peer = '551100000001@s.whatsapp.net';
  for (const response of [
    {
      payload: [
        { id: 9, phone_number: '+551100000001' },
        { id: 10, phone_number: '+551100000001' },
      ],
    },
    { payload: [{ id: 9, phone_number: '+551100000001', identifier: '999999@lid' }] },
    { payload: [{ id: 9, phone_number: '+551100000001' }], meta: { count: 2 } },
    { payload: [{ id: 9, phone_number: '+551100000009' }] },
  ]) {
    client.contacts.filter = async (query: any) =>
      query.payload[0].attribute_key === 'identifier' ? { payload: [] } : response;
    await assert.rejects(service.findProviderContact(instance, peer));
  }
});

test('canonical group resolution stops when participant contact creation has no proven identity', async () => {
  const { service } = serviceFixture(async () => null);
  const peer = '120363000000001@g.us';
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true }) };
  service.findProviderContact = async (_instance: unknown, id: string) =>
    id === peer ? { id: 9, identifier: peer } : null;
  service.syncWhatsappGroupParticipants = async () =>
    assert.fail('unproven author must not report successful resolution');
  service.providerConversationRequest = async (_provider: unknown, method: string) =>
    method === 'GET'
      ? { enabled: true, provider: 'whatsapp' }
      : { id: 77, database_id: 901, contact_id: 9, inbox_id: 58, provider: 'whatsapp', peer };
  for (const response of [null, { id: 10 }, { id: 10, identifier: 'different@lid' }]) {
    service.createContact = async () => response;
    assert.equal(
      await service.createConversation(instance, {
        key: { remoteJid: peer, fromMe: false, participant: '999999@lid' },
      }),
      null,
    );
  }
});
