import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { findNativeMessageByKey } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-native-message-key';

const servicePath = '../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts';
test('actual group edit/reaction/reply methods scope colliding provider IDs to target peer/direction', async (t) => {
  const modulePath = require.resolve('../src/api/server.module.ts');
  const previous = require.cache[modulePath];
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true,
    exports: new Proxy({}, { get: () => ({}) }), children: [], paths: [] } as NodeModule;
  t.after(() => { if (previous) require.cache[modulePath] = previous; else delete require.cache[modulePath]; });
  const { ChatwootService } = require(servicePath);
  const service = Object.create(ChatwootService.prototype) as any;
  const instance = { instanceName: 'synthetic', instanceId: 'instance-1' };
  const peer = '120363000000001@g.us';
  const otherPeer = '120363000000002@g.us';
  const rows = [peer, otherPeer].flatMap((remoteJid, i) => [false, true].map((fromMe, j) => ({
    id: `${i}-${j}`, instanceId: 'instance-1', key: { id: 'SAME', remoteJid, fromMe }, messageType: 'conversation',
    message: { conversation: 'Synthetic' }, chatwootMessageId: 100 + i * 10 + j,
    chatwootConversationId: 40 + i, chatwootInboxId: 42, chatwootContactInboxSourceId: 'ci',
  })));
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: false }) };
  service.waMonitor = { waInstances: { synthetic: {} } };
  service.clientCw = async () => ({ client: {}, provider: { accountId: '1', ignoreJids: [] } });
  service.logger = { info() {}, warn() {}, error(error: Error) { throw error; } };
  service.prismaRepository = { $queryRaw: async (sql: any) => rows.filter((row) =>
    row.key.id === sql.values[1] && (!sql.text.includes("key->>'remoteJid'") || row.key.remoteJid === sql.values[2]) &&
    (!sql.text.includes("key->>'fromMe'") || String(row.key.fromMe) === sql.values[3])) };
  const requests: any[] = [];
  service.privilegedChatwootRequest = async (_provider: any, request: any) => requests.push(request);
  for (const fromMe of [false, true]) {
    await service.eventWhatsapp('messages.edit', instance, { key: { id: 'SAME', remoteJid: peer, fromMe },
      editedMessage: { conversation: 'Updated synthetic' } });
    assert.match(requests.at(-1).path, new RegExp(`/conversations/40/messages/${fromMe ? 101 : 100}/edit$`));
  }
  await service.applyNativeChatwootReaction(instance, 999, { key: { remoteJid: otherPeer, fromMe: true }, pushName: 'Synthetic' },
    { key: { id: 'SAME', remoteJid: peer, fromMe: false }, text: '👍' });
  assert.match(requests.at(-1).path, /\/conversations\/40\/messages\/100\/react$/);
  const before = requests.length;
  await assert.rejects(service.eventWhatsapp('messages.edit', instance, { key: { id: 'SAME' },
    editedMessage: { conversation: 'Ambiguous' } }));
  assert.equal(requests.length, before);
  let replyScope: any;
  service.getMessageByKeyId = async (_instance: any, _id: string, scope: any) => { replyScope = scope; return null; };
  await service.getReplyToIds({ key: { remoteJid: peer, fromMe: true },
    message: { extendedTextMessage: { contextInfo: { stanzaId: 'SAME', quotedMessage: { conversation: 'Synthetic' } } } } }, instance);
  assert.deepEqual(replyScope, { remoteJid: peer });
  assert.equal(await findNativeMessageByKey(service.prismaRepository, 'instance-1', 'SAME'), null);
});

test('read/delete wiring passes full event key; deletion only drops exact native peer/direction mappings', () => {
  const source = fs.readFileSync(require.resolve(servicePath), 'utf8');
  const ast = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const klass = ast.statements.find(ts.isClassDeclaration)!;
  const event = klass.members.find((member) => member.name?.getText(ast) === 'processWhatsappEvent')!.getText(ast);
  const deleteStart = event.indexOf('if (event === Events.MESSAGES_DELETE)');
  const deleteBranch = event.slice(deleteStart, event.indexOf("if (event === 'messages.edit'", deleteStart));
  const readBranch = event.slice(event.indexOf("if (event === 'messages.read')"));
  for (const branch of [deleteBranch, readBranch])
    assert.match(branch, /getMessageByKeyId\(instance, body\.key\.id, body\.key\)/);
  assert.match(deleteBranch, /path: \['remoteJid'\], equals: \(message\.key as WAMessageKey\)\.remoteJid/);
  assert.match(deleteBranch, /path: \['fromMe'\], equals: \(message\.key as WAMessageKey\)\.fromMe/);
});
