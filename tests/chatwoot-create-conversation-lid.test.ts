import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';

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
  const client = {
    contacts: {
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
          profilePicture: async () => ({ profilePictureUrl: null }),
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

  return { service, client };
};

test('creates and reuses a provisional LID contact when no phone mapping exists', async () => {
  const { service } = serviceFixture(async () => null);
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
  client.contacts.create = async ({ data }: any) => {
    createPayloads.push(data);
    return { id: createPayloads.length };
  };
  service.findContact = async () => null;
  service.addLabelToContact = async () => true;

  await service.createContact(instance, '222', 58, false, 'Provisional', null, '222@lid');
  await service.createContact(instance, '628123', 58, false, 'Phone', null, '628123@s.whatsapp.net');

  assert.equal(createPayloads[0].identifier, '222@lid');
  assert.equal('phone_number' in createPayloads[0], false);
  assert.equal(createPayloads[1].phone_number, '+628123');
});
