import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import axios from 'axios';

test('sendAttachment excludes signed URL metadata and retains the validated response MIME', async (t) => {
  const serverModulePath = require.resolve('../src/api/server.module.ts');
  const previousServerModule = require.cache[serverModulePath];
  require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  t.after(() => {
    if (previousServerModule) require.cache[serverModulePath] = previousServerModule;
    else delete require.cache[serverModulePath];
  });

  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service = Object.create(ChatwootService.prototype) as InstanceType<typeof ChatwootService>;
  const sentMedia: Array<{ fileName?: string; mimetype?: string }> = [];
  const waInstance = {
    mediaMessage: async (data: { fileName?: string; mimetype?: string }) => {
      sentMedia.push(data);
      return { key: { id: 'planned-waid' } };
    },
  };

  mock.method(axios, 'get', async () => ({ headers: { 'content-type': 'application/pdf; charset=binary' } }));
  mock.method(axios, 'post', async () => ({}));

  for (const mediaUrl of [
    'https://cdn.example.test/download?signature=QUERYSECRET',
    'https://cdn.example.test/download#fragment/PATHFRAGMENTSECRET',
    'https://cdn.example.test/archive.unknown?signature=QUERYSECRET#FRAGMENTSECRET',
  ]) {
    await service.sendAttachment(waInstance, '628123@s.whatsapp.net', mediaUrl);
  }

  const sentMetadata = sentMedia.map(({ fileName, mimetype }) => ({ fileName, mimetype }));
  assert.deepEqual(sentMetadata, [
    { fileName: 'download', mimetype: 'application/pdf' },
    { fileName: 'download', mimetype: 'application/pdf' },
    { fileName: 'archive.unknown', mimetype: 'application/pdf' },
  ]);
  assert.doesNotMatch(JSON.stringify(sentMetadata), /QUERYSECRET|PATHFRAGMENTSECRET|FRAGMENTSECRET/);
});

test('sync and queued caption replies retain mentions through actual media sender and reject removed recipients', async (t) => {
  const serverModulePath = require.resolve('../src/api/server.module.ts');
  const previous = require.cache[serverModulePath];
  require.cache[serverModulePath] = {
    id: serverModulePath, filename: serverModulePath, loaded: true,
    exports: new Proxy({}, { get: () => ({}) }), children: [], paths: [],
  } as NodeModule;
  t.after(() => { if (previous) require.cache[serverModulePath] = previous; else delete require.cache[serverModulePath]; });
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const { BaileysStartupService } = require('../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');
  const service: any = Object.create(ChatwootService.prototype);
  const wa: any = Object.create(BaileysStartupService.prototype);
  const peer = '120363000000@g.us';
  const jid = '90001@lid';
  const quote = { key: { id: 'original', remoteJid: peer }, message: { conversation: 'original' } };
  service.logger = wa.logger = { verbose() {}, error() {} };
  service.getQuotedMessage = async () => quote;
  wa.instance = { id: 'synthetic-instance' };
  Object.defineProperty(wa, 'connectionStatus', { value: { state: 'open' } });
  wa.whatsappNumber = async () => [{ exists: true, jid: peer }];
  wa.configService = { get: () => ({ REDIS: { ENABLED: true }, LOCAL: { ENABLED: true } }) };
  wa.getGroupMetadataCache = async () => assert.fail('must refresh recipients');
  wa.prepareMediaMessage = async (data: any) => ({ message: { imageMessage: { caption: data.caption } } });
  let participants = [{ id: jid }];
  let reads = 0;
  let sent = 0;
  wa.client = {
    presenceSubscribe: async () => {}, sendPresenceUpdate: async () => {},
    groupMetadata: async (destination: string) => { assert.equal(destination, peer); reads++; return { participants }; },
  };
  wa.sendMessage = async (destination: string, message: any, options: any) => {
    sent++;
    assert.equal(destination, peer);
    assert.equal(message.imageMessage.caption, 'Hi @90001');
    assert.deepEqual(options.mentions, [jid]);
    assert.equal(options.quoted, quote);
    assert.equal(options.messageId, 'planned-waid');
    throw new Error('synthetic native boundary');
  };
  t.mock.method(axios, 'post', async () => ({}));
  const operation = {
    instanceId: 'synthetic-instance', operationKey: 'synthetic-operation', plannedWhatsappMessageId: 'planned-waid',
    payload: { chatId: peer, attachmentUrl: 'https://cdn.example.test/photo.jpg', text: 'Hi @90001', mentioned: [jid],
      origin: { messageId: 42, inboxId: 9, conversationId: 12 }, quotedWhatsappMessageId: 'original' },
  };
  const send = (queued: boolean) => queued
    ? service.sendQueuedOutbound(operation, { instance: { instanceId: 'synthetic-instance' }, waInstance: wa }, async () => {}, new AbortController().signal)
    : service.sendAttachment(wa, peer, operation.payload.attachmentUrl, operation.payload.text, { quoted: quote, mentioned: [jid], messageId: 'planned-waid' });
  for (const queued of [false, true]) {
    participants = [{ id: jid }];
    await assert.rejects(send(queued), (error: any) => JSON.stringify(error).includes('synthetic native boundary'));
    participants = [];
    await assert.rejects(send(queued), (error: any) => JSON.stringify(error).includes('not a current group participant'));
  }
  assert.equal(reads, 4);
  assert.equal(sent, 2);
});
