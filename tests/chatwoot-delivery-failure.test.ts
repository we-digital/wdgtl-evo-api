import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatwootDeliveryFailureUpdate,
  buildChatwootDeliverySuccessUpdate,
  isChatwootDeliveryFailureAcknowledged,
  isChatwootDeliverySuccessAcknowledged,
  isChatwootProviderDeliveryAcknowledged,
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

const providerParts = [
  { partKey: 'part-0', partIndex: 0, partCount: 2, sourceId: 'WAID:part-0' },
  { partKey: 'part-1', partIndex: 1, partCount: 2, sourceId: 'WAID:part-1' },
];

test('builds a per-part provider delivery callback without changing the legacy request shape', () => {
  assert.deepEqual(buildChatwootDeliverySuccessUpdate(7, 42, 314, 'WAID:part-1', providerParts[1]), {
    accountId: 7,
    conversationId: 42,
    messageId: 314,
    data: {
      status: 'sent',
      source_id: 'WAID:part-1',
      external_error: null,
      provider_delivery: { part_key: 'part-1', part_index: 1, part_count: 2 },
    },
  });
  assert.equal('provider_delivery' in buildChatwootDeliverySuccessUpdate(7, 42, 314, 'WAID:single').data, false);
});

test('accepts exact partial and complete provider acknowledgements independent of response mapping order', () => {
  const partial = {
    id: 314,
    status: 'failed',
    source_id: null,
    provider_delivery: {
      contract_version: 1,
      acknowledged: true,
      message_confirmed: false,
      part_key: 'part-1',
      part_index: 1,
      part_count: 2,
      acknowledged_part_count: 1,
      source_ids: [{ part_key: 'part-1', part_index: 1, source_id: 'WAID:part-1' }],
    },
  };
  assert.equal(isChatwootProviderDeliveryAcknowledged(partial, 314, providerParts[1], providerParts), true);

  const complete = {
    id: 314,
    status: 'sent',
    source_id: 'WAID:part-0',
    provider_delivery: {
      contract_version: 1,
      acknowledged: true,
      message_confirmed: true,
      part_key: 'part-0',
      part_index: 0,
      part_count: 2,
      acknowledged_part_count: 2,
      source_ids: [
        { part_key: 'part-1', part_index: 1, source_id: 'WAID:part-1' },
        { part_key: 'part-0', part_index: 0, source_id: 'WAID:part-0' },
      ],
    },
  };
  assert.equal(isChatwootProviderDeliveryAcknowledged(complete, 314, providerParts[0], providerParts), true);
  assert.equal(
    isChatwootProviderDeliveryAcknowledged({ meta: { scoped: true }, payload: complete }, 314, providerParts[0], providerParts),
    true,
  );
});

test('rejects provider acknowledgement conflicts and incomplete single-part confirmation', () => {
  const exactSingle = [{ partKey: 'part-0', partIndex: 0, partCount: 1, sourceId: 'WAID:part-0' }];
  const singleResponse = {
    id: 314,
    status: 'sent',
    source_id: 'WAID:part-0',
    provider_delivery: {
      contract_version: 1,
      acknowledged: true,
      message_confirmed: true,
      part_key: 'part-0',
      part_index: 0,
      part_count: 1,
      acknowledged_part_count: 1,
      source_ids: [{ part_key: 'part-0', part_index: 0, source_id: 'WAID:part-0' }],
    },
  };
  assert.equal(isChatwootProviderDeliveryAcknowledged(singleResponse, 314, exactSingle[0], exactSingle), true);
  assert.equal(
    isChatwootProviderDeliveryAcknowledged(
      {
        ...singleResponse,
        provider_delivery: { ...singleResponse.provider_delivery, source_ids: [] },
      },
      314,
      exactSingle[0],
      exactSingle,
    ),
    false,
  );
  assert.equal(
    isChatwootProviderDeliveryAcknowledged(
      {
        ...singleResponse,
        provider_delivery: {
          ...singleResponse.provider_delivery,
          source_ids: [{ part_key: 'part-0', part_index: 0, source_id: 'WAID:conflict' }],
        },
      },
      314,
      exactSingle[0],
      exactSingle,
    ),
    false,
  );
  assert.equal(isChatwootProviderDeliveryAcknowledged({ ...singleResponse, id: 315 }, 314, exactSingle[0], exactSingle), false);
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
  assert.equal(isDeliverableChatwootOutgoing({ ...outgoing, message_type: 1 }, '628123@s.whatsapp.net'), true);
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
