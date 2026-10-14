import assert from 'node:assert/strict';
import test from 'node:test';
import { BaileysStartupService } from '@api/integrations/channel/whatsapp/whatsapp.baileys.service';

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
