import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatwootErrorStatus,
  describeChatwootError,
  LidReconcileJob,
  LidReconcileScheduler,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-lid-reconcile';

// Same shape as @figuro/chatwoot-sdk ApiError for a status it has no message for.
function apiError(status: number, url = 'https://cw.synthetic/api/v1/accounts/1/contacts/search?q=1') {
  const error: any = new Error('Generic Error');
  error.name = 'ApiError';
  error.status = status;
  error.statusText = status === 429 ? 'Too Many Requests' : '';
  error.url = url;
  return error;
}

test('the real HTTP status replaces "Generic Error" and no query or ids leak', () => {
  assert.equal(chatwootErrorStatus(apiError(429)), 429);
  assert.equal(chatwootErrorStatus({ response: { status: 503 } }), 503);
  assert.equal(chatwootErrorStatus(new Error('x')), undefined);
  assert.equal(
    describeChatwootError(apiError(429)),
    'ApiError HTTP 429 Too Many Requests /api/v1/accounts/:id/contacts/search',
  );
  assert.equal(describeChatwootError(new Error('lookup 6281234567 failed')), 'Error: lookup <n> failed');
});

test('a burst of mappings is coalesced per instance+LID and runs one at a time', async () => {
  const runs: LidReconcileJob[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const scheduler = new LidReconcileScheduler(
    async (job) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      runs.push({ ...job });
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
    },
    () => {},
    { minIntervalMs: 0 },
  );
  scheduler.enqueue({ instanceName: 'a', lid: '1@lid', phoneJid: '10@s.whatsapp.net' });
  scheduler.enqueue({ instanceName: 'a', lid: '1@lid', phoneJid: '11@s.whatsapp.net' });
  scheduler.enqueue({ instanceName: 'b', lid: '1@lid', phoneJid: '10@s.whatsapp.net' });
  scheduler.stop();
  await scheduler.drain();
  assert.deepEqual(
    runs.map((r) => [r.instanceName, r.phoneJid]),
    [
      ['a', '11@s.whatsapp.net'],
      ['b', '10@s.whatsapp.net'],
    ],
  );
  assert.equal(maxInFlight, 1);
});

test('429 pauses the whole drain with backoff and retries the mapping; other errors are logged once', async () => {
  let now = 1_000_000;
  const events: [string, any][] = [];
  const calls: string[] = [];
  let throttle = 2;
  const scheduler = new LidReconcileScheduler(
    async (job) => {
      calls.push(job.lid);
      if (job.lid === 'x@lid' && throttle-- > 0) throw apiError(429);
      if (job.lid === 'bad@lid') throw apiError(500);
    },
    (event, fields) => events.push([event, fields]),
    { minIntervalMs: 0, backoffBaseMs: 5_000 },
    () => now,
  );
  scheduler.enqueue({ instanceName: 'a', lid: 'x@lid', phoneJid: '1@s.whatsapp.net' });
  scheduler.enqueue({ instanceName: 'a', lid: 'bad@lid', phoneJid: '2@s.whatsapp.net' });
  scheduler.stop();
  await scheduler.drain(); // x → 429, then paused: nothing else runs
  assert.deepEqual(calls, ['x@lid']);
  assert.equal(events[0][0], 'chatwoot_lid_reconcile_throttled');
  assert.equal(events[0][1].status, 429);
  assert.equal(events[0][1].pauseMs, 5_000);
  now += 5_000;
  await scheduler.drain(); // bad → 500 (logged), x → 429 again, pause doubles
  assert.deepEqual(calls, ['x@lid', 'bad@lid', 'x@lid']);
  const failed = events.find(([e]) => e === 'chatwoot_lid_reconcile_failed')![1];
  assert.equal(failed.status, 500);
  assert.match(failed.error, /HTTP 500/);
  assert.equal(events.filter(([e]) => e === 'chatwoot_lid_reconcile_throttled')[1][1].pauseMs, 10_000);
  now += 10_000;
  await scheduler.drain();
  assert.deepEqual(calls, ['x@lid', 'bad@lid', 'x@lid', 'x@lid']);
  assert.equal(scheduler.size, 0);
});

test('a mapping that stays throttled is given up after its attempts (stored reconcile repairs it later)', async () => {
  let now = 0;
  const events: string[] = [];
  const scheduler = new LidReconcileScheduler(
    async () => {
      throw apiError(429);
    },
    (event) => events.push(event),
    { minIntervalMs: 0, maxAttempts: 2, backoffBaseMs: 1 },
    () => now,
  );
  scheduler.enqueue({ instanceName: 'a', lid: 'x@lid', phoneJid: '1@s.whatsapp.net' });
  scheduler.stop();
  for (let i = 0; i < 5; i++) {
    await scheduler.drain();
    now += 1_000;
  }
  assert.deepEqual(events, ['chatwoot_lid_reconcile_throttled', 'chatwoot_lid_reconcile_failed']);
  assert.equal(scheduler.size, 0);
});

test('the pending set is bounded', () => {
  const scheduler = new LidReconcileScheduler(
    async () => {},
    () => {},
    { maxPending: 2 },
  );
  for (let i = 0; i < 5; i++) scheduler.enqueue({ instanceName: 'a', lid: i + '@lid', phoneJid: '1@s.whatsapp.net' });
  scheduler.stop();
  assert.equal(scheduler.size, 2);
});
