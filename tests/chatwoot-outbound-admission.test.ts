import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';

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
