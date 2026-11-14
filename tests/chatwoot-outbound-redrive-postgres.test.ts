import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ChatwootOutboundPrismaStore } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-prisma-store';
import { buildChatwootOutboundParts } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';
import { PrismaClient } from '@prisma/client';

// Opt-in, private-lab-only (same gate as the recovery test). Future due dates
// keep the shared running worker away from these synthetic fixtures.
test(
  'a new delivery re-runs a message that failed before transport, and never one that may have been sent',
  {
    skip: process.env.CHATWOOT_OUTBOUND_RECOVERY_POSTGRES_TEST !== '1',
  },
  async () => {
    const uri = new URL(process.env.DATABASE_CONNECTION_URI!);
    assert.equal(uri.hostname, 'postgres');
    assert.equal(uri.pathname, '/evolution_dev');
    const db = new PrismaClient();
    const instanceId = `redrive-${randomUUID()}`;
    const future = new Date(Date.now() + 7 * 86400_000);
    const laneKeys = new Set<string>();
    const makeParts = (messageId: number) => {
      const origin = {
        providerId: 'synthetic',
        baseUrl: 'http://chatwoot.respon.localhost',
        accountId: 7,
        inboxId: 58,
        inboxName: 'Synthetic disabled',
        conversationId: 42,
        messageId,
        snapshotFingerprint: 'b'.repeat(64),
        routeBinding: {
          version: 2 as const,
          provider: 'evo_whatsapp' as const,
          inbox_id: 58,
          instance_id: instanceId,
          instance_name: instanceId,
          receiver_fingerprint: 'a'.repeat(64),
        },
      };
      const parts = buildChatwootOutboundParts({
        instanceId,
        chatId: `synthetic-destination-${messageId}`,
        formattedText: 'synthetic',
        origin,
        body: {
          event: 'message_created',
          id: messageId,
          account: { id: 7 },
          inbox: { id: 58 },
          conversation: { id: 42 },
          outbound_snapshot: { version: 1, fingerprint: origin.snapshotFingerprint },
          attachments: [],
        },
      });
      laneKeys.add(parts[0].laneKey);
      return parts;
    };
    const admit = { receivedAt: future, maxBacklog: 10, maxOldestAgeMs: 3600_000 };
    try {
      await db.instance.create({ data: { id: instanceId, name: instanceId, integration: 'SYNTHETIC_DISABLED' } });
      const store = new ChatwootOutboundPrismaStore(db);

      // 1: failed in preparation (e.g. number not on WhatsApp) -> Retry runs it again.
      await store.enqueue(instanceId, 1, 58, 42, makeParts(1), { ...admit, deliveryId: `${instanceId}-1a` });
      await db.chatwootOutboundOperation.updateMany({
        where: { instanceId, chatwootMessageId: 1 },
        data: { state: 'failed', preparationAttempts: 6, lastErrorClass: 'WhatsappRecipientNotFound' },
      });
      const later = new Date(future.getTime() + 60_000);
      const retried = await store.enqueue(instanceId, 1, 58, 42, makeParts(1), {
        ...admit,
        receivedAt: later,
        deliveryId: `${instanceId}-1b`,
      });
      assert.equal(retried.recovered, false);
      const rerun = await db.chatwootOutboundOperation.findFirst({ where: { instanceId, chatwootMessageId: 1 } });
      assert.equal(rerun?.state, 'pending');
      assert.equal(rerun?.preparationAttempts, 0);
      assert.equal(rerun?.lastErrorClass, null);
      assert.equal(rerun?.webhookReceivedAt?.getTime(), later.getTime());

      // The same delivery replayed again is only a duplicate.
      assert.equal(
        (await store.enqueue(instanceId, 1, 58, 42, makeParts(1), { ...admit, deliveryId: `${instanceId}-1b` }))
          .recovered,
        true,
      );

      // 2: failed after transport started -> a new delivery must not re-send it.
      await store.enqueue(instanceId, 2, 58, 42, makeParts(2), { ...admit, deliveryId: `${instanceId}-2a` });
      await db.chatwootOutboundOperation.updateMany({
        where: { instanceId, chatwootMessageId: 2 },
        data: { state: 'failed', sendAttempts: 1, sendStartedAt: future },
      });
      assert.equal(
        (await store.enqueue(instanceId, 2, 58, 42, makeParts(2), { ...admit, deliveryId: `${instanceId}-2b` }))
          .recovered,
        true,
      );
      const kept = await db.chatwootOutboundOperation.findFirst({ where: { instanceId, chatwootMessageId: 2 } });
      assert.equal(kept?.state, 'failed');
      assert.equal(kept?.sendAttempts, 1);
    } finally {
      await db.chatwootOutboundWebhookDelivery.deleteMany({ where: { instanceId } });
      await db.instance.deleteMany({ where: { id: instanceId } });
      await db.chatwootOutboundLane.deleteMany({ where: { laneKey: { in: [...laneKeys] } } });
      await db.$disconnect();
    }
  },
);
