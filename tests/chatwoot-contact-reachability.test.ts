import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkContactReachability,
  LocalLookupBudgetStore,
  parseReachabilityPhones,
  RedisLookupBudgetStore,
  takeLookupBudget,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-contact-reachability';

test('parses up to 10 distinct E.164 phones and drops anything else', () => {
  const phones = parseReachabilityPhones({
    phones: ['+6281234567890', '6281234567890', 'abc', '+0123', 42, ...Array.from({ length: 12 }, (_, i) => `+1555010${i}00`)],
  });
  assert.equal(phones[0], '+6281234567890');
  assert.equal(phones.length, 10);
  assert.ok(phones.every((phone) => /^\+[1-9][0-9]{6,14}$/.test(phone)));
  assert.deepEqual(parseReachabilityPhones({}), []);
});

test('one batched check answers every phone', async () => {
  const asked: string[][] = [];
  const reply = await checkContactReachability(['+6281111111', '+6282222222', '+6283333333'], async (numbers) => {
    asked.push(numbers);
    return [
      { number: '6281111111', exists: true, jid: '6281111111@s.whatsapp.net' },
      { number: '6282222222', exists: false, jid: '6282222222@s.whatsapp.net' },
    ];
  });
  assert.deepEqual(asked, [['6281111111', '6282222222', '6283333333']]);
  assert.deepEqual(reply, {
    status: 'ok',
    results: [
      { phone: '+6281111111', reachable: true, jid: '6281111111@s.whatsapp.net' },
      { phone: '+6282222222', reachable: false, jid: null, reason: 'not_on_whatsapp' },
      { phone: '+6283333333', reachable: null, jid: null, reason: 'no_answer' },
    ],
  });
});

test('a LID answer keeps reachable without a phone jid', async () => {
  const reply = await checkContactReachability(['+6281111111'], async () => [
    { number: '6281111111', exists: true, jid: '123456789@lid' },
  ]);
  assert.deepEqual(reply, { status: 'ok', results: [{ phone: '+6281111111', reachable: true, jid: null }] });
});

test('timeouts and failures are coded errors', async () => {
  assert.deepEqual(await checkContactReachability(['+6281111111'], () => new Promise(() => undefined), 20), {
    status: 'error',
    code: 'timeout',
  });
  assert.deepEqual(
    await checkContactReachability(['+6281111111'], async () => {
      throw new Error('socket');
    }),
    { status: 'error', code: 'failed' },
  );
  assert.deepEqual(await checkContactReachability([], async () => []), { status: 'error', code: 'invalid_request' });
});

test('numbers over the budget are rate limited without asking WhatsApp', async () => {
  const asked: string[][] = [];
  const reply = await checkContactReachability(
    ['+6281111111', '+6282222222'],
    async (numbers) => {
      asked.push(numbers);
      return [{ number: '6281111111', exists: true, jid: '6281111111@s.whatsapp.net' }];
    },
    1000,
    1,
  );
  assert.deepEqual(asked, [['6281111111']]);
  assert.deepEqual(reply, {
    status: 'ok',
    results: [
      { phone: '+6281111111', reachable: true, jid: '6281111111@s.whatsapp.net' },
      { phone: '+6282222222', reachable: null, jid: null, reason: 'rate_limited' },
    ],
  });
  let called = false;
  const none = await checkContactReachability(
    ['+6281111111'],
    async () => {
      called = true;
      return [];
    },
    1000,
    0,
  );
  assert.equal(called, false);
  assert.deepEqual(none, { status: 'ok', results: [{ phone: '+6281111111', reachable: null, jid: null, reason: 'rate_limited' }] });
});

test('the per-instance budget counts hour and day windows per instance', async () => {
  const store = new LocalLookupBudgetStore();
  const limits = { hour: 3, day: 4 };
  assert.equal(await takeLookupBudget(store, 'a', 2, limits), 2);
  assert.equal(await takeLookupBudget(store, 'a', 2, limits), 1);
  assert.equal(await takeLookupBudget(store, 'a', 1, limits), 0);
  assert.equal(await takeLookupBudget(store, 'b', 1, limits), 1);
});

test('the Redis budget sets the window expiry once', async () => {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const client = {
    incrBy: async (key: string, n: number) => {
      counts.set(key, (counts.get(key) ?? 0) + n);
      calls.push(`incrBy ${key.split(':').slice(0, 4).join(':')}`);
      return counts.get(key);
    },
    expire: async (key: string) => calls.push(`expire ${key.split(':').slice(0, 4).join(':')}`),
  };
  const store = new RedisLookupBudgetStore(() => client, 'evo:');
  assert.equal(await store.incr('k', 1, 60), 1);
  assert.equal(await store.incr('k', 1, 60), 2);
  assert.deepEqual(calls, ['incrBy evo:k', 'expire evo:k', 'incrBy evo:k']);
});
