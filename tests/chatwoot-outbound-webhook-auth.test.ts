import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { verifyChatwootOutboundWebhook } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-webhook-auth';

const secret = 's'.repeat(32);
const rawBody = Buffer.from('{"event":"message_created","id":314}');
const now = new Date('2026-09-11T03:00:00.000Z');
const timestamp = String(Math.floor(now.getTime() / 1_000));
const signature = (key: string, body = rawBody, signedTimestamp = timestamp) =>
  `sha256=${createHmac('sha256', key).update(`${signedTimestamp}.`).update(body).digest('hex')}`;
const headers = (overrides: Record<string, string> = {}) => ({
  'x-chatwoot-delivery': 'delivery-314',
  'x-chatwoot-timestamp': timestamp,
  'x-chatwoot-signature': signature(secret),
  ...overrides,
});

test('verifies the exact Chatwoot timestamp-dot-raw-body signature contract', () => {
  assert.deepEqual(
    verifyChatwootOutboundWebhook({
      rawBody,
      headers: headers(),
      secrets: { current: secret },
      now,
      maxAgeMs: 300_000,
      maxBodyBytes: 1_024,
    }),
    { deliveryId: 'delivery-314', timestampSeconds: Number(timestamp), receivedAt: now },
  );
});

test('rejects tampered bodies, stale timestamps, malformed signatures, and oversized bodies', () => {
  const verify = (body: Buffer, headerValues = headers()) =>
    verifyChatwootOutboundWebhook({
      rawBody: body,
      headers: headerValues,
      secrets: { current: secret },
      now,
      maxAgeMs: 300_000,
      maxBodyBytes: 1_024,
    });

  assert.throws(
    () => verify(Buffer.from('{"event":"message_created","id":315}')),
    (error: any) => error.status === 401 && /signature/.test(error.message),
  );
  const staleTimestamp = String(Number(timestamp) - 301);
  assert.throws(
    () =>
      verify(
        rawBody,
        headers({
          'x-chatwoot-timestamp': staleTimestamp,
          'x-chatwoot-signature': signature(secret, rawBody, staleTimestamp),
        }),
      ),
    (error: any) => error.status === 401 && /Expired/.test(error.message),
  );
  assert.throws(
    () => verify(rawBody, headers({ 'x-chatwoot-signature': 'not-a-signature' })),
    (error: any) => error.status === 401 && /Signature/.test(error.message),
  );
  assert.throws(
    () =>
      verifyChatwootOutboundWebhook({
        rawBody: Buffer.alloc(1_025),
        headers: headers(),
        secrets: { current: secret },
        now,
        maxAgeMs: 300_000,
        maxBodyBytes: 1_024,
      }),
    /body size/,
  );
});

test('accepts the previous secret only inside the explicit rotation overlap', () => {
  const previous = 'p'.repeat(32);
  const previousHeaders = headers({ 'x-chatwoot-signature': signature(previous) });
  const verify = (previousValidUntil: Date) =>
    verifyChatwootOutboundWebhook({
      rawBody,
      headers: previousHeaders,
      secrets: { current: secret, previous, previousValidUntil },
      now,
      maxAgeMs: 300_000,
      maxBodyBytes: 1_024,
    });

  assert.equal(verify(new Date(now.getTime() + 1_000)).deliveryId, 'delivery-314');
  assert.throws(() => verify(new Date(now.getTime() - 1)), /signature/);
});
