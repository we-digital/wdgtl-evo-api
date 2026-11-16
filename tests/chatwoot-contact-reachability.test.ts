import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkContactReachability,
  parseReachabilityPhones,
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
