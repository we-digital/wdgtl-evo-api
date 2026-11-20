import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  ChatwootInboundPrismaStore,
  INBOUND_RETENTION_STATES,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-prisma-store';
import { canonicalInboundBody } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-native-source';
import {
  ChatwootInboundQueue,
  InboundDelivery,
  inboundDeliveryId,
  inboundPayloadHash,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';
import { ChatwootOutboundQueue } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';

// A synthetic document upsert as Baileys emits it: protobuf bytes are Uint8Arrays.
function documentBody() {
  const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256);
  return {
    key: { id: 'SYNTHETICDOC', remoteJid: '628000000000@s.whatsapp.net', fromMe: false },
    pushName: 'Synthetic',
    messageType: 'documentMessage',
    messageTimestamp: 1_800_000_000,
    message: {
      documentMessage: {
        mimetype: 'application/pdf',
        fileName: 'synthetic.pdf',
        mediaKey: bytes(32, 1),
        fileSha256: bytes(32, 2),
        fileEncSha256: bytes(32, 3),
        jpegThumbnail: bytes(20_000, 4),
        directPath: '/v/t62/synthetic',
      },
    },
  };
}

test('ledger payload in base64 form is ~10x smaller and its hash survives the database round trip', () => {
  const body = documentBody();
  const legacy = JSON.stringify(body);
  const payload = canonicalInboundBody(body);
  const compact = JSON.stringify(payload);
  assert(compact.length * 5 < legacy.length, `${compact.length} vs ${legacy.length}`);
  assert.equal(typeof payload.message.documentMessage.mediaKey, 'string');
  // The hash written with the row equals the one delivery recomputes from the stored JSON.
  const written = inboundPayloadHash(payload, true);
  assert.equal(written, inboundPayloadHash(JSON.parse(compact)));
  assert.equal(written, inboundPayloadHash(payload));
  // Identity is unchanged by the encoding.
  assert.equal(inboundDeliveryId('i', payload), inboundDeliveryId('i', body));
});

function fakeDelegate(rows: Partial<InboundDelivery & { updatedAt: Date }>[]) {
  const calls: any[] = [];
  return {
    calls,
    delegate: {
      upsert: async ({ where }: any) => rows.find((row) => row.id === where.id) as InboundDelivery,
      findMany: async (args: any) => {
        calls.push(['findMany', args]);
        return rows
          .filter(
            (row) =>
              args.where.state.in.includes(row.state) &&
              row.nextAttemptAt! < args.where.nextAttemptAt.lt &&
              row.updatedAt! < args.where.updatedAt.lt,
          )
          .slice(0, args.take)
          .map((row) => ({ id: row.id }));
      },
      deleteMany: async (args: any) => {
        calls.push(['deleteMany', args]);
        let count = 0;
        for (const id of args.where.id.in) {
          const index = rows.findIndex((row) => row.id === id && args.where.state.in.includes(row.state));
          if (index >= 0) {
            rows.splice(index, 1);
            count++;
          }
        }
        return { count };
      },
      updateMany: async (args: any) => {
        calls.push(['updateMany', args]);
        return { count: 1 };
      },
      groupBy: async () => [],
    },
  };
}

test('retention deletes only settled rows older than the cutoff, in bounded batches', async () => {
  const old = new Date('2026-10-01T00:00:00Z');
  const recent = new Date('2026-11-19T00:00:00Z');
  const rows = [
    ...INBOUND_RETENTION_STATES.map((state, i) => ({ id: 'old-' + i, state, nextAttemptAt: old, updatedAt: old })),
    { id: 'old-failed', state: 'failed', nextAttemptAt: old, updatedAt: old },
    { id: 'old-pending', state: 'history_pending', nextAttemptAt: old, updatedAt: old },
    { id: 'recent', state: 'confirmed', nextAttemptAt: recent, updatedAt: recent },
    { id: 'touched', state: 'confirmed', nextAttemptAt: old, updatedAt: recent },
  ];
  const fake = fakeDelegate(rows);
  const store = new ChatwootInboundPrismaStore({ chatwootInboundDelivery: fake.delegate } as any);
  const cutoff = new Date('2026-11-06T00:00:00Z');
  assert.equal(await store.prune(cutoff, 2), 2);
  assert.equal(await store.prune(cutoff, 2), 1);
  assert.equal(await store.prune(cutoff, 2), 0);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['old-failed', 'old-pending', 'recent', 'touched'],
  );
  const finds = fake.calls.filter(([name]) => name === 'findMany');
  assert(finds.every(([, args]) => args.take <= 2 && args.select?.id === true));
});

test('an ignored legacy row is not reopened by the same source in base64 form', async () => {
  const body = { ...documentBody(), message: { conversation: '' }, messageType: 'conversation' };
  const legacyPayload = JSON.parse(JSON.stringify(body));
  const stored = {
    id: inboundDeliveryId('i', body),
    state: 'ignored',
    payload: legacyPayload,
    payloadHash: inboundPayloadHash(legacyPayload),
  };
  const fake = fakeDelegate([stored as any]);
  const store = new ChatwootInboundPrismaStore({ chatwootInboundDelivery: fake.delegate } as any);
  const payload = canonicalInboundBody(body);
  const result = await store.enqueue({ ...stored, payload, payloadHash: inboundPayloadHash(payload, true) } as any);
  assert.equal(result.state, 'ignored');
  assert.equal(fake.calls.filter(([name]) => name === 'updateMany').length, 0);
});

test('idle inbound polling backs off to 4 s and returns to 1 s once work starts', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    let dueCalls = 0;
    const store: any = {
      due: async () => {
        dueCalls++;
        return [];
      },
    };
    const queue = new ChatwootInboundQueue(store, async () => ({ id: 1, inbox_id: 1, conversation_id: 1 }));
    queue.start();
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    await flush();
    const afterStart = dueCalls;
    // 1 s, then 2 s, then 4 s, then 4 s: 4 polls in 11 s instead of 11.
    for (let s = 0; s < 11; s++) {
      mock.timers.tick(1_000);
      await flush();
    }
    assert.equal(dueCalls - afterStart, 4);
    await queue.stop();
  } finally {
    mock.timers.reset();
  }
});

test('idle outbound polling probes one claim per class and backs off; wake() resets it', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    let claims = 0;
    const store: any = {
      recoverExpired: async () => 0,
      claim: async () => {
        claims++;
        return null;
      },
    };
    const queue = new ChatwootOutboundQueue(store, { observe() {} } as any, 1_000, 600_000, undefined, {
      transport: 4,
      maintenance: 2,
    });
    await queue.start();
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    mock.timers.tick(0);
    await flush();
    assert.equal(claims, 6); // first tick fills every slot
    claims = 0;
    for (let s = 0; s < 12; s++) {
      mock.timers.tick(1_000);
      await flush();
    }
    // Ticks at +1, +3, +7, +11 s, two claims each (was 6 claims every second = 72).
    assert.equal(claims, 8);
    claims = 0;
    queue.wake();
    mock.timers.tick(0);
    await flush();
    assert.equal(claims, 6);
    await queue.stop();
  } finally {
    mock.timers.reset();
  }
});
