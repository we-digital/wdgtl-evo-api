import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatwootInboundQueue,
  INBOUND_HISTORY_MAX_ATTEMPTS,
  InboundAck,
  InboundDelivery,
  inboundDeliveryId,
  inboundHistoryRetryDelayMs,
  inboundPayloadHash,
  inboundRetryDelayMs,
  InboundStore,
  InboundTerminalReason,
  InboundTerminalState,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';

class Ledger implements InboundStore {
  rows = new Map<string, InboundDelivery & { reason?: string; lastErrorClass?: string | null }>();
  async enqueue(item: InboundDelivery) {
    if (!this.rows.has(item.id)) this.rows.set(item.id, structuredClone(item));
    return structuredClone(this.rows.get(item.id)!);
  }
  async due(now: Date, limit: number) {
    return [...this.rows.values()]
      .filter((r) => ['pending', 'history_pending'].includes(r.state) && r.nextAttemptAt <= now && !r.leaseOwner)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
  async claim(id: string, owner: string, now: Date, until: Date) {
    const row = this.rows.get(id)!;
    if (!['pending', 'history_pending'].includes(row.state) || row.nextAttemptAt > now || row.leaseOwner) return false;
    Object.assign(row, { leaseOwner: owner, leaseExpiresAt: until, attempts: row.attempts + 1 });
    return true;
  }
  async renew() {
    return true;
  }
  async finish(id: string, owner: string, ack: InboundAck) {
    const r = this.rows.get(id)!;
    if (r.leaseOwner !== owner) return false;
    Object.assign(r, { state: 'confirmed', result: ack, leaseOwner: null });
    return true;
  }
  async defer(id: string, owner: string, error: string, until: Date) {
    const r = this.rows.get(id)!;
    if (r.leaseOwner !== owner) return;
    Object.assign(r, { nextAttemptAt: until, leaseOwner: null, lastErrorClass: error });
  }
  async fail(
    id: string,
    owner: string,
    state: InboundTerminalState,
    errorClass: string,
    _lane?: string,
    reason?: InboundTerminalReason,
  ) {
    const r = this.rows.get(id)!;
    if (r.leaseOwner !== owner) return false;
    Object.assign(r, { state, leaseOwner: null, lastErrorClass: errorClass, reason });
    return true;
  }
}

const row = (state: string, attempts: number, id = 'A'): InboundDelivery => {
  const payload = {
    key: { id, remoteJid: '120363000000000000@g.us', fromMe: false },
    messageType: 'conversation',
    messageTimestamp: 1700000000,
    message: { conversation: 'synthetic' },
  };
  return {
    id: inboundDeliveryId('one', payload),
    instanceId: 'one',
    instanceName: 'one',
    providerId: 'p',
    providerFingerprint: 'f'.repeat(64),
    accountId: 1,
    inboxId: 42,
    peer: payload.key.remoteJid,
    sourceId: 'WAID:' + id,
    fromMe: false,
    payload,
    payloadHash: inboundPayloadHash(payload),
    state,
    attempts,
    nextAttemptAt: new Date(0),
    leaseOwner: null,
    leaseExpiresAt: null,
    result: null,
    createdAt: new Date(),
  };
};

function queue(ledger: Ledger, error: string, events: [string, any][]) {
  return new ChatwootInboundQueue(
    ledger,
    async () => {
      throw new Error(error);
    },
    (event, fields) => events.push([event, fields]),
    undefined,
    120_000,
    () => new Date(),
    { historyMaxAttempts: 3 },
  );
}

test('a history row that keeps failing becomes failed after N attempts, with its reason and a metric', async () => {
  const ledger = new Ledger();
  const events: [string, any][] = [];
  const q = queue(ledger, 'InboundHistoryDestinationUnconfirmed', events);
  const item = row('history_pending', 1);
  await ledger.enqueue(item);
  await q.poll(); // attempt 2: still retryable
  assert.equal(ledger.rows.get(item.id)!.state, 'history_pending');
  ledger.rows.get(item.id)!.nextAttemptAt = new Date(0);
  await q.poll(); // attempt 3 = cap
  const stored = ledger.rows.get(item.id)!;
  assert.equal(stored.state, 'failed');
  assert.equal(stored.reason, 'attempts_exhausted');
  // The real error stays on the row, so recovery can still select and requeue it.
  assert.equal(stored.lastErrorClass, 'InboundHistoryDestinationUnconfirmed');
  const failed = events.find(([e]) => e === 'chatwoot_inbound_failed')![1];
  assert.equal(failed.reason, 'attempts_exhausted');
  assert.equal(failed.attempts, 3);
  q.reportLatency();
  const latency = events.find(([e, f]) => e === 'chatwoot_inbound_latency' && f.lane === 'history')![1];
  assert.equal(latency.failed, 1);
  assert.equal(latency.exhausted, 1);
});

test('a history row far past the cap (stuck since before the cap) closes on its next failure', async () => {
  const ledger = new Ledger();
  const events: [string, any][] = [];
  const q = queue(ledger, 'InboundHistoryDestinationUnconfirmed', events);
  const item = row('history_pending', 77);
  await ledger.enqueue(item);
  await q.poll();
  assert.equal(ledger.rows.get(item.id)!.state, 'failed');
});

test('receiver outages never use up history attempts', async () => {
  const ledger = new Ledger();
  const events: [string, any][] = [];
  const q = new ChatwootInboundQueue(
    ledger,
    async () => {
      const error = new Error('connect ECONNREFUSED');
      error.name = 'AxiosError';
      throw error;
    },
    (event, fields) => events.push([event, fields]),
    undefined,
    120_000,
    () => new Date(),
    { historyMaxAttempts: 3 },
  );
  const item = row('history_pending', 10);
  await ledger.enqueue(item);
  await q.poll();
  assert.equal(ledger.rows.get(item.id)!.state, 'history_pending');
});

test('the attempt cap is for the history lane only; live keeps its age cap', async () => {
  const ledger = new Ledger();
  const events: [string, any][] = [];
  const q = queue(ledger, 'InboundHistoryDestinationUnconfirmed', events);
  const item = row('pending', 10);
  await ledger.enqueue(item);
  await q.poll();
  assert.equal(ledger.rows.get(item.id)!.state, 'pending');
});

test('history retries back off to an hour; live keeps its steady 5 minutes', () => {
  assert.equal(INBOUND_HISTORY_MAX_ATTEMPTS, 12);
  assert.deepEqual(
    Array.from({ length: 11 }, (_, i) => inboundHistoryRetryDelayMs(i + 1)),
    [2_000, 5_000, 15_000, 30_000, 60_000, 300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000],
  );
  assert.equal(inboundRetryDelayMs(11), 300_000);
});
