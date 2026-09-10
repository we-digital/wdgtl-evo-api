import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validatesCurrentChatwootOutboundSnapshot,
  validatesLocalChatwootDeletionBinding,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-binding';
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
  claimGeneration: 1,
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
const currentMessage = {
  contract_version: 1,
  account_id: 7,
  inbox_id: 58,
  conversation_id: 42,
  message_id: 314,
  message_type: 1,
  message_type_name: 'outgoing',
  deleted: false,
  destination: '628123',
  contact_inbox_source_id: 'source-1',
  route: { inbox_name: 'WA - Test', channel_type: 'Channel::Api', binding: route },
};
const validate = (overrides: Record<string, unknown> = {}) =>
  validatesCurrentChatwootOutboundSnapshot({
    operation,
    provider,
    currentInbox,
    conversation,
    currentMessage,
    expectedRoute: route,
    currentRoute: route,
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
  assert.equal(validate({ currentMessage: { ...currentMessage, deleted: true } }), false);
  assert.equal(validate({ currentMessage: null }), false);
});

test('accepts deletion only when the authoritative exact message reports deleted', () => {
  assert.equal(validate({ currentMessage: { ...currentMessage, deleted: true }, expectedDeleted: true }), true);
  assert.equal(validate({ expectedDeleted: true }), false);
});

test('allows callback-outage deletion only with exact retained provenance and no conflicting mapping', () => {
  const message = {
    chatwootMessageId: null,
    chatwootInboxId: null,
    chatwootConversationId: null,
    contextInfo: {
      weDigitalOutbound: {
        version: 1,
        origin: 'chatwoot',
        requestId: operation.operationKey,
        chatwootMessageId: 314,
        chatwootInboxId: 58,
        chatwootConversationId: 42,
      },
    },
  };
  assert.equal(validatesLocalChatwootDeletionBinding(message, operation), true);
  assert.equal(
    validatesLocalChatwootDeletionBinding({ ...message, chatwootConversationId: 43 }, operation),
    false,
  );
  assert.equal(
    validatesLocalChatwootDeletionBinding({ ...message, contextInfo: { weDigitalOutbound: {} } }, operation),
    false,
  );
});
