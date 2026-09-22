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

test('preserves canonical LID namespaces for ancillary Baileys lookups', () => {
  assert.equal(createJid('222@lid'), '222@lid');
  assert.equal(createJid('222@hosted.lid'), '222@hosted.lid');
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
