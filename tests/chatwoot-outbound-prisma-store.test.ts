import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatwootOutboundPrismaStore } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-prisma-store';
import {
  buildChatwootOutboundParts,
  ChatwootOutboundOrigin,
  StoredChatwootOutboundOperation,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';

const origin: ChatwootOutboundOrigin = {
  providerId: 'provider-1',
  baseUrl: 'https://chatwoot.example.invalid',
  accountId: 7,
  inboxId: 58,
  inboxName: 'WA - Test',
  conversationId: 42,
  messageId: 314,
  routeBinding: {
    version: 2,
    provider: 'evo_whatsapp',
    inbox_id: 58,
    instance_id: 'instance-1',
    instance_name: 'test-instance',
    receiver_fingerprint: 'a'.repeat(64),
  },
};

const parts = buildChatwootOutboundParts({
  instanceId: 'instance-1',
  body: {
    event: 'message_created',
    id: 314,
    account: { id: 7 },
    inbox: { id: 58 },
    conversation: { id: 42 },
    attachments: [
      { id: 10, data_url: 'https://example.invalid/a' },
      { id: 11, data_url: 'https://example.invalid/b' },
    ],
  },
  chatId: 'opaque-chat',
  formattedText: 'caption',
  origin,
});

const stored = (partIndex: number, state: string, whatsappMessageId?: string) => ({
  ...parts[partIndex],
  id: `operation-${partIndex}`,
  instanceId: 'instance-1',
  chatwootMessageId: 314,
  chatwootInboxId: 58,
  chatwootConversationId: 42,
  state,
  whatsappMessageId,
  preparationAttempts: 0,
  sendAttempts: whatsappMessageId ? 1 : 0,
  callbackAttempts: 0,
});

test('changed frozen-set replay atomically quarantines every retained operation', async () => {
  const rows = [stored(0, 'completed', parts[0].plannedWhatsappMessageId), stored(1, 'pending')];
  let quarantined = 0;
  const repository = {
    chatwootOutboundOperation: {
      findMany: async () => rows,
      updateMany: async ({ data }: any) => {
        if (data.state === 'quarantined') {
          rows.forEach((row) => Object.assign(row, data));
          quarantined = rows.length;
        }
        return { count: rows.length };
      },
    },
  };
  const store = new ChatwootOutboundPrismaStore(repository as any);
  const changedParts = buildChatwootOutboundParts({
    instanceId: 'instance-1',
    body: {
      event: 'message_created',
      id: 314,
      account: { id: 7 },
      inbox: { id: 58 },
      conversation: { id: 42 },
      attachments: [{ id: 10, data_url: 'https://example.invalid/changed' }],
    },
    chatId: 'opaque-chat',
    formattedText: 'caption',
    origin,
  });

  await assert.rejects(() => store.enqueue('instance-1', 314, 58, 42, changedParts), /frozen with different/);

  assert.equal(quarantined, 2);
  assert.ok(rows.every((row) => row.state === 'quarantined' && row.lastErrorClass === 'ChangedFrozenPartSet'));
});

test('mixed terminal state exposes only successful frozen mappings as a deterministic partial success', async () => {
  const rows = [stored(0, 'failure_callback_pending'), stored(1, 'callback_pending', 'WAID:part-1')];
  const repository = {
    chatwootOutboundOperation: { findMany: async () => rows },
  };
  const store = new ChatwootOutboundPrismaStore(repository as any);

  const status = await store.messageStatus(rows[0] as StoredChatwootOutboundOperation);

  assert.equal(status.ready, true);
  assert.equal(status.outcome, 'partial_success');
  assert.deepEqual(status.callbackParts, [
    { partKey: parts[1].operationKey, partIndex: 0, partCount: 1, sourceId: 'WAID:part-1' },
  ]);
});
