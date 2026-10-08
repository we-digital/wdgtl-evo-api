import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatwootInboundPrismaStore } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-prisma-store';
import {
  InboundDelivery,
  inboundDeliveryId,
  inboundPayloadHash,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';

test(
  'real PostgreSQL ledger persists source, serializes process leases, and confirms only the lease owner',
  { skip: !process.env.INBOUND_SYNTHETIC_PRISMA_CLIENT },
  async () => {
    // Explicit private generated client and isolated test URI; production source never supplies these values.
    const { PrismaClient } = require(process.env.INBOUND_SYNTHETIC_PRISMA_CLIENT!);
    const a = new PrismaClient();
    const b = new PrismaClient();
    try {
      assert.match(process.env.DATABASE_CONNECTION_URI || '', /127\.0\.0\.1.*schema=cw_inbound281_synthetic/);
      await a.chatwootInboundDelivery.deleteMany();
      const s1 = new ChatwootInboundPrismaStore(a);
      const s2 = new ChatwootInboundPrismaStore(b);
      const payload = {
        key: { id: 'synthetic-A', remoteJid: '120363000000000000@g.us', fromMe: false },
        messageType: 'conversation',
        message: { conversation: 'synthetic' },
        messageTimestamp: 1700000000,
      };
      const item: InboundDelivery = {
        id: inboundDeliveryId('synthetic-one', payload),
        instanceId: 'synthetic-one',
        instanceName: 'synthetic-one',
        providerId: 'synthetic-provider',
        providerFingerprint: 'f'.repeat(64),
        accountId: 1,
        inboxId: null,
        peer: payload.key.remoteJid,
        sourceId: 'WAID:synthetic-A',
        fromMe: false,
        payload,
        payloadHash: inboundPayloadHash(payload),
        state: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(0),
        leaseOwner: null,
        leaseExpiresAt: null,
        result: null,
      };
      await s1.enqueue(item);
      assert.equal((await s2.due(new Date(), 8))[0].payloadHash, item.payloadHash);
      await s2.enqueue({ ...item, payload: { ...payload, message: { conversation: 'changed' } } });
      assert.deepEqual((await s1.due(new Date(), 8))[0].payload, item.payload);
      const now = new Date();
      const until = new Date(now.getTime() + 120000);
      const claims = await Promise.all([
        s1.claim(item.id, 'owner-A', now, until),
        s2.claim(item.id, 'owner-B', now, until),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const owner = claims[0] ? 'owner-A' : 'owner-B';
      const other = claims[0] ? 'owner-B' : 'owner-A';
      assert.equal(await s2.bindInbox(item.id, other, 42), false);
      assert.equal(await s1.bindInbox(item.id, owner, 42), true);
      assert.equal(await s2.bindInbox(item.id, owner, 33), false);
      assert.equal(await s2.finish(item.id, other, { id: 1, inbox_id: 42, conversation_id: 77 }), false);
      assert.equal(await s1.renew(item.id, owner, until), true);
      await s1.defer(item.id, owner, 'HTTP502', new Date(0));
      assert.equal((await s2.due(new Date(), 8)).length, 1);
      assert.equal(await s2.claim(item.id, 'restarted', new Date(), until), true);
      assert.equal(await s2.finish(item.id, 'restarted', { id: 1, inbox_id: 42, conversation_id: 77 }), true);
      assert.equal((await s1.due(new Date(), 8)).length, 0);
      const confirmed = await s1.enqueue(item);
      assert.equal(confirmed.state, 'confirmed');
      assert.equal(confirmed.result?.id, 1);
      const second = { ...item, instanceId: 'synthetic-two', id: inboundDeliveryId('synthetic-two', payload) };
      await s1.enqueue(second);
      assert.equal((await s2.due(new Date(), 8)).length, 1);
      assert.equal(await s1.claim(second.id, 'crashed', new Date(), new Date(0)), true);
      assert.equal(await s2.claim(second.id, 'successor', new Date(), until), true);
      assert.equal(await s1.finish(second.id, 'crashed', { id: 2, inbox_id: 33, conversation_id: 78 }), false);
      assert.equal(await s2.finish(second.id, 'successor', { id: 2, inbox_id: 33, conversation_id: 78 }), true);
      assert.equal(await a.chatwootInboundDelivery.count(), 2);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  },
);
