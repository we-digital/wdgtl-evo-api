import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireHistoryWriter,
  enqueueIncrementalHistorySync,
  tryAcquireHistoryWriter,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync-coordinator';

test('shares one history writer lock across service instances and hands it over in order', async () => {
  const instanceName = 'coordinator-lock-test';
  const firstRelease = tryAcquireHistoryWriter(instanceName);
  assert.ok(firstRelease);
  assert.equal(tryAcquireHistoryWriter(instanceName), null);

  let acquired = false;
  const queued = acquireHistoryWriter(instanceName).then((release) => {
    acquired = true;
    release();
  });
  await Promise.resolve();
  assert.equal(acquired, false);

  firstRelease();
  await queued;
  assert.equal(acquired, true);
});

test('coalesces overlapping incremental requests and preserves the earliest requested timestamp', async () => {
  const instanceName = 'coordinator-coalesce-test';
  const calls: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    const runner = async (since: string) => {
      calls.push(since);
      if (calls.length === 1) {
        resolve();
        await firstGate;
      }
    };

    void enqueueIncrementalHistorySync(instanceName, '2026-08-31T10:00:00.000Z', runner);
  });

  await firstStarted;
  const second = enqueueIncrementalHistorySync(
    instanceName,
    '2026-08-31T09:45:00.000Z',
    async (since) => calls.push(since),
  );
  const third = enqueueIncrementalHistorySync(
    instanceName,
    '2026-08-31T09:50:00.000Z',
    async (since) => calls.push(since),
  );
  releaseFirst();
  await Promise.all([second, third]);

  assert.deepEqual(calls, ['2026-08-31T10:00:00.000Z', '2026-08-31T09:45:00.000Z']);
});
