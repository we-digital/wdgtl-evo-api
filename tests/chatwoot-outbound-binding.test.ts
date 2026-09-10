import assert from 'node:assert/strict';
import test from 'node:test';

import { validatesCurrentChatwootOutboundSnapshot } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-binding';
import { StoredChatwootOutboundOperation } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';

const route = {
  version: 2 as const,
  provider: 'evo_whatsapp' as const,
  inbox_id: 58,
  instance_id: 'instance-1',
  instance_name: 'test-instance',
  receiver_fingerprint: 'a'.repeat(64),
};
const operation = {
  id: 'operation-1',
  operationKey: 'operation-key',
  messageSetHash: 'set-hash',
  instanceId: 'instance-1',
  chatwootMessageId: 314,
  chatwootInboxId: 58,
  chatwootConversationId: 42,
  partIdentity: 'text',
  partIndex: 0,
  partCount: 1,
  plannedWhatsappMessageId: 'WD1',
  state: 'pending',
  payload: {
    chatId: '628123',
    text: 'hello',
    origin: {
      providerId: 'provider-1',
      baseUrl: 'https://chatwoot.example.invalid',
      accountId: 7,
      inboxId: 58,
      inboxName: 'WA - Test',
      conversationId: 42,
      messageId: 314,
      contactInboxSourceId: 'source-1',
      routeBinding: route,
    },
  },
  preparationAttempts: 0,
  sendAttempts: 0,
  callbackAttempts: 0,
} as StoredChatwootOutboundOperation;
const provider = {
  id: 'provider-1',
  instanceId: 'instance-1',
  enabled: true,
  accountId: '7',
  token: 'redacted',
  url: 'https://chatwoot.example.invalid/',
  nameInbox: 'WA - Test',
} as any;
const currentInbox = { id: 58, name: 'WA - Test' };
const conversation = {
  id: 42,
  account_id: 7,
  inbox_id: 58,
  meta: { sender: { phone_number: '+628123' } },
  contact_inbox: { source_id: 'source-1' },
};
const messages = [{ id: 314, conversation_id: 42, message_type: 'outgoing', content_attributes: {} }];
const validate = (overrides: Record<string, unknown> = {}) =>
  validatesCurrentChatwootOutboundSnapshot({
    operation,
    provider,
    currentInbox,
    conversation,
    messages,
    expectedRoute: route,
    currentRoute: route,
    requireMessage: true,
    ...overrides,
  });

test('accepts the exact authoritative provider, live route, relationship, destination and message', () => {
  assert.equal(validate(), true);
});

test('rejects provider disable, inbox rename, reassignment, destination change and message deletion', () => {
  assert.equal(validate({ provider: { ...provider, enabled: false } }), false);
  assert.equal(validate({ currentInbox: { ...currentInbox, name: 'Renamed' } }), false);
  assert.equal(validate({ conversation: { ...conversation, inbox_id: 59 } }), false);
  assert.equal(validate({ conversation: { ...conversation, meta: { sender: { phone_number: '+628999' } } } }), false);
  assert.equal(validate({ messages: [{ ...messages[0], content_attributes: { deleted: true } }] }), false);
  assert.equal(validate({ messages: [] }), false);
});
