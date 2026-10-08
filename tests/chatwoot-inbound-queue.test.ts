import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatwootInboundQueue,
  InboundAck,
  InboundDelivery,
  InboundStore,
  inboundDeliveryId,
  inboundPayloadHash,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';

class Ledger implements InboundStore {
  rows = new Map<string, InboundDelivery>();
  events: string[] = [];
  async enqueue(item: InboundDelivery) {
    this.events.push('persist');
    if (!this.rows.has(item.id)) this.rows.set(item.id, structuredClone(item));
    return structuredClone(this.rows.get(item.id)!);
  }
  async due(now: Date, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.state === 'pending' && r.nextAttemptAt <= now && (!r.leaseExpiresAt || r.leaseExpiresAt < now))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
  async claim(id: string, owner: string, now: Date, until: Date) {
    const row = this.rows.get(id)!;
    if (row.state !== 'pending' || row.nextAttemptAt > now || (row.leaseExpiresAt && row.leaseExpiresAt >= now))
      return false;
    Object.assign(row, { leaseOwner: owner, leaseExpiresAt: until, attempts: row.attempts + 1 });
    this.events.push('claim');
    return true;
  }
  async renew(id: string, owner: string, until: Date) {
    const r = this.rows.get(id)!;
    if (r.leaseOwner !== owner) return false;
    r.leaseExpiresAt = until;
    return true;
  }
  async finish(id: string, owner: string, ack: InboundAck) {
    const r = this.rows.get(id)!;
    if (r.leaseOwner !== owner) return false;
    Object.assign(r, { state: 'confirmed', result: ack, leaseOwner: null, leaseExpiresAt: null });
    this.events.push('confirmed');
    return true;
  }
  async defer(id: string, owner: string, _error: string, until: Date) {
    const r = this.rows.get(id)!;
    if (r.leaseOwner !== owner) return;
    Object.assign(r, { nextAttemptAt: until, leaseOwner: null, leaseExpiresAt: null });
    this.events.push('pending');
  }
}
const source = () => ({
  key: { id: 'A', remoteJid: '120363000000000000@g.us', fromMe: false },
  messageType: 'conversation',
  messageTimestamp: 1700000000,
  message: { conversation: 'synthetic text' },
  pushName: 'synthetic',
});
const item = (instanceId = 'one', inboxId = 42): InboundDelivery => {
  const payload = source();
  return {
    id: inboundDeliveryId(instanceId, payload),
    instanceId,
    instanceName: instanceId,
    providerId: 'provider-' + instanceId,
    providerFingerprint: 'f'.repeat(64),
    accountId: 1,
    inboxId,
    peer: payload.key.remoteJid,
    sourceId: 'WAID:A',
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
};
const ack = (inbox_id = 42) => ({ id: 100 + inbox_id, inbox_id, conversation_id: 200 + inbox_id });

test('durable commit precedes receiver attempt and independent confirmation precedes final receipt', async () => {
  const store = new Ledger();
  const queue = new ChatwootInboundQueue(store, async () => {
    assert.deepEqual(store.events, ['persist', 'claim']);
    store.events.push('receiver_read_and_verified');
    return ack();
  });
  await queue.submit(item());
  assert.deepEqual(store.events, ['persist', 'claim', 'receiver_read_and_verified', 'confirmed']);
  await queue.stop();
});
for (const reason of ['HTTP502', 'NetworkTimeout'])
  test(`${reason} persists pending and retries after restart without source loss`, async () => {
    const store = new Ledger();
    let clock = 0;
    const old = new ChatwootInboundQueue(
      store,
      async () => {
        throw Object.assign(new Error(reason), { name: reason });
      },
      () => {},
      20,
      100,
      () => new Date(clock),
    );
    assert.equal(await old.submit(item()), undefined);
    assert.equal(store.rows.get(item().id)?.state, 'pending');
    await old.stop();
    const next = new ChatwootInboundQueue(
      store,
      async () => ack(),
      () => {},
      20,
      100,
      () => new Date(clock),
    );
    await next.poll();
    assert.equal(store.rows.get(item().id)?.state, 'pending');
    clock = 21;
    await next.poll();
    assert.equal(store.rows.get(item().id)?.state, 'confirmed');
    assert.equal(store.rows.get(item().id)?.payloadHash, item().payloadHash);
    await next.stop();
  });
test('lost ACK restarts through receiver lookup without another create', async () => {
  const store = new Ledger();
  let clock = 0,
    posts = 0;
  let receiver: InboundAck | undefined;
  const q1 = new ChatwootInboundQueue(
    store,
    async () => {
      assert.equal(receiver, undefined);
      posts++;
      receiver = ack();
      throw new Error('ACK lost');
    },
    () => {},
    20,
    100,
    () => new Date(clock),
  );
  await q1.submit(item());
  await q1.stop();
  clock = 21;
  const q2 = new ChatwootInboundQueue(
    store,
    async () => {
      assert.ok(receiver);
      return receiver;
    },
    () => {},
    20,
    100,
    () => new Date(clock),
  );
  await q2.poll();
  assert.equal(posts, 1);
  assert.equal(store.rows.get(item().id)?.state, 'confirmed');
  await q2.stop();
});
test('two processes cannot claim the same source concurrently', async () => {
  const store = new Ledger();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let posts = 0;
  const deliver = async () => {
    posts++;
    await gate;
    return ack();
  };
  const q1 = new ChatwootInboundQueue(store, deliver),
    q2 = new ChatwootInboundQueue(store, deliver);
  const a = q1.submit(item()),
    b = q2.submit(item());
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([a, b]);
  assert.equal(posts, 1);
  await Promise.all([q1.stop(), q2.stop()]);
});
test('same native group/WAID is delivered separately to two participating inboxes', async () => {
  const store = new Ledger();
  const delivered: number[] = [];
  const q = new ChatwootInboundQueue(store, async (i) => {
    delivered.push(i.inboxId!);
    return ack(i.inboxId!);
  });
  await Promise.all([q.submit(item('one', 42)), q.submit(item('two', 33))]);
  assert.notEqual(item('one').id, item('two').id);
  assert.deepEqual(delivered.sort(), [33, 42]);
  assert.equal(store.rows.size, 2);
  await q.stop();
});
test('direction and group peer are part of identity', () => {
  const body = source(),
    base = inboundDeliveryId('one', body);
  assert.notEqual(base, inboundDeliveryId('one', { ...body, key: { ...body.key, fromMe: true } }));
  assert.notEqual(
    base,
    inboundDeliveryId('one', { ...body, key: { ...body.key, remoteJid: '120363999999999999@g.us' } }),
  );
  assert.throws(() => inboundDeliveryId('one', { key: { id: 'A', remoteJid: body.key.remoteJid, fromMe: null } }));
});
test('pending body is frozen while native edit authority is separately reread by delivery', async () => {
  const store = new Ledger();
  const q = new ChatwootInboundQueue(store, async () => {
    throw new Error('unavailable');
  });
  const original = item();
  await q.submit(original);
  const edited = item();
  edited.payload.message.conversation = 'new native edit';
  edited.payloadHash = inboundPayloadHash(edited.payload);
  await q.submit(edited);
  assert.equal(store.rows.get(original.id)?.payloadHash, original.payloadHash);
  await q.stop();
});
test('expired crash lease is recovered, live lease is not stolen', async () => {
  const store = new Ledger();
  await store.enqueue(item());
  await store.claim(item().id, 'crashed', new Date(0), new Date(100));
  let clock = 99,
    attempts = 0;
  const q = new ChatwootInboundQueue(
    store,
    async () => {
      attempts++;
      return ack();
    },
    () => {},
    20,
    100,
    () => new Date(clock),
  );
  await q.poll();
  assert.equal(attempts, 0);
  clock = 101;
  await q.poll();
  assert.equal(attempts, 1);
  await q.stop();
});
test('source hash includes content/context/time/sender but excludes CW mapping', () => {
  const b = source(),
    h = inboundPayloadHash(b);
  assert.equal(h, inboundPayloadHash({ ...b, chatwootMessageId: 9, chatwootInboxId: 33 }));
  for (const x of [
    { ...b, message: { conversation: 'changed' } },
    { ...b, contextInfo: { stanzaId: 'parent' } },
    { ...b, pushName: 'other' },
    { ...b, messageTimestamp: 1700000001 },
  ])
    assert.notEqual(h, inboundPayloadHash(x));
});
test('invalid ACK never confirms pending source', async () => {
  const store = new Ledger();
  const q = new ChatwootInboundQueue(store, async () => ({ id: 0, inbox_id: 42, conversation_id: 1 }));
  await q.submit(item());
  assert.equal(store.rows.get(item().id)?.state, 'pending');
  await q.stop();
});
test('confirmed duplicate notify does not re-create receiver', async () => {
  const store = new Ledger();
  let creates = 0;
  const q = new ChatwootInboundQueue(store, async () => {
    creates++;
    return ack();
  });
  await q.submit(item());
  await q.submit(item());
  assert.equal(creates, 1);
  await q.stop();
});
