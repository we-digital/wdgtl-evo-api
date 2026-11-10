import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalInboundBody,
  inboundAcceptedSourceHashes,
  inboundHistoryDocumentProjection,
  inboundSourceCandidates,
  inboundSourceIdentityHash,
  isInboundTransportOnly,
  resolveInboundNativeBody,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-native-source';
import {
  ChatwootInboundQueue,
  InboundAck,
  InboundDelivery,
  inboundDeliveryId,
  inboundPayloadHash,
  inboundRetryDelayMs,
  InboundStore,
  InboundTerminalState,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';

const b64 = (byte: number, length = 32) => Buffer.alloc(length, byte).toString('base64');
const numeric = (base64: string) =>
  Object.fromEntries([...Buffer.from(base64, 'base64')].map((byte, i) => [String(i), byte]));

class Ledger implements InboundStore {
  rows = new Map<string, InboundDelivery>();
  async enqueue(item: InboundDelivery) {
    if (!this.rows.has(item.id)) this.rows.set(item.id, structuredClone(item));
    return structuredClone(this.rows.get(item.id)!);
  }
  async due(now: Date, limit: number) {
    const active = [...this.rows.values()].filter(
      (r) =>
        ['pending', 'history_pending'].includes(r.state) &&
        r.nextAttemptAt <= now &&
        (!r.leaseExpiresAt || r.leaseExpiresAt < now),
    );
    const order = (rows: InboundDelivery[]) =>
      rows.sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.id.localeCompare(b.id));
    return [
      ...order(active.filter((r) => r.state === 'pending' && r.attempts === 0)),
      ...order(active.filter((r) => r.state === 'pending' && r.attempts > 0)),
      ...order(active.filter((r) => r.state === 'history_pending')),
    ]
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
  async claim(id: string, owner: string, now: Date, until: Date) {
    const row = this.rows.get(id)!;
    if (
      !['pending', 'history_pending'].includes(row.state) ||
      row.nextAttemptAt > now ||
      (row.leaseExpiresAt && row.leaseExpiresAt >= now)
    )
      return false;
    Object.assign(row, { leaseOwner: owner, leaseExpiresAt: until, attempts: row.attempts + 1 });
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
    return true;
  }
  async defer(id: string, owner: string, errorClass: string, until: Date) {
    const r = this.rows.get(id)!;
    if (r.leaseOwner !== owner) return;
    Object.assign(r, { nextAttemptAt: until, lastErrorClass: errorClass, leaseOwner: null, leaseExpiresAt: null });
  }
  async fail(id: string, owner: string, state: InboundTerminalState, errorClass: string) {
    const r = this.rows.get(id)!;
    if (r.leaseOwner !== owner) return false;
    Object.assign(r, { state, lastErrorClass: errorClass, leaseOwner: null, leaseExpiresAt: null });
    return true;
  }
}

function row(
  key: string,
  peer = '120363000000000000@g.us',
  state = 'pending',
  createdAt = new Date(0),
  nextAttemptAt = createdAt,
): InboundDelivery {
  const payload = {
    key: { id: key, remoteJid: peer, fromMe: false },
    messageType: 'conversation',
    messageTimestamp: Math.floor(createdAt.getTime() / 1000) || 1,
    message: { conversation: 'synthetic ' + key },
  };
  return {
    id: inboundDeliveryId('one', payload),
    instanceId: 'one',
    instanceName: 'one',
    providerId: 'p',
    providerFingerprint: 'f'.repeat(64),
    accountId: 1,
    inboxId: 42,
    peer,
    sourceId: 'WAID:' + key,
    fromMe: false,
    payload,
    payloadHash: inboundPayloadHash(payload),
    state,
    attempts: 0,
    nextAttemptAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    result: null,
    createdAt,
  };
}
const ack = (id = 1): InboundAck => ({ id, inbox_id: 42, conversation_id: 77 });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('retry backoff is bounded: 2s, 5s, 15s, 30s, 60s, then every 5 minutes', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 9275].map(inboundRetryDelayMs),
    [2_000, 5_000, 15_000, 30_000, 60_000, 300_000, 300_000, 300_000],
  );
});

