import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatwootInboundQueue,
  INBOUND_UNSUPPORTED_SKIPPED,
  INBOUND_UNSUPPORTED_TYPES,
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

test('live bursts and polling share two slots; overflow stays unleased and eventually confirms once', async () => {
  const store = new Ledger();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let active = 0;
  let peak = 0;
  const deliveries = new Map<string, number>();
  const queue = new ChatwootInboundQueue(store, async (row) => {
    peak = Math.max(peak, ++active);
    deliveries.set(row.id, (deliveries.get(row.id) || 0) + 1);
    await gate;
    active--;
    return ack();
  });
  const rows = Array.from({ length: 26 }, (_, i) => item(`burst-${i}`));
  const submissions = rows.map((row) => queue.submit(row));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.rows.size, 26);
  assert.equal(peak, 2);
  for (const row of rows.slice(2)) {
    assert.equal(store.rows.get(row.id)!.leaseOwner, null);
    assert.equal(store.rows.get(row.id)!.attempts, 0);
  }
  const duplicate = queue.submit(rows[0]);
  await queue.poll();
  assert.equal(peak, 2);
  release();
  await Promise.all([...submissions, duplicate]);
  for (let i = 0; i < 4; i++) await queue.poll();
  assert.equal([...store.rows.values()].filter((row) => row.state === 'confirmed').length, 26);
  assert.equal(deliveries.size, 26);
  assert([...deliveries.values()].every((count) => count === 1));
  assert.equal(peak, 2);
  assert.deepEqual(await queue.submit(rows[2]), ack());
  assert.equal(deliveries.get(rows[2].id), 1);
  await queue.stop();
});

