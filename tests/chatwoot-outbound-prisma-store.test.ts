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
      findMany: async () =>
        ['pending', 'callback_pending', 'failure_callback_pending', 'ambiguous', 'delete_pending'].includes(row.state)
          ? [{ ...row }]
          : [],
      count: async () => 0,
      updateMany: async ({ where, data }: any) => {
        if (
          where.id !== row.id ||
          (where.claimGeneration !== undefined && where.claimGeneration !== row.claimGeneration)
        )
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
  assert.equal(await store.markSending(row.id, 'same-worker', first!.claimGeneration, null, new Date()), false);
  assert.equal(await store.markSending(row.id, 'same-worker', second!.claimGeneration, null, new Date()), true);
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
    chatwootOutboundAdmissionGuard: { upsert: async () => ({}) },
    chatwootOutboundWebhookDelivery: {
      findUnique: async () => null,
      create: async () => ({}),
    },
  };
  (repository as any).$transaction = async (transaction: (client: any) => Promise<unknown>) => transaction(repository);
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

  await assert.rejects(
    () =>
      store.enqueue('instance-1', 314, 58, 42, changedParts, {
        deliveryId: 'delivery-changed',
        receivedAt: new Date(),
        maxBacklog: 100,
        maxOldestAgeMs: 60_000,
      }),
    /frozen with different/,
  );

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

test('authoritative deletion request recovers a previously quarantined frozen set', async () => {
  const rows = [
    { ...stored(0, 'quarantined'), leaseOwner: 'transport-worker', leaseExpiresAt: new Date(9_999_999) },
    { ...stored(1, 'quarantined'), leaseOwner: 'transport-worker', leaseExpiresAt: new Date(9_999_999) },
  ];
  const repository = {
    chatwootOutboundOperation: {
      updateMany: async ({ where, data }: any) => {
        const matching = rows.filter(
          (row) =>
            row.instanceId === where.instanceId &&
            row.chatwootMessageId === where.chatwootMessageId &&
            row.messageSetHash === where.messageSetHash &&
            row.state !== where.state.not,
        );
        matching.forEach((row) => Object.assign(row, data));
        return { count: matching.length };
      },
    },
  };
  const store = new ChatwootOutboundPrismaStore(repository as any);

  await store.requestDeletion(rows[0] as StoredChatwootOutboundOperation);

  assert.ok(rows.every((row) => row.state === 'delete_pending'));
  assert.ok(rows.every((row) => row.leaseOwner === null && row.leaseExpiresAt === null));
  assert.ok(rows.every((row) => row.nextAttemptAt instanceof Date));
});

test('releases transport leases immediately when callback maintenance becomes runnable', async () => {
  const now = new Date('2026-09-11T03:00:00.000Z');
  const rows: any[] = [
    { ...stored(0, 'sending'), leaseOwner: 'transport-worker', leaseExpiresAt: new Date(now.getTime() + 600_000) },
    { ...stored(1, 'preparing'), leaseOwner: 'transport-worker', leaseExpiresAt: new Date(now.getTime() + 600_000) },
  ];
  const matches = (row: any, where: any) =>
    (!where.id || (typeof where.id === 'string' ? row.id === where.id : row.id !== where.id.not)) &&
    (!where.instanceId || row.instanceId === where.instanceId) &&
    (!where.chatwootMessageId || row.chatwootMessageId === where.chatwootMessageId) &&
    (!where.messageSetHash || row.messageSetHash === where.messageSetHash) &&
    (!where.leaseOwner || row.leaseOwner === where.leaseOwner) &&
    (!where.claimGeneration || row.claimGeneration === where.claimGeneration) &&
    (!where.state || (where.state.in ? where.state.in.includes(row.state) : row.state === where.state));
  const operations = {
    updateMany: async ({ where, data }: any) => {
      const matching = rows.filter((row) => matches(row, where));
      matching.forEach((row) => Object.assign(row, data));
      return { count: matching.length };
    },
  };
  const repository = {
    chatwootOutboundOperation: operations,
    $transaction: async (transaction: (client: any) => Promise<void>) =>
      transaction({ chatwootOutboundOperation: operations }),
  };
  const store = new ChatwootOutboundPrismaStore(repository as any);

  await store.markCallbackPending(rows[0].id, 'transport-worker', 0, 'WAID:0', null, now);
  assert.deepEqual(
    { state: rows[0].state, leaseOwner: rows[0].leaseOwner, leaseExpiresAt: rows[0].leaseExpiresAt, next: rows[0].nextAttemptAt },
    { state: 'callback_pending', leaseOwner: null, leaseExpiresAt: null, next: now },
  );

  await store.markFailureCallbackPending(rows[1], 'transport-worker', 'PreparationFailed', now);
  assert.deepEqual(
    { state: rows[1].state, leaseOwner: rows[1].leaseOwner, leaseExpiresAt: rows[1].leaseExpiresAt, next: rows[1].nextAttemptAt },
    { state: 'failure_callback_pending', leaseOwner: null, leaseExpiresAt: null, next: now },
  );
});

