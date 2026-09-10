import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatwootDeliveryFailureUpdate,
  buildChatwootDeliverySuccessUpdate,
  isDeliverableChatwootOutgoing,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';

test('builds a correlated failed status update for the exact Chatwoot message', () => {
  assert.deepEqual(buildChatwootDeliveryFailureUpdate(7, 42, 314), {
    accountId: 7,
    conversationId: 42,
    messageId: 314,
    data: {
      status: 'failed',
      external_error: 'EVO WhatsApp delivery failed',
    },
  });
});

test('confirms a live send with the raw WhatsApp message id and clears only the stale transport error', () => {
  assert.deepEqual(buildChatwootDeliverySuccessUpdate(7, 42, 314, '3EB0ABC'), {
    accountId: 7,
    conversationId: 42,
    messageId: 314,
    data: {
      status: 'sent',
      source_id: '3EB0ABC',
      external_error: null,
    },
  });
});

test('identifies only deliverable outgoing webhooks for missing-instance failure reporting', () => {
  const outgoing = {
    message_type: 'outgoing',
    conversation: { messages: [{ source_id: null }] },
  };

  assert.equal(isDeliverableChatwootOutgoing(outgoing, '628123@s.whatsapp.net'), true);
  assert.equal(
    isDeliverableChatwootOutgoing(
      { message_type: 'outgoing', conversation: { messages: [{ source_id: 'WAID:internal' }] } },
      '628123@s.whatsapp.net',
    ),
    false,
  );
  assert.equal(isDeliverableChatwootOutgoing({ message_type: 'incoming', conversation: { messages: [{}] } }, '628123'), false);
  assert.equal(isDeliverableChatwootOutgoing(outgoing, '123456'), false);
});
