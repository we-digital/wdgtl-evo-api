import assert from 'node:assert/strict';
import test from 'node:test';

import { formatWhatsappGroupContent } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-group-display';

const pn = '14155552671@s.whatsapp.net';
const content = 'Distinct caption\nsecond line';
const body = (participant?: string, participantAlt?: string, pushName = 'Synthetic sender') => ({
  key: { fromMe: false, participant, participantAlt },
  pushName,
});

test('incoming PN and device-qualified PN retain formatted name and exact caption', () => {
  for (const participant of [pn, '14155552671:2@s.whatsapp.net']) {
    const source = body(participant);
    const before = JSON.stringify(source);
    assert.equal(
      formatWhatsappGroupContent(source, content, 'Contact'),
      `**+1 415 555 2671 - Synthetic sender:**\n\n${content}`,
    );
    assert.equal(JSON.stringify(source), before);
  }
});

test('incoming LID uses only its valid native PN alternative regardless of addressingMode', () => {
  assert.equal(
    formatWhatsappGroupContent(body('999999999999@lid', pn), content, 'Contact'),
    `**+1 415 555 2671 - Synthetic sender:**\n\n${content}`,
  );
});

test('unresolved LID is a name, never an inferred phone', () => {
  for (const alt of [undefined, '999999999999@lid', 'bad@s.whatsapp.net']) {
    assert.equal(
      formatWhatsappGroupContent(body('14155552671@lid', alt), content, 'Contact'),
      `**Synthetic sender:**\n\n${content}`,
    );
  }
});

test('missing, malformed or unparseable participant uses a safe supplied localized fallback', () => {
  for (const participant of [undefined, '', 'bad', 'bad@s.whatsapp.net', '123456@s.whatsapp.net']) {
    assert.equal(
      formatWhatsappGroupContent(body(participant, undefined, ''), content, 'Contato'),
      `**Contato:**\n\n${content}`,
    );
  }
});

test('captionless incoming media retains its label without appending undefined', () => {
  assert.equal(formatWhatsappGroupContent(body('999999@lid'), undefined, 'Contact'), '**Synthetic sender:**');
});

test('outgoing body is exact and participant identity is never accessed', () => {
  const source = {
    key: {
      fromMe: true,
      get participant(): string {
        throw Error('outgoing participant must not be read');
      },
    },
  };
  assert.equal(formatWhatsappGroupContent(source, content, 'Contact'), content);
  assert.equal(formatWhatsappGroupContent(source, '', 'Contact'), '');
});

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

for (const media of [false, true]) {
  test(`live ${media ? 'media' : 'text'} group branch keeps source identity and distinct content`, async () => {
    for (const fromMe of [false, true]) {
      const source = {
        key: { id: 'SYNTHETIC_SOURCE', remoteJid: '120363000000001@g.us', fromMe },
        pushName: 'Synthetic sender',
        messageType: media ? 'imageMessage' : 'conversation',
        message: media ? { imageMessage: { caption: content } } : { conversation: content },
      };
      const before = JSON.stringify(source);
      const service = Object.create(ChatwootService.prototype) as any;
      service.logger = { info() {}, warn() {}, error() {} };
      service.waMonitor = {
        waInstances: {
          synthetic: { getBase64FromMediaMessage: async () => ({ base64: 'c3ludGhldGlj', mimetype: 'image/png' }) },
        },
      };
      service.prismaRepository = { chatwootOutboundOperation: { findMany: async () => [] } };
      service.clientCw = async () => ({ client: {}, provider: { ignoreJids: [] } });
      service.getConversationMessage = async () => content;
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
      assert.equal(captured[media ? 4 : 2], fromMe ? content : `**Synthetic sender:**\n\n${content}`);
      assert.equal(captured[3], fromMe ? 'outgoing' : 'incoming');
      assert.equal(captured[6], source);
      assert.equal(captured[7], 'WAID:SYNTHETIC_SOURCE');
      assert.equal(JSON.stringify(source), before);
    }
  });
}