for (const scenario of [
  {
    name: 'completion',
    leaderState: 'callback_pending',
    siblingState: 'callback_pending',
    invoke: (store: ChatwootOutboundPrismaStore, leader: StoredChatwootOutboundOperation) =>
      store.markMessageCompleted(leader, 'same-worker', new Date()),
  },
  {
    name: 'failure',
    leaderState: 'failure_callback_pending',
    siblingState: 'failure_callback_pending',
    invoke: (store: ChatwootOutboundPrismaStore, leader: StoredChatwootOutboundOperation) =>
      store.markMessageFailed(leader, 'same-worker', new Date()),
  },
] as const) {
  test(`atomically fences message-level ${scenario.name} when the leader lease is reclaimed before mutation`, async () => {
    const rows: any[] = [
      { ...stored(0, scenario.leaderState), leaseOwner: 'same-worker', claimGeneration: 1 },
      { ...stored(1, scenario.siblingState), leaseOwner: null, claimGeneration: 0 },
    ];
    let reclaimed = false;
    const matches = (row: any, where: any) => {
      if (typeof where.id === 'string' && row.id !== where.id) return false;
      if (where.id?.not && row.id === where.id.not) return false;
      if (where.instanceId !== undefined && row.instanceId !== where.instanceId) return false;
      if (where.chatwootMessageId !== undefined && row.chatwootMessageId !== where.chatwootMessageId) return false;
      if (where.messageSetHash !== undefined && row.messageSetHash !== where.messageSetHash) return false;
      if (where.leaseOwner !== undefined && row.leaseOwner !== where.leaseOwner) return false;
      if (where.claimGeneration !== undefined && row.claimGeneration !== where.claimGeneration) return false;
      if (typeof where.state === 'string' && row.state !== where.state) return false;
      if (where.state?.in && !where.state.in.includes(row.state)) return false;
      return true;
    };
    const operations = {
      count: async ({ where }: any) => rows.filter((row) => matches(row, where)).length,
      updateMany: async ({ where, data }: any) => {
        if (!reclaimed) {
          rows[0].claimGeneration = 2;
          reclaimed = true;
        }
        const matching = rows.filter((row) => matches(row, where));
        matching.forEach((row) => Object.assign(row, data));
        return { count: matching.length };
      },
    };
    const repository = {
      chatwootOutboundOperation: operations,
      $transaction: async (transaction: (client: any) => Promise<void>) =>
        transaction({ chatwootOutboundOperation: operations }),
    };
    const store = new ChatwootOutboundPrismaStore(repository as any);

    await assert.rejects(
      () => scenario.invoke(store, { ...rows[0], claimGeneration: 1 } as StoredChatwootOutboundOperation),
      /OutboundLeaseLost/,
    );

    assert.equal(rows[0].claimGeneration, 2);
    assert.equal(rows[0].state, scenario.leaderState);
    assert.equal(rows[1].state, scenario.siblingState);
  });
}

const admission = (deliveryId: string, receivedAt = new Date('2026-09-11T03:00:00.000Z')) => ({
  deliveryId,
  receivedAt,
  maxBacklog: 100,
  maxOldestAgeMs: 60_000,
});

