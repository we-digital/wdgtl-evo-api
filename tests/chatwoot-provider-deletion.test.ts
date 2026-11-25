import assert from 'node:assert/strict';
import test from 'node:test';

import {
  confirmProviderDeletionBeforeMarkingLocal,
  markWhatsappKeyDeleted,
  ProviderDeleteLimiter,
  providerDeleteFastPath,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-provider-deletion';

test('provider deletion marks the EVO row only after Chatwoot confirms the soft delete', async () => {
  const calls: string[] = [];

  const result = await confirmProviderDeletionBeforeMarkingLocal({
    softDelete: async () => {
      calls.push('soft-delete');
      return 'confirmed';
    },
    markLocal: async () => {
      calls.push('mark-local');
    },
  });

  assert.equal(result, 'confirmed');
  assert.deepEqual(calls, ['soft-delete', 'mark-local']);
});

test('provider deletion leaves the EVO row untouched when Chatwoot fails', async () => {
  let marked = false;

  await assert.rejects(
    confirmProviderDeletionBeforeMarkingLocal({
      softDelete: async () => {
        throw new Error('Chatwoot unavailable');
      },
      markLocal: async () => {
        marked = true;
      },
    }),
    /Chatwoot unavailable/,
  );

  assert.equal(marked, false);
});

test('the marked key keeps the WhatsApp identity and only adds deleted', () => {
  const key = { id: 'ABC', remoteJid: '62811@s.whatsapp.net', fromMe: false, participant: undefined };
  assert.deepEqual(markWhatsappKeyDeleted(key), { ...key, deleted: true });
  assert.deepEqual(key, { id: 'ABC', remoteJid: '62811@s.whatsapp.net', fromMe: false, participant: undefined });
  assert.deepEqual(markWhatsappKeyDeleted(null), { deleted: true });
  assert.deepEqual(markWhatsappKeyDeleted(['x']), { deleted: true });
});

test('fast path: unmapped and already-deleted rows end before any reconciliation', () => {
  const mapped = {
    key: { id: 'A', fromMe: false },
    status: 'DELIVERY_ACK',
    chatwootMessageId: 7,
    chatwootConversationId: 3,
  };
  assert.equal(providerDeleteFastPath(null), 'unmapped');
  assert.equal(providerDeleteFastPath({ ...mapped, chatwootMessageId: null }), 'unmapped');
  assert.equal(providerDeleteFastPath({ ...mapped, chatwootConversationId: 0 }), 'unmapped');
  assert.equal(providerDeleteFastPath({ ...mapped, status: 'DELETED' }), 'already_deleted');
  assert.equal(providerDeleteFastPath({ ...mapped, key: { id: 'A', deleted: true } }), 'already_deleted');
  // Already marked wins even without pointers (echo of our own staff delete).
  assert.equal(providerDeleteFastPath({ key: { deleted: true }, status: 'DELETED' }), 'already_deleted');
  assert.equal(providerDeleteFastPath(mapped), 'proceed');
});

test('limiter: at most N revokes run at once per instance, others wait; instances are independent', async () => {
  const limiter = new ProviderDeleteLimiter({ concurrency: 2 });
  let running = 0;
  let peak = 0;
  const gates: Array<() => void> = [];
  const task = () =>
    new Promise<string>((resolve) => {
      running++;
      peak = Math.max(peak, running);
      gates.push(() => {
        running--;
        resolve('ok');
      });
    });
  const runs = [1, 2, 3, 4, 5].map(() => limiter.run('i1', task));
  const other = limiter.run('i2', task);
  await new Promise((r) => setImmediate(r));
  assert.equal(gates.length, 3); // 2 for i1 + 1 for i2
  while (gates.length) {
    gates.shift()!();
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(await Promise.all([...runs, other]), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(peak, 3);
});

test('limiter: retries a failure with backoff, then gives up quietly and reports the final failure', async () => {
  const sleeps: number[] = [];
  const failures: Array<[number, boolean]> = [];
  const limiter = new ProviderDeleteLimiter({
    attempts: 3,
    backoffMs: [10, 20],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onFailure: (_id, _e, attempt, final) => failures.push([attempt, final]),
  });
  let calls = 0;
  assert.equal(
    await limiter.run('i1', async () => {
      calls++;
      if (calls < 2) throw new Error('lock timeout');
      return 'marked';
    }),
    'marked',
  );
  assert.equal(
    await limiter.run('i1', async () => {
      throw new Error('down');
    }),
    undefined,
  );
  assert.deepEqual(sleeps, [10, 10, 20]);
  assert.deepEqual(failures, [
    [1, false],
    [1, false],
    [2, false],
    [3, true],
  ]);
});

test('limiter: a full queue drops the revoke instead of growing without bound', async () => {
  const dropped: string[] = [];
  const limiter = new ProviderDeleteLimiter({ concurrency: 1, maxQueued: 1, onDrop: (id) => dropped.push(id) });
  let release!: () => void;
  const first = limiter.run('i1', () => new Promise<void>((r) => (release = r)));
  const second = limiter.run('i1', async () => 'second');
  assert.equal(await limiter.run('i1', async () => 'third'), undefined);
  assert.deepEqual(dropped, ['i1']);
  release();
  await first;
  assert.equal(await second, 'second');
});
