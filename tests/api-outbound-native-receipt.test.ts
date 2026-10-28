import assert from 'node:assert/strict';
import test from 'node:test';
// Keep the transport fixture inert even when the local lab has Redis configured.
const serverModulePath = require.resolve('../src/api/server.module.ts');
require.cache[serverModulePath] = {
  id: serverModulePath, filename: serverModulePath, loaded: true,
  exports: new Proxy({}, { get: () => ({}) }), children: [], paths: [],
} as NodeModule;
const { BaileysStartupService } = require('../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');

test('native Baileys fences the actual peer and commits its planned receipt before history fails', async () => {
  const wa: any = Object.create(BaileysStartupService.prototype);
  const peer = '628111111111@s.whatsapp.net', messageId = 'WNSYNTHETICRECEIPT';
  const stages: string[] = [];
  wa.whatsappNumber = async () => [{ exists: true, jid: peer }];
  wa.logger = { verbose() {}, debug() {}, error() {} };
  wa.client = { sendMessage: async (sender: string, message: any, options: any) => {
    assert.equal(sender, peer); assert.equal(options.messageId, messageId);
    assert.equal(message.text, 'synthetic'); stages.push('transport');
    return { key: { id: messageId, fromMe: true, remoteJid: peer }, messageTimestamp: 1 };
  } };
  wa.prepareMessage = () => { stages.push('history'); throw new Error('synthetic history failure'); };
  await assert.rejects(wa.sendMessageWithTyping(peer, { conversation: 'synthetic' }, {
    messageId,
    beforeTransport: async (destination: string) => { assert.equal(destination, peer); stages.push('fence'); },
    afterTransport: async (receipt: any) => { assert.equal(receipt.key.id, messageId); stages.push('receipt'); },
  }));
  assert.deepEqual(stages, ['fence', 'transport', 'receipt', 'history']);
});

test('mentions refresh the exact group roster before text/caption replies and reject removed members before transport', async () => {
  const wa: any = Object.create(BaileysStartupService.prototype);
  const peer = '120363000000@g.us';
  const member = '90001@lid';
  wa.whatsappNumber = async () => [{ exists: true, jid: peer }];
  wa.logger = { verbose() {}, error() {} };
  wa.configService = { get: () => ({ REDIS: { ENABLED: true }, LOCAL: { ENABLED: true } }) };
  wa.getGroupMetadataCache = async () => assert.fail('Must not trust cached membership');
  let participants = [{ id: member, phoneNumber: '628111@s.whatsapp.net' }];
  let reads = 0;
  let sent = 0;
  wa.client = { groupMetadata: async (jid: string) => { assert.equal(jid, peer); reads++; return { participants }; } };
  const quote = { key: { id: 'original', remoteJid: peer }, message: { conversation: 'original' } };
  wa.sendMessage = async (_peer: string, message: any, options: any) => {
    sent++;
    assert.deepEqual(options.mentions, [member]);
    assert.equal(options.quoted, quote);
    assert.match(message.conversation || message.imageMessage.caption, /@90001/);
    throw new Error('synthetic transport boundary');
  };
  for (const message of [{ conversation: 'Hi @90001' }, { imageMessage: { caption: 'Hi @90001' } }]) {
    await assert.rejects(wa.sendMessageWithTyping(peer, message, { mentioned: [member], quoted: quote }), (error: any) => JSON.stringify(error).includes('synthetic transport boundary'));
  }
  participants = [];
  await assert.rejects(wa.sendMessageWithTyping(peer, { conversation: 'Hi @90001' }, { mentioned: [member] }), (error: any) => JSON.stringify(error).includes('not a current group participant'));
  assert.equal(reads, 3);
  assert.equal(sent, 2);
});