const admissionRepository = (seedRows: any[] = []) => {
  const rows = seedRows;
  const receipts = new Map<string, any>();
  const lanes = new Map<string, bigint>();
  const operations = {
    findMany: async ({ where }: any) =>
      rows
        .filter(
          (row) =>
            (where.instanceId === undefined || row.instanceId === where.instanceId) &&
            (where.chatwootMessageId === undefined || row.chatwootMessageId === where.chatwootMessageId),
        )
        .sort((left, right) => left.partIndex - right.partIndex),
    count: async ({ where }: any) => rows.filter((row) => where.state.in.includes(row.state)).length,
    findFirst: async ({ where }: any) => {
      const active = rows
        .filter((row) => where.state.in.includes(row.state))
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
      return active[0] ? { createdAt: active[0].createdAt } : null;
    },
    create: async ({ data }: any) => {
      const row = {
        id: `created-${rows.length}`,
        state: 'pending',
        nextAttemptAt: data.webhookReceivedAt,
        preparationAttempts: 0,
        sendAttempts: 0,
        callbackAttempts: 0,
        claimGeneration: 0,
        createdAt: data.webhookReceivedAt,
        ...data,
      };
      rows.push(row);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const matching = rows.filter(
        (row) => row.instanceId === where.instanceId && row.chatwootMessageId === where.chatwootMessageId,
      );
      matching.forEach((row) => Object.assign(row, data));
      return { count: matching.length };
    },
  };
  const repository: any = {
    chatwootOutboundOperation: operations,
    chatwootOutboundAdmissionGuard: { upsert: async () => ({}) },
    chatwootOutboundWebhookDelivery: {
      findUnique: async ({ where }: any) => receipts.get(where.deliveryId) ?? null,
      create: async ({ data }: any) => {
        if (receipts.has(data.deliveryId)) throw new Error('duplicate delivery');
        receipts.set(data.deliveryId, data);
        return data;
      },
    },
    chatwootOutboundLane: {
      upsert: async ({ where, create }: any) => {
        const nextSequence = (lanes.get(where.laneKey) ?? 0n) + 1n;
        lanes.set(where.laneKey, nextSequence);
        return { ...create, nextSequence };
      },
    },
  };
  repository.$transaction = async (transaction: (client: any) => Promise<unknown>) => transaction(repository);
  return { repository, rows, receipts };
};

test('recovers a lost 202 idempotently and durably reserves every accepted delivery identifier', async () => {
  const memory = admissionRepository();
  const store = new ChatwootOutboundPrismaStore(memory.repository);

  const first = await store.enqueue('instance-1', 314, 58, 42, parts, admission('delivery-314'));
  assert.equal(first.recovered, false);
  assert.deepEqual(first.backlog, { depth: parts.length, oldestAt: admission('delivery-314').receivedAt });
  assert.deepEqual(await store.enqueue('instance-1', 314, 58, 42, parts, admission('delivery-314')), {
    recovered: true,
  });
  assert.deepEqual(await store.enqueue('instance-1', 314, 58, 42, parts, admission('delivery-retry')), {
    recovered: true,
  });

  assert.equal(memory.rows.length, parts.length);
  assert.equal(memory.receipts.size, 2);
  await assert.rejects(
    () => store.enqueue('different-instance', 999, 58, 42, parts, admission('delivery-retry')),
    (error: any) => error?.name === 'ChatwootWebhookReplayRejected',
  );
  assert.equal(memory.rows.length, parts.length);
});

test('recovers a pre-upgrade retained set when new numeric contact context is present', async () => {
  const legacyRows = parts.map((part, index) => ({
    ...stored(index, 'pending'),
    ...part,
    createdAt: admission('original-delivery').receivedAt,
  }));
  const upgradedParts = buildChatwootOutboundParts({
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
    origin: { ...origin, contactId: 411, contactInboxId: 733 },
  });
  const memory = admissionRepository(legacyRows);
  const store = new ChatwootOutboundPrismaStore(memory.repository);

  assert.deepEqual(await store.enqueue('instance-1', 314, 58, 42, upgradedParts, admission('retry-delivery')), {
    recovered: true,
  });
  assert.ok(memory.rows.every((row) => row.state === 'pending'));
  assert.equal(memory.receipts.size, 1);
});

test('rejects a changed numeric contact identity after it has been frozen', async () => {
  const initialParts = buildChatwootOutboundParts({
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
    origin: { ...origin, contactId: 411, contactInboxId: 733 },
  });
  const replayParts = initialParts.map((part) => ({
    ...part,
    payload: { ...part.payload, origin: { ...part.payload.origin, contactId: 412 } },
  }));
  const memory = admissionRepository(
    initialParts.map((part, index) => ({
      ...stored(index, 'pending'),
      ...part,
      createdAt: admission('original-delivery').receivedAt,
    })),
  );
  const store = new ChatwootOutboundPrismaStore(memory.repository);

  await assert.rejects(
    () => store.enqueue('instance-1', 314, 58, 42, replayParts, admission('changed-contact-delivery')),
    /frozen with different/,
  );
  assert.ok(memory.rows.every((row) => row.state === 'quarantined'));
});

