import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { ApiOutboundConflict } from '../src/api/services/api-outbound-operation';
import { ApiOutboundPrismaStore } from '../src/api/services/api-outbound-prisma-store';

// Explicit opt-in DSN; this suite never reads the runtime production DSN.
test('real PostgreSQL claims, lease fencing, null-body native receipt and sender binding', {
  skip: !process.env.API_OUTBOUND_TEST_DATABASE_URL,
}, async () => {
  const db = new PrismaClient({ datasourceUrl: process.env.API_OUTBOUND_TEST_DATABASE_URL });
  const store = new ApiOutboundPrismaStore(db);
  const instanceId = `synthetic-api-${randomUUID()}`;
  const id = randomUUID(), peer = '628111111111@s.whatsapp.net';
  try {
    await db.instance.create({ data: { id: instanceId, name: instanceId, integration: 'WHATSAPP-BAILEYS' } });
    const rows = await Promise.all([store.admit(id, instanceId, 'a'.repeat(64)), store.admit(id, instanceId, 'a'.repeat(64))]);
    const now = new Date();
    assert.equal(rows[0].plannedWhatsappMessageId, rows[1].plannedWhatsappMessageId);
    await assert.rejects(store.admit(id, instanceId, 'b'.repeat(64)), ApiOutboundConflict);
    await assert.rejects(store.read(id, 'different-sender'), ApiOutboundConflict);
    const token1 = randomUUID(), token2 = randomUUID();
    const won = await Promise.all([store.claim(rows[0], token1, now, new Date(+now + 5000)),
      store.claim(rows[1], token2, now, new Date(+now + 5000))]);
    assert.equal(won.filter(Boolean).length, 1);
    const token = won[0] ? token1 : token2, wrongToken = won[0] ? token2 : token1;
    assert.equal(await store.start(rows[0], wrongToken, peer, now), false);
    assert.equal(await store.start(rows[0], token, peer, now), true);
    let row = (await store.read(id, instanceId))!;
    await store.defer(row, token, true, 'API_SEND_TIMEOUT', now, false, true);
    row = (await store.read(id, instanceId))!;
    assert.equal(row.state, 'unknown');
    assert.ok(row.leaseExpiresAt);
    assert.equal(await store.claim(row, randomUUID(), now, new Date(+now + 5000)), false);
    assert.equal(await store.renew(row, wrongToken, now, new Date(+now + 10000)), false);
    assert.equal(await store.renew(row, token, now, new Date(+now + 10000)), true);
    await store.release(row, token);
    row = (await store.read(id, instanceId))!; assert.equal(row.leaseExpiresAt, null);
    const key = { id: row.plannedWhatsappMessageId, fromMe: true, remoteJid: peer };
    assert.equal(await store.receipt(row, token, { key: { ...key, remoteJid: 'wrong-peer' } }), false);
    assert.equal(await store.receipt(row, wrongToken, { key }), false);
    await db.message.create({ data: { instanceId, key, message: Prisma.JsonNull,
      messageType: 'conversation', source: 'web', messageTimestamp: 1 } });
    const receipt = await store.findReceipt(row);
    assert.deepEqual(receipt, { key });
    assert.equal(await store.receipt(row, null, receipt), true);
    assert.equal((await store.read(id, instanceId))!.state, 'sent');
    assert.equal(await store.claim(row, randomUUID(), now, new Date(+now + 5000)), false);
    const interruptedId = randomUUID();
    let interrupted = await store.admit(interruptedId, instanceId, 'c'.repeat(64));
    const restartTime = new Date();
    assert.equal(await store.claim(interrupted, randomUUID(), restartTime, new Date(+restartTime + 5)), true);
    interrupted = (await store.read(interruptedId, instanceId))!;
    const recovered = await store.recover(interrupted, new Date(+restartTime + 10));
    assert.equal(recovered.state, 'pending');
    assert.equal(recovered.transportStartedAt, null);

    // UUIDs sharing a prefix retain different full native keys and cannot borrow receipts.
    const prefix = randomUUID().slice(0, 28);
    const a = await store.admit(prefix + '00000001', instanceId, 'd'.repeat(64));
    let b = await store.admit(prefix + '00000002', instanceId, 'e'.repeat(64));
    assert.notEqual(a.plannedWhatsappMessageId, b.plannedWhatsappMessageId);
    assert.equal(a.plannedWhatsappMessageId.length, 32);
    const bNow = new Date(), bToken = randomUUID();
    assert.equal(await store.claim(b, bToken, bNow, new Date(+bNow + 5000)), true);
    assert.equal(await store.start(b, bToken, peer, bNow), true);
    b = (await store.read(b.id, instanceId))!;
    await db.message.create({ data: { instanceId, key: { ...key, id: a.plannedWhatsappMessageId },
      message: Prisma.JsonNull, messageType: 'conversation', source: 'web', messageTimestamp: 1 } });
    assert.equal(await store.findReceipt(b), null);

    // Recovery must use the marker at its CAS, even if its read predates transport start.
    let stale = await store.admit(randomUUID(), instanceId, 'f'.repeat(64));
    const staleNow = new Date(), staleToken = randomUUID();
    await store.claim(stale, staleToken, staleNow, new Date(+staleNow + 5));
    stale = (await store.read(stale.id, instanceId))!;
    await store.start(stale, staleToken, peer, staleNow);
    const actuallyStarted = await store.recover(stale, new Date(+staleNow + 10));
    assert.equal(actuallyStarted.state, 'unknown'); assert.ok(actuallyStarted.transportStartedAt);

    // Rotate the destination/attempt after receipt validation but before the SQL commit.
    const raceStore = new ApiOutboundPrismaStore({ apiOutboundOperation: {
      findUnique: (...args: any[]) => (db.apiOutboundOperation.findUnique as any)(...args),
      updateMany: async (args: any) => {
        if (args.data.state === 'sent') await db.apiOutboundOperation.update({ where: { id: actuallyStarted.id },
          data: { destinationJid: 'different@s.whatsapp.net', attempts: { increment: 1 }, claimToken: randomUUID() } });
        return db.apiOutboundOperation.updateMany(args);
      },
    } });
    assert.equal(await raceStore.receipt(actuallyStarted, null,
      { key: { id: actuallyStarted.plannedWhatsappMessageId, remoteJid: peer, fromMe: true } }), false);
    assert.equal((await store.read(stale.id, instanceId))!.state, 'unknown');
  } finally {
    await db.apiOutboundOperation.deleteMany({ where: { instanceId } });
    await db.instance.deleteMany({ where: { id: instanceId } });
    await db.$disconnect();
  }
});
