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
  claimGeneration: 0,
});

test('increments claim generation and rejects a stale same-worker transport fence', async () => {
  const row: any = {
    ...stored(0, 'pending'),
    operationKey: parts[0].operationKey,
    messageSetHash: parts[0].messageSetHash,
    partIdentity: parts[0].partIdentity,
    partIndex: 0,
    partCount: 2,
    plannedWhatsappMessageId: parts[0].plannedWhatsappMessageId,
    payload: parts[0].payload,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: new Date(0),
    createdAt: new Date(0),
  };
  const repository = {
    chatwootOutboundOperation: {
      findFirst: async () => ({ ...row }),
      updateMany: async ({ where, data }: any) => {
        if (where.id !== row.id || (where.claimGeneration !== undefined && where.claimGeneration !== row.claimGeneration))
          return { count: 0 };
        if (where.state && typeof where.state === 'string' && where.state !== row.state) return { count: 0 };
        if (where.leaseOwner !== undefined && where.leaseOwner !== row.leaseOwner) return { count: 0 };
        const { claimGeneration, sendAttempts, ...scalars } = data;
        Object.assign(row, scalars);
        if (claimGeneration?.increment) row.claimGeneration += claimGeneration.increment;
        if (sendAttempts?.increment) row.sendAttempts += sendAttempts.increment;
        return { count: 1 };
      },
    },
  };
  const store = new ChatwootOutboundPrismaStore(repository as any);
  const first = await store.claim('same-worker', new Date(), new Date(Date.now() + 1_000));
  Object.assign(row, { state: 'pending', leaseOwner: null, leaseExpiresAt: null });
  const second = await store.claim('same-worker', new Date(), new Date(Date.now() + 1_000));

  assert.equal(first?.claimGeneration, 1);
  assert.equal(second?.claimGeneration, 2);
  assert.equal(await store.markSending(row.id, 'same-worker', first!.claimGeneration, new Date()), false);
  assert.equal(await store.markSending(row.id, 'same-worker', second!.claimGeneration, new Date()), true);
  assert.equal(row.sendAttempts, 1);
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