test('rejects capacity and oldest-age admission while preparing or sending work is still active', async () => {
  const old = new Date('2026-09-11T02:00:00.000Z');
  const memory = admissionRepository([
    { ...stored(0, 'preparing'), createdAt: old },
    { ...stored(1, 'sending'), createdAt: old },
  ]);
  const store = new ChatwootOutboundPrismaStore(memory.repository);
  const anotherOrigin = { ...origin, messageId: 315, conversationId: 43 };
  const anotherParts = buildChatwootOutboundParts({
    instanceId: 'instance-1',
    body: {
      event: 'message_created',
      id: 315,
      account: { id: 7 },
      inbox: { id: 58 },
      conversation: { id: 43 },
      attachments: [],
    },
    chatId: 'another-destination',
    formattedText: 'next',
    origin: anotherOrigin,
  });

  await assert.rejects(
    () =>
      store.enqueue('instance-1', 315, 58, 43, anotherParts, {
        ...admission('delivery-315'),
        maxBacklog: 2,
      }),
    (error: any) => error?.name === 'ChatwootOutboundBacklogExceeded',
  );
  await assert.rejects(
    () =>
      store.enqueue('instance-1', 315, 58, 43, anotherParts, {
        ...admission('delivery-315'),
        maxBacklog: 100,
        maxOldestAgeMs: 1_000,
      }),
    (error: any) => error?.name === 'ChatwootOutboundBacklogTooOld',
  );
  assert.equal(memory.rows.length, 2);
  assert.equal(memory.receipts.size, 0);
});

test('claims independent destinations concurrently but preserves exact same-lane predecessor order', async () => {
  const laneA = 'a'.repeat(64);
  const laneB = 'b'.repeat(64);
  const now = new Date('2026-09-11T03:00:00.000Z');
  const rows: any[] = [
    { ...stored(0, 'preparing'), id: 'lane-a-1', laneKey: laneA, laneSequence: 1n, partIndex: 0, createdAt: now },
    { ...stored(0, 'pending'), id: 'lane-a-2', laneKey: laneA, laneSequence: 2n, partIndex: 0, createdAt: now },
    { ...stored(0, 'pending'), id: 'lane-b-1', laneKey: laneB, laneSequence: 1n, partIndex: 0, createdAt: now },
  ];
  const operations = {
    findMany: async () => rows.filter((row) => row.state === 'pending' && !row.leaseOwner),
    count: async ({ where }: any) => {
      const lane = where.OR?.[0]?.laneKey;
      const beforeSequence = where.OR?.[0]?.OR?.[0]?.laneSequence?.lt;
      return rows.filter(
        (row) =>
          row.laneKey === lane &&
          row.laneSequence < beforeSequence &&
          ['pending', 'preparing', 'sending', 'ambiguous', 'delete_pending'].includes(row.state),
      ).length;
    },
    updateMany: async ({ where, data }: any) => {
      const row = rows.find((candidate) => candidate.id === where.id && candidate.state === where.state);
      if (!row) return { count: 0 };
      Object.assign(row, data, { claimGeneration: row.claimGeneration + 1 });
      return { count: 1 };
    },
  };
  const store = new ChatwootOutboundPrismaStore({ chatwootOutboundOperation: operations } as any);

  const independent = await store.claim('worker-1', now, new Date(now.getTime() + 1_000), 'transport');
  assert.equal(independent?.id, 'lane-b-1');
  rows[0].state = 'callback_pending';
  const sameLaneNext = await store.claim('worker-2', now, new Date(now.getTime() + 1_000), 'transport');
  assert.equal(sameLaneNext?.id, 'lane-a-2');
});

