process.env.CHATWOOT_AVATAR_SYNC = 'off';

import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { chatwootMarkdownToWhatsapp } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-whatsapp-text';

const CHAT = '628123456789@s.whatsapp.net';
const instance = { instanceName: 'p-mila', instanceId: 'inst-1' } as any;
// Chatwoot content as the webhook carries it (hard breaks already plain newlines).
const MULTILINE = '20 Nov, **online** NS\n\nKuta\n*Canggu* EVOA 3\n~~ABG~~ `code`\n\n- one\n- **two**\n1. three';
const EXPECTED = '20 Nov, *online* NS\n\nKuta\n_Canggu_ EVOA 3\n~ABG~ ```code```\n\n- one\n- *two*\n1. three';

test('converts Chatwoot markdown to WhatsApp formatting line by line', () => {
  assert.equal(chatwootMarkdownToWhatsapp(MULTILINE), EXPECTED);
  assert.equal(chatwootMarkdownToWhatsapp(''), '');
  assert.equal(chatwootMarkdownToWhatsapp(undefined), '');
});

test('keeps WhatsApp mentions as @number', () => {
  assert.equal(
    chatwootMarkdownToWhatsapp('Hi [@Mila](mention://whatsapp/628111/628111)\n**ok**'),
    'Hi @628111\n*ok*',
  );
});

test('a multi-line native edit gets the same WhatsApp text as a new send (C256)', async () => {
  const service = Object.create(ChatwootService.prototype) as any;
  service.logger = { verbose() {}, warn() {}, error() {}, info() {} };
  service.prismaRepository = {
    message: { findFirst: async () => ({ key: { id: 'WA-1', remoteJid: CHAT, fromMe: true } }) },
  };
  const edits: any[] = [];
  const waInstance = {
    updateMessage: async (data: any) => {
      edits.push(data);
      return { key: data.key };
    },
  };
  const body = { id: 70, content: MULTILINE, account: { id: 1 }, inbox: { id: 3 }, conversation: { id: 7 } };

  const result = await service.trySendNativeEdit(waInstance, CHAT, body, instance);

  assert.equal(result?.key?.id, 'WA-1');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, EXPECTED);
  assert.equal(edits[0].text, chatwootMarkdownToWhatsapp(MULTILINE));
  assert.ok(!edits[0].text.includes('\\'));
});
