import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatwootIngressDeliveryFence,
  chatwootIngressDeliveryKey,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-delivery-fence';

test('uses one delivery for concurrent append and notify events with the same provider identity', async () => {
  const fence = new ChatwootIngressDeliveryFence(20);
  const key = chatwootIngressDeliveryKey({
    event: 'messages.upsert',
    instanceId: 'instance-1',
    whatsappMessageId: 'provider-message-1',
  });
  assert.ok(key);

  let deliveries = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deliver = async () => {
    deliveries += 1;
    await blocked;
    return { id: 42 };
  };

  const append = fence.run(key, deliver);
  const notify = fence.run(key, deliver);
  release();

  assert.deepEqual(await Promise.all([append, notify]), [{ id: 42 }, { id: 42 }]);
  assert.equal(deliveries, 1);

  assert.deepEqual(await fence.run(key, deliver), { id: 42 });
  assert.equal(deliveries, 1);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(await fence.run(key, deliver), { id: 42 });
  assert.equal(deliveries, 2);
});

test('releases a failed delivery immediately for a safe retry', async () => {
  const fence = new ChatwootIngressDeliveryFence();
  let attempts = 0;
  const deliver = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary failure');
    return { id: 84 };
  };

  await assert.rejects(fence.run('instance-1:provider-message-2', deliver), /temporary failure/);
  assert.deepEqual(await fence.run('instance-1:provider-message-2', deliver), { id: 84 });
  assert.equal(attempts, 2);
});

test('only builds keys for provider message delivery events with exact identities', () => {
  assert.equal(
    chatwootIngressDeliveryKey({
      event: 'messages.upsert',
      instanceId: 'instance-1',
      whatsappMessageId: 'provider-message-1',
    }),
    'instance-1:provider-message-1',
  );
  assert.equal(
    chatwootIngressDeliveryKey({ event: 'messages.update', instanceId: 'instance-1', whatsappMessageId: 'message-1' }),
    null,
  );
  assert.equal(
    chatwootIngressDeliveryKey({ event: 'messages.upsert', instanceId: 'instance-1', whatsappMessageId: '' }),
    null,
  );
});