test('paginates beyond 64 blocked candidates to claim an independent runnable lane', async () => {
  const now = new Date('2026-09-11T03:00:00.000Z');
  const rows: any[] = Array.from({ length: 64 }, (_, index) => ({
    ...stored(0, 'pending'),
    id: `blocked-${String(index).padStart(2, '0')}`,
    laneKey: `blocked-${String(index).padStart(2, '0')}`.padEnd(64, 'x'),
    laneSequence: 2n,
    leaseOwner: null,
    nextAttemptAt: now,
    createdAt: new Date(now.getTime() + index),
  }));
  rows.push({
    ...stored(0, 'pending'),
    id: 'runnable-65',
    laneKey: 'runnable'.padEnd(64, 'x'),
    laneSequence: 1n,
    leaseOwner: null,
    nextAttemptAt: now,
    createdAt: new Date(now.getTime() + 64),
  });
  let pages = 0;
  const operations = {
    findMany: async ({ cursor, skip = 0, take }: any) => {
      pages += 1;
      const cursorIndex = cursor ? rows.findIndex((row) => row.id === cursor.id) : -1;
      const start = cursor ? cursorIndex + skip : 0;
      return rows.slice(start, start + take);
    },
    count: async ({ where }: any) => (String(where.OR?.[0]?.laneKey).startsWith('blocked-') ? 1 : 0),
    updateMany: async ({ where, data }: any) => {
      const row = rows.find((candidate) => candidate.id === where.id && candidate.state === where.state);
      if (!row) return { count: 0 };
      Object.assign(row, data, { claimGeneration: row.claimGeneration + 1 });
      return { count: 1 };
    },
  };
  const store = new ChatwootOutboundPrismaStore({ chatwootOutboundOperation: operations } as any);

  assert.equal(
    (await store.claim('worker', now, new Date(now.getTime() + 1_000), 'transport'))?.id,
    'runnable-65',
  );
  assert.equal(pages, 2);
});

test('reserves callback capacity for a settled multipart leader only', async () => {
  const now = new Date('2026-09-11T03:00:00.000Z');
  const rows: any[] = [
    { ...stored(0, 'callback_pending', 'WAID:0'), leaseOwner: null, nextAttemptAt: now, createdAt: now },
    { ...stored(1, 'pending'), leaseOwner: null, nextAttemptAt: now, createdAt: now },
  ];
  const operations = {
    findMany: async () => rows.filter((row) => ['callback_pending', 'failure_callback_pending'].includes(row.state)),
    count: async () =>
      rows.filter((row) => ['pending', 'preparing', 'sending', 'ambiguous', 'delete_pending'].includes(row.state))
        .length,
    updateMany: async ({ where, data }: any) => {
      const row = rows.find((candidate) => candidate.id === where.id && candidate.state === where.state);
      if (!row) return { count: 0 };
      Object.assign(row, data, { claimGeneration: row.claimGeneration + 1 });
      return { count: 1 };
    },
  };
  const store = new ChatwootOutboundPrismaStore({ chatwootOutboundOperation: operations } as any);

  assert.equal(await store.claim('callback-worker', now, new Date(now.getTime() + 1_000), 'maintenance'), null);
  rows[1].state = 'callback_pending';
  rows[1].whatsappMessageId = 'WAID:1';
  assert.equal(
    (await store.claim('callback-worker', now, new Date(now.getTime() + 1_000), 'maintenance'))?.id,
    'operation-0',
  );
});

test('serializes deletion maintenance for sibling parts in the same lane', async () => {
  const now = new Date('2026-09-11T03:00:00.000Z');
  const laneKey = 'd'.repeat(64);
  const rows: any[] = [
    { ...stored(0, 'delete_pending'), laneKey, laneSequence: 1n, leaseOwner: null, nextAttemptAt: now, createdAt: now },
    { ...stored(1, 'delete_pending'), laneKey, laneSequence: 1n, leaseOwner: null, nextAttemptAt: now, createdAt: now },
  ];
  const operations = {
    findMany: async () => rows.filter((row) => row.state === 'delete_pending' && !row.leaseOwner),
    count: async ({ where }: any) => {
      const before = where.OR?.[0]?.OR;
      return rows.filter(
        (row) =>
          row.state === 'delete_pending' &&
          row.laneKey === where.OR?.[0]?.laneKey &&
          (row.laneSequence < before?.[0]?.laneSequence?.lt ||
            (row.laneSequence === before?.[1]?.laneSequence && row.partIndex < before?.[1]?.partIndex?.lt)),
      ).length;
    },
    updateMany: async ({ where, data }: any) => {
      const row = rows.find((candidate) => candidate.id === where.id && candidate.state === where.state);
      if (!row) return { count: 0 };
      Object.assign(row, data, { claimGeneration: row.claimGeneration + 1 });
      return { count: 1 };
    },
  };
  const store = new ChatwootOutboundPrismaStore({ chatwootOutboundOperation: operations } as any);

  const leader = await store.claim('delete-worker-1', now, new Date(now.getTime() + 1_000), 'maintenance');
  assert.equal(leader?.partIndex, 0);
  assert.equal(await store.claim('delete-worker-2', now, new Date(now.getTime() + 1_000), 'maintenance'), null);
});