test('retries follow the schedule and reach a visible terminal failed state after the cap', async () => {
  const store = new Ledger();
  let clock = 0;
  const events: [string, any][] = [];
  const queue = new ChatwootInboundQueue(
    store,
    async () => {
      throw new Error('InboundReceiverOutcomeUnconfirmed');
    },
    (event, fields) => events.push([event, fields]),
    undefined,
    100,
    () => new Date(clock),
    { failAfterMs: 3_600_000 },
  );
  const item = row('cap');
  await queue.submit(item);
  assert.equal(store.rows.get(item.id)!.nextAttemptAt.getTime(), 2_000);
  clock = 2_000;
  await queue.poll();
  assert.equal(store.rows.get(item.id)!.nextAttemptAt.getTime(), 7_000);
  clock = 3_600_000;
  await queue.poll();
  const final = store.rows.get(item.id)!;
  assert.equal(final.state, 'failed');
  assert.equal(final.lastErrorClass, 'InboundReceiverOutcomeUnconfirmed');
  assert.equal(final.attempts, 3);
  const failed = events.find(([event]) => event === 'chatwoot_inbound_failed');
  assert.ok(failed);
  assert.equal(failed[1].errorClass, 'InboundReceiverOutcomeUnconfirmed');
  // Terminal rows are never claimed again, and a repeated notify does not reopen them.
  clock = 10_000_000;
  await queue.poll();
  assert.equal(store.rows.get(item.id)!.attempts, 3);
  assert.equal(await queue.submit(item), undefined);
  assert.equal(store.rows.get(item.id)!.attempts, 3);
  await queue.stop();
});

test('deterministic transport-only rows close as ignored on the first attempt', async () => {
  const store = new Ledger();
  const events: string[] = [];
  const queue = new ChatwootInboundQueue(
    store,
    async () => {
      throw new Error('InboundTransportOnly');
    },
    (event) => events.push(event),
  );
  const item = row('skd');
  await queue.submit(item);
  assert.equal(store.rows.get(item.id)!.state, 'ignored');
  assert.deepEqual(events, ['chatwoot_inbound_ignored']);
  await queue.stop();
});

test('ten writers in parallel, one in-flight delivery per chat, per-chat order preserved', async () => {
  const store = new Ledger();
  const order = new Map<string, string[]>();
  let active = 0,
    peak = 0;
  const perChat = new Map<string, number>();
  let chatPeak = 0;
  const queue = new ChatwootInboundQueue(
    store,
    async (item) => {
      peak = Math.max(peak, ++active);
      const inChat = (perChat.get(item.peer) || 0) + 1;
      perChat.set(item.peer, inChat);
      chatPeak = Math.max(chatPeak, inChat);
      order.set(item.peer, [...(order.get(item.peer) || []), item.sourceId]);
      await tick();
      perChat.set(item.peer, inChat - 1);
      active--;
      return ack();
    },
    () => {},
    undefined,
    100,
    () => new Date(1_000_000),
    { concurrency: 10 },
  );
  for (let chat = 0; chat < 15; chat++)
    for (let n = 0; n < 4; n++)
      await store.enqueue(row(`c${chat}-m${n}`, `1203630000000000${String(chat).padStart(2, '0')}@g.us`, 'pending', new Date(n * 1000)));
  await queue.poll();
  assert.equal([...store.rows.values()].filter((r) => r.state === 'confirmed').length, 60);
  assert.equal(peak, 10);
  assert.equal(chatPeak, 1);
  for (const [, ids] of order) assert.deepEqual(ids, [...ids].sort());
  await queue.stop();
});

