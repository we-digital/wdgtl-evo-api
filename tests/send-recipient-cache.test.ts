import assert from 'node:assert/strict';
import test from 'node:test';

import { SendRecipientCache } from '@api/integrations/channel/whatsapp/send-recipient-cache';

type Resolved = { jid: string; exists: boolean };

test('memoizes positive recipient resolutions until the TTL expires', async () => {
  let clock = 0;
  let loads = 0;
  const cache = new SendRecipientCache<Resolved>(1_000, 10, () => clock);
  const load = async () => {
    loads += 1;
    return { jid: 'synthetic@s.whatsapp.net', exists: true };
  };
  const cacheable = (value: Resolved) => value.exists;

  await cache.resolve('a', load, cacheable);
  await cache.resolve('a', load, cacheable);
  assert.equal(loads, 1);
  clock = 1_000;
  await cache.resolve('a', load, cacheable);
  assert.equal(loads, 2);
});

test('never memoizes a negative resolution and forgets on delete or clear', async () => {
  let loads = 0;
  const cache = new SendRecipientCache<Resolved>(60_000, 10);
  const missing = async () => {
    loads += 1;
    return { jid: 'synthetic@s.whatsapp.net', exists: false };
  };
  await cache.resolve('a', missing, (value) => value.exists);
  await cache.resolve('a', missing, (value) => value.exists);
  assert.equal(loads, 2);

  const present = async () => ({ jid: 'synthetic@s.whatsapp.net', exists: true });
  await cache.resolve('b', present, (value) => value.exists);
  assert.equal(cache.size, 1);
  cache.delete('b');
  assert.equal(cache.get('b'), undefined);
  await cache.resolve('b', present, (value) => value.exists);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('bounds the number of remembered recipients', () => {
  const cache = new SendRecipientCache<Resolved>(60_000, 2);
  cache.set('a', { jid: 'a', exists: true });
  cache.set('b', { jid: 'b', exists: true });
  cache.set('c', { jid: 'c', exists: true });
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c')?.jid, 'c');
});
