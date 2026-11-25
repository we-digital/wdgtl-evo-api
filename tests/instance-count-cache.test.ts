import assert from 'node:assert/strict';
import test from 'node:test';

import { InstanceCountCache } from '../src/api/services/instance-count-cache';

function repo(values: Record<string, number> = { a: 5, b: 7 }) {
  const calls: string[][] = [];
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const delegate = (factor: number) => ({
    groupBy: async ({ where }: any) => {
      calls.push(where.instanceId.in);
      if (gate) await gate;
      return where.instanceId.in.filter((id: string) => id in values)
        .map((id: string) => ({ instanceId: id, _count: { _all: values[id] * factor } }));
    },
  });
  const repository = { message: delegate(100), contact: delegate(10), chat: delegate(1) };
  return {
    repository, calls, values,
    hold() { gate = new Promise(r => { release = r; }); },
    release() { const r = release; gate = undefined; release = undefined; r?.(); },
  };
}

test('first call counts once per table and maps missing instances to zero', async () => {
  const r = repo();
  const cache = new InstanceCountCache(() => r.repository);
  const counts = await cache.get(['b', 'a', 'z', 'a']);
  assert.deepEqual(Object.fromEntries(counts), {
    a: { Message: 500, Contact: 50, Chat: 5 },
    b: { Message: 700, Contact: 70, Chat: 7 },
    z: { Message: 0, Contact: 0, Chat: 0 },
  });
  assert.deepEqual(r.calls, [['a', 'b', 'z'], ['a', 'b', 'z'], ['a', 'b', 'z']]);
});

test('fresh entries are served from memory', async () => {
  let now = 0;
  const r = repo();
  const cache = new InstanceCountCache(() => r.repository, 120_000, 1_800_000, () => now);
  await cache.get(['a']);
  now = 119_000;
  r.values.a = 9;
  assert.equal((await cache.get(['a'])).get('a')!.Message, 500);
  assert.equal(r.calls.length, 3);
});

test('stale entries answer at once and refresh once in the background', async () => {
  let now = 0;
  const r = repo();
  const cache = new InstanceCountCache(() => r.repository, 120_000, 1_800_000, () => now);
  await cache.get(['a']);
  now = 200_000;
  r.values.a = 9;
  r.hold();
  const stale = await Promise.all([cache.get(['a']), cache.get(['a']), cache.get(['a'])]);
  assert.ok(stale.every(c => c.get('a')!.Message === 500));
  assert.equal(r.calls.length, 6, 'three stale callers share one refresh');
  r.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await cache.get(['a'])).get('a')!.Message, 900);
  assert.equal(r.calls.length, 6);
});

test('entries past max staleness are recounted before answering; concurrent misses share it', async () => {
  let now = 0;
  const r = repo();
  const cache = new InstanceCountCache(() => r.repository, 120_000, 1_800_000, () => now);
  await cache.get(['a']);
  now = 1_900_000;
  r.values.a = 2;
  const [x, y] = await Promise.all([cache.get(['a']), cache.get(['a'])]);
  assert.equal(x.get('a')!.Message, 200);
  assert.equal(y.get('a')!.Message, 200);
  assert.equal(r.calls.length, 6);
});

test('a failed background refresh keeps the old counts and reports the error', async () => {
  let now = 0;
  const errors: unknown[] = [];
  const r = repo();
  const cache = new InstanceCountCache(() => r.repository, 120_000, 1_800_000, () => now, e => errors.push(e));
  await cache.get(['a']);
  now = 200_000;
  r.repository.message.groupBy = async () => { throw new Error('pool timeout'); };
  assert.equal((await cache.get(['a'])).get('a')!.Message, 500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal((await cache.get(['a'])).get('a')!.Message, 500);
});
