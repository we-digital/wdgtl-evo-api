import assert from 'node:assert/strict';
import test from 'node:test';

const content = 'Distinct caption\nsecond line';

const serverPath = require.resolve('../src/api/server.module.ts');
require.cache[serverPath] = {
  id: serverPath,
  filename: serverPath,
  loaded: true,
  exports: new Proxy({}, { get: () => ({}) }),
  children: [],
  paths: [],
} as NodeModule;
const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');

for (const [media, caption] of [[false, content], [true, content], [true, ""]] as const) {
  test(`live ${media ? (caption ? 'media' : 'captionless media') : 'text'} group branch keeps source identity and distinct content`, async () => {
    for (const fromMe of [false, true]) {
      const source = {
        key: { id: 'SYNTHETIC_SOURCE', remoteJid: '120363000000001@g.us', fromMe },
        pushName: 'Synthetic sender',
        messageType: media ? 'imageMessage' : 'conversation',
        message: media ? { imageMessage: { caption } } : { conversation: caption },
      };
      const before = JSON.stringify(source);
      const service = Object.create(ChatwootService.prototype) as any;
      service.logger = { info() {}, warn() {}, error() {} };
      service.durableInboundBodies = new WeakSet();
      service.waMonitor = {
        waInstances: {
          synthetic: { getBase64FromMediaMessage: async () => ({ base64: 'c3ludGhldGlj', mimetype: 'image/png' }) },
        },
      };
      service.prismaRepository = { chatwootOutboundOperation: { findMany: async () => [] } };
      service.clientCw = async () => ({ client: {}, provider: { ignoreJids: [] } });
      service.getConversationMessage = async () => caption;
      service.isMediaMessage = () => media;
      service.getAdsMessage = () => ({});
      service.getReactionMessage = () => null;
      service.isInteractiveButtonMessage = () => false;
      service.createConversation = async () => 123;
      let captured: any[];
      service.sendData = async (...args: any[]) => {
        captured = args;
        return { id: 456 };
      };
      service.createMessage = async (...args: any[]) => {
        captured = args;
        return { id: 456 };
      };
      const result = await service.processWhatsappEvent(
        'messages.upsert',
        { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
        source,
      );
      assert.deepEqual(result, { id: 456 });
      assert.equal(captured[media ? 4 : 2], caption);
      assert.equal(captured[3], fromMe ? 'outgoing' : 'incoming');
      assert.equal(captured[6], source);
      assert.equal(captured[7], 'WAID:SYNTHETIC_SOURCE');
      assert.equal(JSON.stringify(source), before);
    }
  });
}
