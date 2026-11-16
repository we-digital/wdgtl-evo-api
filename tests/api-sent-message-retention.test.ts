import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApiSentMessageRetention,
  apiSentMessageRetentionDays,
} from '../src/api/integrations/channel/whatsapp/api-sent-message-retention';

const logger = () => {
  const lines: string[] = [];
  return { lines, info: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) };
};

test('retention days default to 30, accept 0 (off) and ignore junk', () => {
  assert.equal(apiSentMessageRetentionDays(undefined), 30);
  assert.equal(apiSentMessageRetentionDays(''), 30);
  assert.equal(apiSentMessageRetentionDays('7'), 7);
  assert.equal(apiSentMessageRetentionDays('0'), 0);
  assert.equal(apiSentMessageRetentionDays('-1'), 30);
  assert.equal(apiSentMessageRetentionDays('1.5'), 30);
});

test('deletes rows older than the cutoff in batches until a short batch', async () => {
  const calls: unknown[][] = [];
  const counts = [3, 3, 1];
  const repository = { $executeRawUnsafe: async (sql: string, ...values: unknown[]) => { calls.push([sql, ...values]); return counts.shift() ?? 0; } };
  const now = Date.parse('2026-11-17T00:00:00Z');
  const log = logger();
  const retention = new ApiSentMessageRetention(repository, log, 30, { intervalMs: 1, firstDelayMs: 1, batch: 3, maxBatches: 10 }, () => now);
  assert.equal(await retention.runOnce(), 7);
  assert.equal(calls.length, 3);
  assert.match(String(calls[0][0]), /DELETE FROM "ApiSentMessage"/);
  assert.equal((calls[0][1] as Date).toISOString(), '2026-10-18T00:00:00.000Z');
  assert.equal(calls[0][2], 3);
  assert.match(log.lines[0], /"deleted":7/);
});

test('stops after maxBatches, never throws, and does nothing when off', async () => {
  let calls = 0;
  const full = { $executeRawUnsafe: async () => { calls += 1; return 2; } };
  assert.equal(await new ApiSentMessageRetention(full, logger(), 30, { intervalMs: 1, firstDelayMs: 1, batch: 2, maxBatches: 4 }).runOnce(), 8);
  assert.equal(calls, 4);

  const log = logger();
  const broken = { $executeRawUnsafe: async () => { throw new Error('db down'); } };
  assert.equal(await new ApiSentMessageRetention(broken, log, 30).runOnce(), 0);
  assert.match(log.lines[0], /api_sent_message_retention_failed/);

  calls = 0;
  const off = new ApiSentMessageRetention(full, logger(), 0);
  off.start();
  assert.equal(await off.runOnce(), 0);
  assert.equal(calls, 0);
  await off.stop();
});

test('start schedules runs and stop cancels them', async () => {
  let calls = 0;
  const repository = { $executeRawUnsafe: async () => { calls += 1; return 0; } };
  const retention = new ApiSentMessageRetention(repository, logger(), 30, { intervalMs: 5, firstDelayMs: 1, batch: 10, maxBatches: 1 });
  retention.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await retention.stop();
  const after = calls;
  assert.ok(after >= 2, `ran ${after} times`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, after);
});
