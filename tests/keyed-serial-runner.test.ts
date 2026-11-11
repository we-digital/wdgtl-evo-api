import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyedSerialRunner } from '../src/utils/keyed-serial-runner';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('tasks of one key run in order; other keys do not wait for them', async () => {
  const runner = new KeyedSerialRunner();
  const log: string[] = [];
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
  void runner.run('chat-a', async () => {
    log.push('a1:start');
    await slow;
    log.push('a1:end');
  });
  void runner.run('chat-a', async () => {
    log.push('a2');
  });
  void runner.run('chat-b', async () => {
    log.push('b1');
  });
  await tick();
  await tick();
  assert.deepEqual(log, ['a1:start', 'b1']);
  releaseSlow();
  assert.equal(await runner.drain(1_000), true);
  assert.deepEqual(log, ['a1:start', 'b1', 'a1:end', 'a2']);
  assert.equal(runner.size, 0);
});

test('a failing task is reported and does not stop the next task of its key', async () => {
  const errors: string[] = [];
  const runner = new KeyedSerialRunner((key, error) => errors.push(`${key}:${(error as Error).message}`));
  const log: string[] = [];
  void runner.run('chat', async () => {
    throw new Error('boom');
  });
  void runner.run('chat', async () => {
    log.push('next');
  });
  assert.equal(await runner.drain(1_000), true);
  assert.deepEqual(errors, ['chat:boom']);
  assert.deepEqual(log, ['next']);
});

test('drain gives up after its timeout and reports unfinished work', async () => {
  const runner = new KeyedSerialRunner();
  let release!: () => void;
  void runner.run('chat', () => new Promise<void>((resolve) => (release = resolve)));
  assert.equal(await runner.drain(20), false);
  assert.equal(runner.size, 1);
  release();
  assert.equal(await runner.drain(1_000), true);
});
