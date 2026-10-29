import assert from 'node:assert/strict';
import test from 'node:test';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import fs from 'node:fs';
import ts from 'typescript';
import * as names from '../src/utils/whatsapp-contact-name';
import * as history from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import { incomingWhatsappName, replaceableWhatsappName, whatsappProfileName } from '../src/utils/whatsapp-contact-name';

const peer = '628100000001@s.whatsapp.net';
const message = (fromMe: boolean | undefined, pushName: string) => ({ key: { fromMe, remoteJid: peer }, pushName });

test('whole live provider path uses peer profile for outbound-first contact and heals only exact placeholder peer', async () => {
  const source = fs.readFileSync('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', 'utf8');
  const file = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const method = file.statements
    .find(ts.isClassDeclaration)!
    .members.find((m) => m.name?.getText(file) === 'canonicalProviderConversation')!
    .getText(file);
  const deps = { ...names, ...history };
  const service: any = new Function(
    ...Object.keys(deps),
    ts.transpile('return new class {' + method + '}()', { target: ts.ScriptTarget.ES2022 }),
  )(...Object.values(deps));
  const queries: any[] = [],
    created: any[] = [],
    updates: any[] = [];
  let contact: any = null;
  service.findProviderContact = async () => contact;
  service.prismaRepository = {
    contact: {
      findFirst: async (query: any) => {
        queries.push(query);
        return { pushName: 'Saved Profile' };
      },
    },
  };
  service.createContact = async (...args: any[]) => {
    created.push(args);
    return { id: 42 };
  };
  service.updateContact = async (...args: any[]) => updates.push(args);
  service.providerConversationRequest = async () => ({
    id: 9,
    database_id: 9,
    contact_id: 42,
    inbox_id: 2,
    provider: 'whatsapp',
    peer,
  });
  const provider = { instanceId: 'instance-only' };
  assert.equal(await service.canonicalProviderConversation({}, provider, 2, peer, message(true, 'Office Agent')), 9);
  assert.equal(created[0][4], 'Saved Profile');
  assert.deepEqual(queries[0], { where: { instanceId: 'instance-only', remoteJid: peer }, select: { pushName: true } });
  contact = { id: 42, identifier: peer, name: 'Você' };
  await service.canonicalProviderConversation({}, provider, 2, peer, message(false, 'Incoming Profile'));
  assert.deepEqual(updates[0][2], { name: 'Incoming Profile' });
  assert.equal(queries.length, 1);
  contact.name = 'Manual name';
  await service.canonicalProviderConversation({}, provider, 2, peer, message(false, 'Changed Profile'));
  contact = { id: 42, identifier: 'telegram:123', name: 'Você' };
  await service.canonicalProviderConversation({}, provider, 2, peer, message(false, 'Changed Profile'));
  assert.equal(updates.length, 1);
});

test('history peer name never comes from outgoing sender, unknown direction or Você placeholder', () => {
  const rows = [
    message(true, 'Você'),
    message(true, 'Office Agent'),
    message(undefined, 'Unknown sender'),
    message(false, 'Você'),
    message(false, 'Client Profile'),
  ];
  const identity = (chatwootImport as any).getHistoryIdentity(peer, rows, { first: 1, last: 2 }, new Map());
  assert.equal(identity.name, 'Client Profile');
  assert.equal(identity.identifier, peer);
  assert.equal(identity.phoneNumber, '+628100000001');
  assert.equal((chatwootImport as any).getHistoryIdentity(peer, rows.slice(0, 4), {}, new Map()).name, '628100000001');
});

test('LID without incoming name is explicitly provisional; group names do not come from participant pushName', () => {
  const rows = [message(true, 'Agent')];
  const lid = (chatwootImport as any).getHistoryIdentity('987654321@lid', rows, {}, new Map(), 'Você');
  assert.equal(lid.name, 'WhatsApp LID 654321');
  assert.equal(lid.phoneNumber, null);
  const group = (chatwootImport as any).getHistoryIdentity(
    '123456@g.us',
    [message(false, 'Member')],
    {},
    new Map([['123456@g.us', 'Team']]),
  );
  assert.equal(group.name, 'Team (GROUP)');
});

test('profile notify wins over office address book and invalid candidates never become profile names', () => {
  assert.equal(
    whatsappProfileName({ notify: 'Profile', name: 'Office nickname', verifiedName: 'Business' }),
    'Profile',
  );
  assert.equal(whatsappProfileName({ notify: ' Você ', name: 'Address book' }), 'Address book');
  assert.equal(whatsappProfileName({ notify: '', name: 'voce', verifiedName: 'Business' }), 'Business');
  assert.equal(incomingWhatsappName(message(true, 'Agent')), undefined);
  assert.equal(incomingWhatsappName(message(false, '  Profile  ')), 'Profile');
});

test('automatic refresh preserves manually supplied real names', () => {
  for (const name of ['', null, 'Você', 'Voce', '628100000001', '+628100000001'])
    assert.equal(replaceableWhatsappName(name, '628100000001'), true);
  for (const name of ['Manual Customer', 'Você Travel', 'Alice'])
    assert.equal(replaceableWhatsappName(name, '628100000001'), false);
});

test('actual contact create/update boundary excludes placeholders without changing groups or other fields', async () => {
  const source = fs.readFileSync('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', 'utf8');
  const file = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const klass = file.statements.find(ts.isClassDeclaration)!;
  const methods = klass.members
    .filter((m) => ['createContact', 'updateContact'].includes(m.name?.getText(file) || ''))
    .map((m) => m.getText(file))
    .join('\n');
  const code = ts.transpile('return new class {' + methods + '}()', { target: ts.ScriptTarget.ES2022 });
  const service: any = new Function('whatsappContactName', code)(names.whatsappContactName);
  const calls: any[] = [];
  service.clientCw = async () => ({
    provider: { accountId: '1', nameInbox: 'test' },
    client: {
      contacts: {
        create: async (request: any) => {
          calls.push(request);
          return { id: 42 };
        },
        update: async (request: any) => {
          calls.push(request);
          return { id: 42 };
        },
      },
    },
  });
  service.configService = { get: () => ({}) };
  service.addLabelToContact = async () => {};
  service.logger = { warn() {}, error() {} };
  await service.createContact({}, '628100000001', 2, false, 'Você', undefined, peer);
  assert.equal(calls[0].data.name, '628100000001');
  await service.updateContact({}, 42, { name: 'Você', avatar_url: 'synthetic' });
  assert.deepEqual(calls[1].data, { avatar_url: 'synthetic' });
  await service.createContact({}, '123@g.us', 2, true, 'Você (GROUP)');
  assert.equal(calls[2].data.name, 'Você (GROUP)');
  assert.equal(calls[0].accountId, 1);
});
