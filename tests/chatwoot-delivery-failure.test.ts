import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatwootDeliveryFailureUpdate,
  buildChatwootDeliverySuccessUpdate,
  isChatwootDeliveryFailureAcknowledged,
  isChatwootDeliverySuccessAcknowledged,
  isChatwootMessageDeletion,
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

  assert.equal(
    isChatwootDeliverySuccessAcknowledged({ id: 314, source_id: '3EB0ABC', status: 'sent' }, 314, '3EB0ABC'),
    true,
  );
  assert.equal(
    isChatwootDeliverySuccessAcknowledged({ id: 314, source_id: 'different', status: 'sent' }, 314, '3EB0ABC'),
    false,
  );
  assert.equal(
    isChatwootDeliverySuccessAcknowledged({ id: 314, source_id: '3EB0ABC', status: 'failed' }, 314, '3EB0ABC'),
    false,
  );
});

test('accepts a failed callback only when Chatwoot acknowledges the exact message', () => {
  assert.equal(isChatwootDeliveryFailureAcknowledged({ id: 314, status: 'failed' }, 314), true);
  assert.equal(isChatwootDeliveryFailureAcknowledged({ id: 315, status: 'failed' }, 314), false);
  assert.equal(isChatwootDeliveryFailureAcknowledged({ id: 314, status: 'sent' }, 314), false);
});

test('identifies only deliverable outgoing webhooks for missing-instance failure reporting', () => {
  const outgoing = {
    event: 'message_created',
    id: 314,
    message_type: 'outgoing',
    source_id: null,
    conversation: {},
  };

  assert.equal(isDeliverableChatwootOutgoing(outgoing, '628123@s.whatsapp.net'), true);
  assert.equal(
    isDeliverableChatwootOutgoing(
      { ...outgoing, source_id: 'WAID:internal' },
      '628123@s.whatsapp.net',
    ),
    false,
  );
  assert.equal(isDeliverableChatwootOutgoing({ ...outgoing, message_type: 'incoming' }, '628123'), false);
  assert.equal(
    isDeliverableChatwootOutgoing({ ...outgoing, event: 'message_updated', content_attributes: { deleted: true } }, '628123'),
    false,
  );
  assert.equal(isDeliverableChatwootOutgoing(outgoing, '123456'), false);
});

test('keeps the exact Chatwoot deletion event separate from outbound delivery', () => {
  const deletion = { event: 'message_updated', content_attributes: { deleted: true } };
  assert.equal(isChatwootMessageDeletion(deletion), true);
  assert.equal(isChatwootMessageDeletion({ ...deletion, content_attributes: { deleted: false } }), false);
  assert.equal(isDeliverableChatwootOutgoing({ ...deletion, id: 314, message_type: 'outgoing' }, '628123'), false);
});
