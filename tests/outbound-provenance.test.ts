import assert from 'node:assert/strict';
import test from 'node:test';

import { attachOutboundProvenance, resolveOutboundRequestId } from '@api/types/outbound-provenance';

test('preserves a safe caller request ID and rejects unsafe values', () => {
  const opaqueRequestId = '5ae4fa35-0193-4b77-8440-45d8628f7597';

  assert.equal(resolveOutboundRequestId(opaqueRequestId), opaqueRequestId);
  assert.notEqual(resolveOutboundRequestId('628123456789'), '628123456789');
  assert.match(resolveOutboundRequestId('unsafe request id'), /^[0-9a-f-]{36}$/);
});

test('stores provenance alongside existing message context without replacing it', () => {
  assert.deepEqual(
    attachOutboundProvenance(
      { contextInfo: { quotedMessageId: 'quoted-1' }, message: { conversation: 'hello' } },
      { version: 1, origin: 'api', requestId: 'request-1' },
    ),
    {
      contextInfo: {
        quotedMessageId: 'quoted-1',
        weDigitalOutbound: { version: 1, origin: 'api', requestId: 'request-1' },
      },
      message: { conversation: 'hello' },
    },
  );
});
