import test from 'node:test';
import assert from 'node:assert/strict';
import {
  originalWhatsappTimestamp,
  whatsappEditAllowed,
  ORIGINAL_WHATSAPP_TIMESTAMP,
} from '../src/api/integrations/channel/whatsapp/whatsapp-edit-restrictions';

test('WhatsApp uses seconds and the original send time; repeats do not extend 15 minutes', () => {
  const message = { key: { fromMe: true }, messageTimestamp: 1000 };
  assert.equal(whatsappEditAllowed(message, originalWhatsappTimestamp(message, false), 1720), true);
  assert.equal(whatsappEditAllowed(message, originalWhatsappTimestamp(message, false), 1900), false);
  const edited = { ...message, messageTimestamp: 1850, contextInfo: { [ORIGINAL_WHATSAPP_TIMESTAMP]: 1000 } };
  assert.equal(whatsappEditAllowed(edited, originalWhatsappTimestamp(edited, true), 1900), false);
  assert.equal(originalWhatsappTimestamp({ ...message, messageTimestamp: 1850 }, true), null);
  assert.equal(originalWhatsappTimestamp(message, true, new Date(1000 * 1000)), 1000);
});

test('missing, future, incoming and deleted source proof reject before sending', () => {
  for (const message of [{}, { key: { fromMe: false } }, { key: { fromMe: true, deleted: true } }]) {
    assert.equal(whatsappEditAllowed(message, 1000, 1100), false);
  }
  assert.equal(whatsappEditAllowed({ key: { fromMe: true } }, null, 1100), false);
  assert.equal(whatsappEditAllowed({ key: { fromMe: true } }, 1200, 1100), false);
});

test('actual native sender rejects expired edits before send and preserves original time for allowed extended text edits', async (t) => {
  const serverModulePath = require.resolve('../src/api/server.module.ts');
  const previous = require.cache[serverModulePath];
  require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  t.after(() => {
    if (previous) require.cache[serverModulePath] = previous;
    else delete require.cache[serverModulePath];
  });
  const { BaileysStartupService } = require('../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');
  const service = Object.create(BaileysStartupService.prototype) as any;
  service.instance = { id: 'synthetic' };
  service.configService = {
    get: (key: string) =>
      key === 'DATABASE' ? { SAVE_DATA: { NEW_MESSAGE: true, MESSAGE_UPDATE: true } } : { ENABLED: false },
  };
  service.logger = { error() {} };
  const key = { id: 'synthetic-message', remoteJid: '123@s.whatsapp.net', fromMe: true };
  const originalTime = Math.floor(Date.now() / 1000) - 12 * 60;
  const source = {
    id: 'source',
    key,
    messageTimestamp: originalTime,
    messageType: 'extendedTextMessage',
    message: { extendedTextMessage: { text: 'before' } },
  };
  service.getMessage = async () => source;
  service.formatUpdateMessage = async () => ({ text: 'edited' });
  service.sendDataWebhook = async () => {};
  let sent = 0;
  let persisted: any;
  service.client = {
    sendMessage: async () => {
      sent++;
      return { key, message: { protocolMessage: { key, editedMessage: { extendedTextMessage: { text: 'edited' } } } } };
    },
  };
  service.prismaRepository = {
    messageUpdate: { findFirst: async () => null, create: async () => {} },
    message: {
      findFirst: async () => source,
      update: async ({ data }: any) => {
        persisted = data;
        return { ...source, ...data };
      },
    },
  };
  await service.updateMessage({ number: '123', key, text: 'edited' });
  assert.equal(sent, 1);
  assert.equal(persisted.message.extendedTextMessage.text, 'edited');
  assert.equal(persisted.contextInfo[ORIGINAL_WHATSAPP_TIMESTAMP], originalTime);
  assert.equal(persisted.messageTimestamp, undefined);
  source.messageTimestamp = Math.floor(Date.now() / 1000) - 16 * 60;
  await assert.rejects(service.updateMessage({ number: '123', key, text: 'too late' }), (error: any) =>
    error.message.includes('whatsapp_edit_time_expired'),
  );
  assert.equal(sent, 1);
});
