import assert from 'node:assert/strict';
import test from 'node:test';

import { fromMeOrigin, recordApiSentMessage } from '../src/api/integrations/channel/whatsapp/api-sent-messages';

// Keep the transport fixture inert even when the local lab has Redis configured.
const serverModulePath = require.resolve('../src/api/server.module.ts');
require.cache[serverModulePath] = {
  id: serverModulePath, filename: serverModulePath, loaded: true,
  exports: new Proxy({}, { get: () => ({}) }), children: [], paths: [],
} as NodeModule;
const { BaileysStartupService } = require('../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');

const fakeRepository = () => {
  const rows = new Set<string>();
  return {
    rows,
    apiSentMessage: {
      createMany: async ({ data }: any) => data.forEach((row: any) => rows.add(`${row.instanceId}|${row.messageId}`)),
      findUnique: async ({ where }: any) => {
        const { instanceId, messageId } = where.instanceId_messageId;
        return rows.has(`${instanceId}|${messageId}`) ? { messageId } : null;
      },
    },
  };
};

test('a recorded id is api, any other fromMe id (phone, WA Web, other linked devices) is native', async () => {
  const repository = fakeRepository();
  await recordApiSentMessage(repository, 'inst-1', '3EB0SYNTHETICAPI');
  await recordApiSentMessage(repository, 'inst-1', '3EB0SYNTHETICAPI'); // retries are idempotent
  assert.equal(await fromMeOrigin(repository, 'inst-1', '3EB0SYNTHETICAPI'), 'api');
  for (const id of ['3A0SYNTHETICIOS', '3EB0SYNTHETICWEB', 'BAE5SYNTHETICDESKTOP']) {
    assert.equal(await fromMeOrigin(repository, 'inst-1', id), 'native');
  }
  // Another instance never inherits the record.
  assert.equal(await fromMeOrigin(repository, 'inst-2', '3EB0SYNTHETICAPI'), 'native');
  assert.equal(await fromMeOrigin(repository, 'inst-1', ''), null);
  assert.equal(await fromMeOrigin(repository, undefined, '3EB0SYNTHETICAPI'), null);
});

test('an API send records its planned id before transport, so an echo during transport is already api', async () => {
  const repository = fakeRepository();
  const wa: any = Object.create(BaileysStartupService.prototype);
  const peer = '628111111111@s.whatsapp.net';
  let echoOrigin: string | null = null;
  wa.instance = { id: 'inst-1', name: 'synthetic' };
  wa.prismaRepository = repository;
  wa.whatsappNumber = async () => [{ exists: true, jid: peer }];
  wa.logger = { verbose() {}, debug() {}, error() {} };
  wa.client = {
    user: { id: '628000000000:1@s.whatsapp.net' },
    sendMessage: async (_sender: string, _message: any, options: any) => {
      assert.ok(options.messageId, 'the id is planned before transport');
      echoOrigin = await fromMeOrigin(repository, 'inst-1', options.messageId); // Baileys emits its upsert here
      return { key: { id: options.messageId, fromMe: true, remoteJid: peer }, messageTimestamp: 1 };
    },
  };
  wa.prepareMessage = () => {
    throw new Error('stop after transport');
  };
  await assert.rejects(wa.sendMessageWithTyping(peer, { conversation: 'synthetic' }));
  assert.equal(echoOrigin, 'api');
  assert.equal(repository.rows.size, 1);
});

test('a Chatwoot (integration) send is not recorded as api and keeps its own planned id', async () => {
  const repository = fakeRepository();
  const wa: any = Object.create(BaileysStartupService.prototype);
  const peer = '628111111111@s.whatsapp.net';
  wa.instance = { id: 'inst-1', name: 'synthetic' };
  wa.prismaRepository = repository;
  wa.whatsappNumber = async () => [{ exists: true, jid: peer }];
  wa.logger = { verbose() {}, debug() {}, error() {} };
  wa.client = {
    sendMessage: async (_sender: string, _message: any, options: any) => {
      assert.equal(options.messageId, 'CWPLANNED1');
      return { key: { id: 'CWPLANNED1', fromMe: true, remoteJid: peer }, messageTimestamp: 1 };
    },
  };
  wa.prepareMessage = () => {
    throw new Error('stop after transport');
  };
  await assert.rejects(wa.sendMessageWithTyping(peer, { conversation: 'synthetic' }, { messageId: 'CWPLANNED1' }, true));
  assert.equal(repository.rows.size, 0);
});

test('a failed record never blocks the send', async () => {
  const wa: any = Object.create(BaileysStartupService.prototype);
  const peer = '628111111111@s.whatsapp.net';
  let sent = false;
  wa.instance = { id: 'inst-1', name: 'synthetic' };
  wa.prismaRepository = { apiSentMessage: { createMany: async () => { throw new Error('db down'); } } };
  wa.whatsappNumber = async () => [{ exists: true, jid: peer }];
  wa.logger = { verbose() {}, debug() {}, error() {} };
  wa.client = { sendMessage: async (_s: string, _m: any, options: any) => { sent = true; return { key: { id: options.messageId, fromMe: true, remoteJid: peer } }; } };
  wa.prepareMessage = () => {
    throw new Error('stop after transport');
  };
  await assert.rejects(wa.sendMessageWithTyping(peer, { conversation: 'synthetic' }));
  assert.equal(sent, true);
});

test('the Chatwoot ingress stamp carries origin only for fromMe and never fails delivery', async () => {
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service: any = Object.create(ChatwootService.prototype);
  const repository = fakeRepository();
  await recordApiSentMessage(repository, 'inst-1', '3EB0SYNTHETICAPI');
  service.prismaRepository = repository;
  service.waMonitor = { waInstances: { synthetic: { instanceId: 'inst-1' } } };
  service.logger = { warn() {} };
  const instance = { instanceName: 'synthetic' };
  const body = (id: string, fromMe: boolean) => ({ key: { id, fromMe, remoteJid: '120363000000@g.us' } });

  assert.equal(await service.ingressOrigin(instance, body('3EB0SYNTHETICAPI', true)), 'api');
  assert.equal(await service.ingressOrigin(instance, body('3A0SYNTHETICPHONE', true)), 'native');
  assert.equal(await service.ingressOrigin(instance, body('3EB0SYNTHETICAPI', false)), null);
  service.prismaRepository = { apiSentMessage: { findUnique: async () => { throw new Error('db down'); } } };
  assert.equal(await service.ingressOrigin(instance, body('3EB0SYNTHETICAPI', true)), null);
});