test('shutdown drains active receivers and leaves burst overflow recoverable by a new queue', async () => {
  const store = new Ledger();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const delivered: string[] = [];
  const queue = new ChatwootInboundQueue(store, async (row) => {
    delivered.push(row.id);
    await gate;
    return ack();
  });
  const rows = Array.from({ length: 5 }, (_, i) => item(`restart-${i}`));
  const submissions = rows.map((row) => queue.submit(row));
  await new Promise<void>((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = queue.stop().then(() => (stopped = true));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  const late = item('after-stop');
  assert.equal(await queue.submit(late), undefined);
  assert.equal(store.rows.get(late.id)!.attempts, 0);
  release();
  await Promise.all([...submissions, stopping]);
  assert.equal(stopped, true);
  const resumed = new ChatwootInboundQueue(store, async (row) => {
    delivered.push(row.id);
    return ack();
  });
  await resumed.poll();
  assert.equal(store.rows.size, 6);
  assert([...store.rows.values()].every((row) => row.state === 'confirmed'));
  assert.equal(new Set(delivered).size, delivered.length);
  assert.equal(delivered.length, 6);
  await resumed.stop();
});

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

test('installed SDK Buffer JSON serialization does not rotate frozen native source hash', () => {
  const original = {
    ...source(),
    messageType: 'imageMessage',
    message: { imageMessage: { fileSha256: Buffer.alloc(32, 7), mediaKey: Buffer.alloc(32, 9) } },
  };
  const persisted = JSON.parse(JSON.stringify(original));
  const before = JSON.stringify(original);
  assert.equal(inboundPayloadHash(original), inboundPayloadHash(persisted));
  assert.equal(JSON.stringify(original), before);
  persisted.message.imageMessage.fileSha256.data[0] = 8;
  assert.notEqual(inboundPayloadHash(original), inboundPayloadHash(persisted));
});

test('unsupported types close at once as ignored, without a delivery attempt or retry', async () => {
  class Terminal extends Ledger {
    async fail(id: string, owner: string, state: any, errorClass: string) {
      const r = this.rows.get(id)!;
      if (r.leaseOwner !== owner) return false;
      Object.assign(r, { state, lastErrorClass: errorClass, leaseOwner: null, leaseExpiresAt: null });
      this.events.push(state);
      return true;
    }
  }
  for (const type of ['lottieStickerMessage', 'templateMessage', 'buttonsMessage', 'pollCreationMessageV3']) {
    assert.equal(INBOUND_UNSUPPORTED_TYPES.has(type), true, type);
    const store = new Terminal();
    let delivered = 0;
    const q = new ChatwootInboundQueue(store, async () => (delivered++, ack()));
    const sticker = item();
    sticker.payload = { ...sticker.payload, messageType: type, message: { [type]: {} } } as any;
    sticker.payloadHash = inboundPayloadHash(sticker.payload);
    await q.submit(sticker);
    assert.equal(delivered, 0);
    assert.equal(store.rows.get(sticker.id)?.state, 'ignored');
    assert.equal(store.rows.get(sticker.id)?.lastErrorClass, INBOUND_UNSUPPORTED_SKIPPED);
    await q.stop();
  }
  // Supported types, album child photos included, still deliver.
  assert.equal(INBOUND_UNSUPPORTED_TYPES.has('associatedChildMessage'), false);
  assert.equal(INBOUND_UNSUPPORTED_TYPES.has('stickerMessage'), false);
});

test('admit only commits the ledger row; deliverAdmitted then delivers it once', async () => {
  const store = new Ledger();
  const delivered: string[] = [];
  const queue = new ChatwootInboundQueue(store, async (row) => {
    delivered.push(row.id);
    return ack();
  });
  const row = item('admit-only');
  const stored = await queue.admit(row);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.rows.get(row.id)!.state, 'pending');
  assert.deepEqual(delivered, []);
  assert.deepEqual(await queue.deliverAdmitted(stored), ack());
  assert.deepEqual(delivered, [row.id]);
  // A confirmed row is answered from the ledger without another delivery.
  assert.deepEqual(await queue.deliverAdmitted(await queue.admit(row)), ack());
  assert.deepEqual(delivered, [row.id]);
  await queue.stop();
});

test('deliverAdmitted waits for a busy chat instead of falling back to the poller', async () => {
  const store = new Ledger();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  const order: string[] = [];
  const queue = new ChatwootInboundQueue(store, async (row) => {
    order.push(row.payload.key.id);
    if (row.payload.key.id === 'first') await firstGate;
    return ack();
  });
  const make = (id: string): InboundDelivery => {
    const base = item('same-chat');
    const payload = { ...base.payload, key: { ...base.payload.key, id } };
    return {
      ...base,
      id: inboundDeliveryId('same-chat', payload),
      sourceId: `WAID:${id}`,
      payload,
      payloadHash: inboundPayloadHash(payload),
    };
  };
  const first = await queue.admit(make('first'));
  const second = await queue.admit(make('second'));
  const firstDelivery = queue.deliverAdmitted(first);
  const secondDelivery = queue.deliverAdmitted(second, 5_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first']);
  releaseFirst();
  assert.deepEqual(await firstDelivery, ack());
  assert.deepEqual(await secondDelivery, ack());
  assert.deepEqual(order, ['first', 'second']);
  await queue.stop();
});

test('deliverAdmitted gives up after its wait and leaves the row to the poller', async () => {
  const store = new Ledger();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const queue = new ChatwootInboundQueue(store, async () => {
    await gate;
    return ack();
  });
  const busy = await queue.admit(item('busy-a'));
  const waiting = await queue.admit(item('busy-b'));
  const third = await queue.admit(item('busy-c'));
  const running = [queue.deliverAdmitted(busy), queue.deliverAdmitted(waiting)];
  // Two slots are taken (default concurrency 2): the third times out quickly.
  assert.equal(await queue.deliverAdmitted(third, 20), undefined);
  assert.equal(store.rows.get(third.id)!.state, 'pending');
  assert.equal(store.rows.get(third.id)!.leaseOwner ?? null, null);
  release();
  await Promise.all(running);
  await queue.poll();
  assert.equal(store.rows.get(third.id)!.state, 'confirmed');
  await queue.stop();
});
