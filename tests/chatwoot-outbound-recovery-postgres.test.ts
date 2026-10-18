import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ChatwootOutboundPrismaStore } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-prisma-store';
import { buildChatwootOutboundParts } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';
import { PrismaClient } from '@prisma/client';

// Deliberately opt-in and private-lab-only. Future due dates keep the shared
// running worker away from these owned synthetic fixtures.
test(
  'real PostgreSQL admits behind old callbacks, retains transport fencing and recovers after restart',
  {
    skip: process.env.CHATWOOT_OUTBOUND_RECOVERY_POSTGRES_TEST !== '1',
  },
  async () => {
    const uri = new URL(process.env.DATABASE_CONNECTION_URI!);
    assert.equal(uri.hostname, 'postgres');
    assert.equal(uri.pathname, '/evolution_dev');
    const db = new PrismaClient();
    const instanceId = `task059-${randomUUID()}`;
    const future = new Date(Date.now() + 7 * 86400_000);
    const old = new Date(future.getTime() - 2 * 86400_000);
    const laneKeys = new Set<string>();
    const scoped: any = new Proxy(db, {
      get(target, property) {
        if (property !== 'chatwootOutboundOperation') {
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return new Proxy(db.chatwootOutboundOperation, {
          get(operations, method) {
            const value = Reflect.get(operations, method);
            if (['findMany', 'findFirst', 'count'].includes(String(method)))
              return (args: any) =>
                value.call(operations, { ...args, where: { AND: [args.where || {}, { instanceId }] } });
            return typeof value === 'function' ? value.bind(operations) : value;
          },
        });
      },
    });
    const makeParts = (messageId: number, peer = 'synthetic-destination') => {
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
        chatId: peer,
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
    const admit = { receivedAt: future, maxBacklog: 1, maxOldestAgeMs: 3600_000 };
    try {
      await db.instance.create({ data: { id: instanceId, name: instanceId, integration: 'SYNTHETIC_DISABLED' } });
      const first = new ChatwootOutboundPrismaStore(scoped);
      const oldParts = makeParts(1);
      await first.enqueue(instanceId, 1, 58, 42, oldParts, {
        ...admit,
        receivedAt: old,
        deliveryId: `${instanceId}-old`,
      });
      await db.chatwootOutboundOperation.updateMany({
        where: { instanceId, chatwootMessageId: 1 },
        data: {
          state: 'callback_pending',
          whatsappMessageId: oldParts[0].plannedWhatsappMessageId,
          sendAttempts: 1,
          sentAt: old,
          createdAt: old,
          callbackAttempts: 275,
          nextAttemptAt: future,
        },
      });
      const start = performance.now();
      const nextParts = makeParts(2);
      assert.equal(
        (await first.enqueue(instanceId, 2, 58, 42, nextParts, { ...admit, deliveryId: `${instanceId}-new` }))
          .recovered,
        false,
      );
      const admissionMs = performance.now() - start;
      assert.ok(admissionMs < 2000, `bounded admission: ${admissionMs}ms`);
      const transport = await first.claim('synthetic-transport', future, new Date(+future + 600_000), 'transport');
      assert.equal(transport?.chatwootMessageId, 2);
      assert.equal(transport?.state, 'preparing');
      const restarted = new ChatwootOutboundPrismaStore(scoped);
      const maintenance = await restarted.claim(
        'synthetic-maintenance',
        future,
        new Date(+future + 600_000),
        'maintenance',
      );
      assert.equal(maintenance?.chatwootMessageId, 1);
      assert.equal(maintenance?.state, 'callback_pending');
      assert.equal(maintenance?.sendAttempts, 1);
      assert.equal(maintenance?.callbackAttempts, 275);
      assert.equal(maintenance?.whatsappMessageId, oldParts[0].plannedWhatsappMessageId);
      await assert.rejects(
        restarted.enqueue(instanceId, 3, 58, 42, makeParts(3), { ...admit, deliveryId: `${instanceId}-full` }),
        (e: any) => e.name === 'ChatwootOutboundBacklogExceeded',
      );
      // An independent destination still admits while the original lane is full.
      await restarted.enqueue(instanceId, 4, 58, 42, makeParts(4, 'independent-destination'), {
        ...admit,
        deliveryId: `${instanceId}-independent`,
      });
      assert.equal((await restarted.backlog()).depth, 3);
      await restarted.markMessageCompleted(maintenance!, 'synthetic-maintenance', future);
      const finished = await db.chatwootOutboundOperation.findUnique({ where: { id: maintenance!.id } });
      assert.equal(finished?.state, 'completed');
      assert.equal(finished?.sendAttempts, 1);
      console.log(
        JSON.stringify({
          event: 'synthetic_outbound_recovery',
          admissionMs,
          transportAttempts: 1,
          callbackAttempts: 275,
          providerCalls: 0,
          recoveredAfterNewStore: true,
        }),
      );
    } finally {
      await db.chatwootOutboundWebhookDelivery.deleteMany({ where: { instanceId } });
      await db.instance.deleteMany({ where: { id: instanceId } });
      await db.chatwootOutboundLane.deleteMany({ where: { laneKey: { in: [...laneKeys] } } });
      assert.equal(await db.instance.count({ where: { id: instanceId } }), 0);
      await db.$disconnect();
    }
  },
);
