import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatwootDeliveryFailureUpdate } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';

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
