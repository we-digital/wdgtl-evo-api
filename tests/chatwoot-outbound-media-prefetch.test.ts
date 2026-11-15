import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OUTBOUND_MEDIA_PREFETCH_MAX_ENTRIES,
  OUTBOUND_MEDIA_PREFETCH_TTL_MS,
  OutboundMediaPrefetch,
  prefetchableChatwootUrl,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-media-prefetch';

const url = 'https://cw.example.test/rails/active_storage/blobs/redirect/synthetic/file.jpg';

test('one download per URL: peek keeps it, take consumes it', async () => {
  let fetches = 0;
  const prefetch = new OutboundMediaPrefetch(async () => {
    fetches += 1;
    return { data: Buffer.from('synthetic'), contentType: 'image/jpeg' };
  });
  prefetch.start(url);
  prefetch.start(url);
  assert.equal(fetches, 1);
  assert.equal((await prefetch.peek(url))?.contentType, 'image/jpeg');
  assert.equal(prefetch.bytes, 9);
  assert.equal((await prefetch.take(url))?.data.toString(), 'synthetic');
  assert.equal(prefetch.take(url), undefined);
  assert.equal(prefetch.size, 0);
  assert.equal(prefetch.bytes, 0);
});

test('a failed download is forgotten so the send downloads normally', async () => {
  const prefetch = new OutboundMediaPrefetch(async () => {
    throw new Error('synthetic 500');
  });
  prefetch.start(url);
  assert.equal(await prefetch.take(url), null);
  assert.equal(prefetch.peek(url), undefined);
});

test('entries expire and the entry count stays bounded', async () => {
  let now = 0;
  const prefetch = new OutboundMediaPrefetch(
    async () => ({ data: Buffer.alloc(1) }),
    () => now,
  );
  prefetch.start(url);
  now = OUTBOUND_MEDIA_PREFETCH_TTL_MS + 1;
  assert.equal(prefetch.peek(url), undefined);
  for (let index = 0; index < OUTBOUND_MEDIA_PREFETCH_MAX_ENTRIES + 5; index += 1) prefetch.start(`${url}?${index}`);
  assert.equal(prefetch.size, OUTBOUND_MEDIA_PREFETCH_MAX_ENTRIES);
});

test('only https files on the Chatwoot host are prefetched', () => {
  assert.equal(prefetchableChatwootUrl(url, 'https://cw.example.test/'), true);
  assert.equal(prefetchableChatwootUrl(url, 'https://other.example.test'), false);
  assert.equal(prefetchableChatwootUrl('http://cw.example.test/file.jpg', 'https://cw.example.test'), false);
  assert.equal(prefetchableChatwootUrl(undefined, 'https://cw.example.test'), false);
  assert.equal(prefetchableChatwootUrl(url, null), false);
});
