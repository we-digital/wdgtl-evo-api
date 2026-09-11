import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { StoredChatwootOutboundOperation } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';

const route = {
  version: 2 as const,
  provider: 'evo_whatsapp' as const,
  inbox_id: 58,
  instance_id: 'instance-1',
  instance_name: 'test-instance',
  receiver_fingerprint: 'a'.repeat(64),
};
const provider = {
  id: 'provider-1',
  instanceId: 'instance-1',
  enabled: true,
  accountId: '7',
  token: 'provider-token',
  url: 'https://chatwoot.example.invalid',
  nameInbox: 'WA - Test',
  signMsg: false,
  signDelimiter: null,
};
const body = {
  event: 'message_created',
  id: 314,
  created_at: 1_789_020_365,
  message_type: 'outgoing',
  private: false,
  content: 'hello',
  account: { id: 7 },
  inbox: { id: 58 },
  sender: { id: 9001, type: 'user', name: 'Agent' },
  attachments: [],
  conversation: {
    id: 42,
    meta: { sender: { id: 411, type: 'contact', identifier: '628123' } },
    contact_inbox: { id: 733, contact_id: 411, source_id: 'source-1' },
    messages: [],
  },
};
const admission = {
  deliveryId: 'delivery-314',
  timestampSeconds: 1_789_020_365,
  receivedAt: new Date('2026-09-11T03:00:00.000Z'),
  routeInstanceId: 'instance-1',
};

const serviceFixture = (socketInstanceId: string | null) => {
  const config = {
    OUTBOUND_ASYNC_ENABLED: true,
    OUTBOUND_ASYNC_DRAIN_ONLY: false,
    OUTBOUND_MAX_BACKLOG: 100,
    OUTBOUND_MAX_OLDEST_AGE_MS: 60_000,
    OUTBOUND_TRANSPORT_CONCURRENCY: 1,
    OUTBOUND_MAINTENANCE_CONCURRENCY: 1,
    BOT_CONTACT: false,
    MESSAGE_READ: false,
  };
  const waInstances = socketInstanceId
    ? { 'test-instance': { instanceId: socketInstanceId, connectionStatus: { state: 'open' } } }
    : {};
  const service = new ChatwootService(
    { waInstances } as any,
    { get: () => config } as any,
    {} as any,
    { delete: async () => undefined } as any,
  ) as any;
  service.logger = { error: () => undefined, warn: () => undefined, verbose: () => undefined };
  service.clientCw = async () => ({ provider, client: {} });
  service.buildEvoRouteBinding = () => route;
  let reverseReads = 0;
  service.currentOutboundContext = async () => {
    reverseReads += 1;
    throw new Error('reverse read must not run during admission');
  };
  return { service, reverseReads: () => reverseReads };
};

test('bootstraps the actual 24-character Chatwoot Channel::Api secret before starting the worker', async () => {
  const fixture = serviceFixture('instance-1');
  const productionShapeSecret = 's'.repeat(24);
  let storedSecret: string | undefined;
  let cacheDeletes = 0;
  let workerStarts = 0;
  fixture.service.prismaRepository = {
    chatwoot: {
      findMany: async () => [{ instanceId: 'instance-1' }],
      update: async ({ data }: any) => {
        storedSecret = data.webhookSecret;
      },
    },
    instance: {
      findUnique: async () => ({ id: 'instance-1', name: 'test-instance' }),
    },
  };
  fixture.service.getInbox = async () => ({ secret: productionShapeSecret });
  fixture.service.cache = {
    deleteAll: async () => {
      cacheDeletes += 1;
    },
  };
  fixture.service.outboundQueue = {
    start: async () => {
      workerStarts += 1;
    },
  };

  await fixture.service.startOutboundWorker();

  assert.equal(storedSecret, productionShapeSecret);
  assert.equal(cacheDeletes, 1);
  assert.equal(workerStarts, 1);
});

test('propagates a retained lost-202 database failure without acknowledging or reverse-reading', async () => {
  const fixture = serviceFixture('instance-1');
  let enqueues = 0;
  let capturedParts: any[] = [];
  fixture.service.outboundStore = {
    hasRetainedMessage: async () => true,
    enqueue: async (...args: any[]) => {
      enqueues += 1;
      capturedParts = args[4];
      throw new Error('DatabaseUnavailable');
    },
  };

  await assert.rejects(
    () => fixture.service.receiveWebhook({ instanceName: 'test-instance' }, body, admission),
    /DatabaseUnavailable/,
  );
  assert.equal(enqueues, 1);
  assert.equal(capturedParts[0].payload.origin.contactId, 411);
  assert.equal(capturedParts[0].payload.origin.contactInboxId, 733);
  assert.equal(fixture.reverseReads(), 0);
});

test('returns durable acceptance for a retained lost-202 retry without reverse-reading', async () => {
  const fixture = serviceFixture('instance-1');
  let wakes = 0;
  fixture.service.outboundStore = {
    hasRetainedMessage: async () => true,
    enqueue: async () => ({ recovered: true }),
  };
  fixture.service.outboundQueue = { wake: () => (wakes += 1) };

  assert.deepEqual(
    await fixture.service.receiveWebhook({ instanceName: 'test-instance' }, body, admission),
    { accepted: true, operationCount: 1, recovered: true, retained: true },
  );
  assert.equal(wakes, 1);
  assert.equal(fixture.reverseReads(), 0);
});