test('a retrying row does not block a new live message, and history never takes more than half the slots', async () => {
  const store = new Ledger();
  const now = new Date(10_000_000);
  const stuck = row('stuck', '111@s.whatsapp.net', 'pending', new Date(0), new Date(0));
  stuck.attempts = 9275;
  await store.enqueue(stuck);
  for (let i = 0; i < 8; i++) {
    const history = row('h' + i, `2${i}@s.whatsapp.net`, 'history_pending', new Date(0));
    history.instanceId = 'inst' + (i % 4);
    history.id = inboundDeliveryId(history.instanceId, history.payload);
    await store.enqueue(history);
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started: string[] = [];
  let historyActive = 0,
    historyPeak = 0;
  const queue = new ChatwootInboundQueue(
    store,
    async (item) => {
      started.push(item.sourceId);
      if (item.state === 'history_pending') historyPeak = Math.max(historyPeak, ++historyActive);
      if (item.sourceId === 'WAID:stuck') throw new Error('InboundReceiverContentChanged');
      await gate;
      if (item.state === 'history_pending') historyActive--;
      return ack();
    },
    () => {},
    undefined,
    100,
    () => now,
    { concurrency: 4 },
  );
  const polling = queue.poll();
  await tick();
  await tick();
  // The live retry went first, then history filled at most half of the 4 slots.
  assert.equal(started[0], 'WAID:stuck');
  assert.equal(historyPeak, 2);
  const fresh = row('fresh', '111@s.whatsapp.net', 'pending', now, now);
  const live = queue.submit(fresh);
  await tick();
  assert.ok(started.includes('WAID:fresh'), 'fresh live message in the same chat is not blocked by the retrying row');
  release();
  await Promise.all([polling, live]);
  assert.equal(store.rows.get(fresh.id)!.state, 'confirmed');
  assert.equal(store.rows.get(stuck.id)!.state, 'pending');
  assert.ok(store.rows.get(stuck.id)!.nextAttemptAt.getTime() >= now.getTime() + 300_000);
  await queue.stop();
});

test('confirmed deliveries report WhatsApp-to-confirmed latency p50/p95 per lane', async () => {
  const store = new Ledger();
  const events: [string, any][] = [];
  const now = new Date(1_700_000_010_000);
  const queue = new ChatwootInboundQueue(
    store,
    async () => ack(),
    (event, fields) => events.push([event, fields]),
    undefined,
    100,
    () => now,
  );
  for (let i = 0; i < 20; i++) {
    const item = row('l' + i, `3${i}@s.whatsapp.net`, 'pending', new Date(now.getTime() - 1_000));
    item.payload.messageTimestamp = Math.floor(now.getTime() / 1000) - (i + 1);
    item.payloadHash = inboundPayloadHash(item.payload);
    await queue.submit(item);
  }
  const confirmed = events.filter(([event]) => event === 'chatwoot_inbound_confirmed');
  assert.equal(confirmed.length, 20);
  assert.equal(confirmed[0][1].providerLatencyMs, 1_000);
  assert.equal(confirmed[0][1].queueLatencyMs, 1_000);
  queue.reportLatency();
  const [, report] = events.find(([event]) => event === 'chatwoot_inbound_latency')!;
  assert.equal(report.lane, 'live');
  assert.equal(report.confirmed, 20);
  assert.equal(report.providerP50Ms, 10_000);
  assert.equal(report.providerP95Ms, 19_000);
  await queue.stop();
});

// ---- Native source identity (prod error classes) ----

const native = () => ({
  id: 'native-row',
  instanceId: 'one',
  key: { id: 'A', remoteJid: '120363000000000000@g.us', fromMe: false, participant: '123@lid' },
  messageType: 'conversation',
  messageTimestamp: 1700000000,
  pushName: 'sender',
  message: { conversation: 'synthetic', messageContextInfo: { messageSecret: b64(7) } },
});

test('a base64 native row and its numeric-key frozen payload are the same source (history InboundNativeSourceAmbiguous)', () => {
  const stored = native();
  const frozen: any = structuredClone(stored);
  frozen.message.messageContextInfo.messageSecret = numeric(stored.message.messageContextInfo.messageSecret);
  assert.notEqual(inboundPayloadHash(stored), inboundPayloadHash(frozen));
  const resolved = resolveInboundNativeBody([stored], frozen);
  assert.equal(inboundSourceIdentityHash(resolved), inboundSourceIdentityHash(stored));
  assert.equal(inboundPayloadHash(canonicalInboundBody(frozen)), inboundPayloadHash(stored));
});

test('byte fields outside the old name list normalize too (thumbnailSha256, streamingSidecar, waveform)', () => {
  for (const [type, field] of [
    ['documentMessage', 'thumbnailSha256'],
    ['videoMessage', 'streamingSidecar'],
    ['audioMessage', 'waveform'],
    ['imageMessage', 'scansSidecar'],
  ]) {
    const row: any = { ...native(), messageType: type, message: { [type]: { mediaKey: b64(1), [field]: b64(2, 10) } } };
    const frozen: any = structuredClone(row);
    frozen.message[type][field] = numeric(row.message[type][field]);
    frozen.message[type].mediaKey = { type: 'Buffer', data: [...Buffer.from(row.message[type].mediaKey, 'base64')] };
    assert.equal(inboundSourceIdentityHash(frozen), inboundSourceIdentityHash(row), field);
    assert.doesNotThrow(() => resolveInboundNativeBody([row], frozen));
  }
});

test('the delivered body carries base64 media keys that Baileys can decrypt (pending Error: bad decrypt)', () => {
  const row: any = {
    ...native(),
    messageType: 'imageMessage',
    message: { imageMessage: { caption: 'c', mediaKey: b64(4), fileSha256: b64(5), fileEncSha256: b64(6) } },
  };
  const frozen: any = structuredClone(row);
  frozen.message.imageMessage.mediaKey = numeric(row.message.imageMessage.mediaKey);
  const body = resolveInboundNativeBody([], frozen);
  assert.equal(typeof body.message.imageMessage.mediaKey, 'string');
  assert.equal(body.message.imageMessage.mediaKey, row.message.imageMessage.mediaKey);
});

test('download locators are not identity, cryptographic media fields are', () => {
  const row: any = {
    ...native(),
    messageType: 'documentMessage',
    message: {
      documentMessage: { mediaKey: b64(1), fileSha256: b64(2), fileEncSha256: b64(3), url: 'https://a', directPath: '/a' },
    },
  };
  const refreshed = structuredClone(row);
  refreshed.message.documentMessage.url = 'https://b';
  refreshed.message.documentMessage.directPath = '/b';
  refreshed.message.mediaUrl = 'https://s3.synthetic/object';
  assert.equal(inboundSourceIdentityHash(refreshed), inboundSourceIdentityHash(row));
  const other = structuredClone(row);
  other.message.documentMessage.fileSha256 = b64(9);
  assert.notEqual(inboundSourceIdentityHash(other), inboundSourceIdentityHash(row));
  const caption = structuredClone(row);
  caption.message.documentMessage.caption = 'changed';
  assert.notEqual(inboundSourceIdentityHash(caption), inboundSourceIdentityHash(row));
  // Two native rows that differ only by locators are not ambiguous.
  assert.doesNotThrow(() => resolveInboundNativeBody([row, refreshed], row));
  assert.throws(() => resolveInboundNativeBody([row, other], row), /InboundNativeSourceAmbiguous/);
});

test('accepted receiver stamps cover both encodings of the same source and nothing else', () => {
  const stored = native();
  const frozen: any = structuredClone(stored);
  frozen.message.messageContextInfo.messageSecret = numeric(stored.message.messageContextInfo.messageSecret);
  const accepted = inboundAcceptedSourceHashes(stored, frozen);
  assert.ok(accepted.has(inboundPayloadHash(frozen)));
  assert.ok(accepted.has(inboundPayloadHash(stored)));
  const changed = { ...stored, message: { ...stored.message, conversation: 'other' } };
  assert.equal(accepted.has(inboundPayloadHash(changed)), false);
});

test('sender-key-only blank copies are transport; text with sender keys is not', () => {
  const skd = { groupId: '120363000000000000@g.us', axolotlSenderKeyDistributionMessage: b64(1, 8) };
  assert.equal(isInboundTransportOnly({ ...native(), message: { conversation: '', senderKeyDistributionMessage: skd } }), true);
  assert.equal(isInboundTransportOnly({ ...native(), message: { conversation: 'hi', senderKeyDistributionMessage: skd } }), false);
  assert.equal(isInboundTransportOnly({ ...native(), message: { conversation: '' } }), false);
});

test('reaction rows under the same key are excluded unless the queued source is itself a reaction', () => {
  const content = native();
  const reaction = { ...native(), id: 'r', messageType: 'reactionMessage', message: { reactionMessage: { text: 'x' } } };
  assert.deepEqual(inboundSourceCandidates([content, reaction], content), [content]);
  assert.deepEqual(inboundSourceCandidates([content, reaction], reaction), [content, reaction]);
});

test('importer projection accepts an unchanged image that gained a retained mediaUrl (was InboundHistorySourceUnconfirmed)', async () => {
  const row: any = {
    ...native(),
    key: { id: 'A', remoteJid: '628000000000@s.whatsapp.net', fromMe: true },
    messageType: 'imageMessage',
    message: { imageMessage: { mimetype: 'image/jpeg', mediaKey: b64(1), fileSha256: b64(2), fileEncSha256: b64(3) } },
  };
  const queued: any = structuredClone(row);
  queued.message.imageMessage.mediaKey = numeric(row.message.imageMessage.mediaKey);
  row.message.mediaUrl = 'https://s3.synthetic/image.jpg';
  const projected = await inboundHistoryDocumentProjection(row, queued);
  assert.equal(projected.key.id, 'A');
  const changed = structuredClone(queued);
  changed.message.imageMessage.fileSha256 = numeric(b64(8));
  await assert.rejects(inboundHistoryDocumentProjection(row, changed), /InboundHistorySourceChanged/);
  await assert.rejects(
    inboundHistoryDocumentProjection({ ...row, messageType: 'conversation' }, queued),
    /InboundHistorySourceUnconfirmed/,
  );
});

test('history of one instance runs one delivery at a time (the stored-history importer is a per-instance writer)', async () => {
  const store = new Ledger();
  for (let i = 0; i < 6; i++) await store.enqueue(row('s' + i, `4${i}@s.whatsapp.net`, 'history_pending', new Date(0)));
  let active = 0,
    peak = 0;
  const queue = new ChatwootInboundQueue(
    store,
    async () => {
      peak = Math.max(peak, ++active);
      await tick();
      active--;
      return ack();
    },
    () => {},
    undefined,
    100,
    () => new Date(1_000),
    { concurrency: 10 },
  );
  await queue.poll();
  assert.equal(peak, 1);
  assert.equal([...store.rows.values()].filter((r) => r.state === 'confirmed').length, 6);
  await queue.stop();
});

test('a present-but-unverifiable receiver owner closes as already_present and is never reopened by a notify', async () => {
  const store = new Ledger();
  const events: string[] = [];
  const queue = new ChatwootInboundQueue(
    store,
    async () => {
      throw new Error('InboundReceiverPresentUnverified');
    },
    (event) => events.push(event),
  );
  const item = row('present');
  await queue.submit(item);
  assert.equal(store.rows.get(item.id)!.state, 'already_present');
  assert.deepEqual(events, ['chatwoot_inbound_already_present']);
  assert.equal(await queue.submit(item), undefined);
  assert.equal(store.rows.get(item.id)!.attempts, 1);
  await queue.stop();
});