test('rejects absent or cross-instance local sockets before ledger admission', async () => {
  for (const socketInstanceId of [null, 'foreign-instance']) {
    const fixture = serviceFixture(socketInstanceId);
    let ledgerReads = 0;
    fixture.service.outboundStore = {
      hasRetainedMessage: async () => {
        ledgerReads += 1;
        return false;
      },
    };

    await assert.rejects(
      () => fixture.service.receiveWebhook({ instanceName: 'test-instance' }, body, admission),
      (error: any) => error?.name === 'ChatwootOutboundLocalBindingUnavailable' && error?.status === 503,
    );
    assert.equal(ledgerReads, 0);
    assert.equal(fixture.reverseReads(), 0);
  }
});

test('rejects an invalid authenticated route without a reverse Chatwoot failure callback', async () => {
  const fixture = serviceFixture('instance-1');
  let ledgerReads = 0;
  let reverseCallbacks = 0;
  fixture.service.outboundStore = {
    hasRetainedMessage: async () => {
      ledgerReads += 1;
      return false;
    },
  };
  fixture.service.onSendMessageError = async () => {
    reverseCallbacks += 1;
  };
  const invalidRouteBody = {
    ...body,
    content_attributes: { auto_reply: { version: 2 } },
  };

  await assert.rejects(
    () => fixture.service.receiveWebhook({ instanceName: 'test-instance' }, invalidRouteBody, admission),
    (error: any) => error?.name === 'OutboundBindingMismatch' && error?.status === 409,
  );
  assert.equal(ledgerReads, 0);
  assert.equal(reverseCallbacks, 0);
  assert.equal(fixture.reverseReads(), 0);
});

const queuedOperation = {
  id: 'operation-1',
  operationKey: 'operation-key',
  messageSetHash: 'message-set-hash',
  instanceId: 'instance-1',
  chatwootMessageId: 314,
  chatwootInboxId: 58,
  chatwootConversationId: 42,
  partIdentity: 'text',
  partIndex: 0,
  partCount: 1,
  plannedWhatsappMessageId: 'WDTEST',
  laneKey: 'instance-1:628123',
  laneSequence: 1n,
  state: 'callback_pending',
  payload: {
    chatId: '628123',
    text: 'hello',
    origin: {
      providerId: 'provider-1',
      baseUrl: 'https://chatwoot.example.invalid',
      accountId: 7,
      inboxId: 58,
      inboxName: 'WA - Test',
      conversationId: 42,
      messageId: 314,
      contactInboxSourceId: 'source-1',
      routeBinding: route,
    },
  },
  preparationAttempts: 1,
  sendAttempts: 1,
  transportOutcomeUnresolved: false,
  callbackAttempts: 1,
  claimGeneration: 1,
  callbackContext: {
    snapshot_version: 1,
    snapshot_fingerprint: 'b'.repeat(64),
    binding: route,
  },
} as StoredChatwootOutboundOperation;

const callbackParts = [{ partKey: 'operation-1', partIndex: 0, partCount: 1, sourceId: 'WDTEST' }];

const callbackFixture = (currentProvider: Record<string, unknown>) => {
  const fixture = serviceFixture('instance-1');
  let patchCalls = 0;
  let bindingWrites = 0;
  fixture.service.prismaRepository = {
    instance: { findUnique: async () => ({ id: 'instance-1', name: 'test-instance' }) },
    chatwoot: { findUnique: async () => currentProvider },
  };
  fixture.service.updateQueuedOutboundMessage = async () => {
    patchCalls += 1;
    return {
      id: 314,
      status: 'sent',
      source_id: 'WDTEST',
      provider_delivery: {
        contract_version: 1,
        acknowledged: true,
        message_confirmed: true,
        part_key: 'operation-1',
        part_index: 0,
        part_count: 1,
        acknowledged_part_count: 1,
        source_ids: [{ part_key: 'operation-1', part_index: 0, source_id: 'WDTEST' }],
      },
    };
  };
  fixture.service.persistLocalChatwootMessageBinding = async () => {
    bindingWrites += 1;
    return 1;
  };
  return { ...fixture, patchCalls: () => patchCalls, bindingWrites: () => bindingWrites };
};

test('rejects callback when the provider URL, account or inbox drifted from the frozen origin', async () => {
  for (const changedProvider of [
    { ...provider, url: 'https://different.example.invalid' },
    { ...provider, accountId: '8' },
    { ...provider, nameInbox: 'Different inbox' },
  ]) {
    const fixture = callbackFixture(changedProvider);

    await assert.rejects(
      () => fixture.service.confirmQueuedOutbound(queuedOperation, callbackParts, new AbortController().signal),
      (error: any) => error?.name === 'OutboundBindingMismatch',
    );
    assert.equal(fixture.patchCalls(), 0);
    assert.equal(fixture.bindingWrites(), 0);
    assert.equal(fixture.reverseReads(), 0);
  }
});

test('accepts the exact frozen provider origin without a reverse Chatwoot read', async () => {
  const fixture = callbackFixture({ ...provider, url: `${provider.url}/` });

  await fixture.service.confirmQueuedOutbound(queuedOperation, callbackParts, new AbortController().signal);

  assert.equal(fixture.patchCalls(), 1);
  assert.equal(fixture.bindingWrites(), 1);
  assert.equal(fixture.reverseReads(), 0);
});
