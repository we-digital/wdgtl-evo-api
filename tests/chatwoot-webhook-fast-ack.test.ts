import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';

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
  reopenConversation: true,
};

const baseBody = {
  event: 'message_created',
  id: 2336256,
  private: false,
  content: 'because I might leave…',
  account: { id: 7 },
  inbox: { id: 58 },
  conversation: {
    id: 12261,
    meta: { sender: { identifier: '628123' } },
    contact_inbox: { source_id: '628123' },
  },
};

const serviceFixture = () => {
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
  let clientCwCalls = 0;
  const service = new ChatwootService(
    { waInstances: { 'test-instance': { instanceId: 'instance-1' } } } as any,
    { get: () => config } as any,
    {} as any,
    { delete: async () => undefined } as any,
  ) as any;
  service.logger = { error: () => undefined, warn: () => undefined, verbose: () => undefined };
  service.clientCw = async () => {
    clientCwCalls += 1;
    return { provider, client: {} };
  };
  return { service, clientCwCalls: () => clientCwCalls };
};

test('fast-acks inbound message_created echoes without loading Chatwoot client', async () => {
  const fixture = serviceFixture();

  assert.deepEqual(
    await fixture.service.receiveWebhook(
      { instanceName: 'test-instance' },
      {
        ...baseBody,
        message_type: 'incoming',
        source_id: 'WAID:inbound-1',
      },
    ),
    { message: 'ignored' },
  );
  assert.equal(fixture.clientCwCalls(), 0);
});

test('fast-acks already-bridged outgoing message_created without loading Chatwoot client', async () => {
  const fixture = serviceFixture();

  assert.deepEqual(
    await fixture.service.receiveWebhook(
      { instanceName: 'test-instance' },
      {
        ...baseBody,
        message_type: 'outgoing',
        source_id: 'WAID:already-sent',
      },
    ),
    { message: 'ignored' },
  );
  assert.equal(fixture.clientCwCalls(), 0);
});

test('still admits deliverable outgoing message_created into the async path', async () => {
  const fixture = serviceFixture();
  let enqueues = 0;
  fixture.service.authenticatedClientCw = async () => ({
    provider,
    client: {},
    instance: { instanceId: 'instance-1', instanceName: 'test-instance' },
  });
  fixture.service.buildEvoRouteBinding = () => ({
    version: 2,
    provider: 'evo_whatsapp',
    inbox_id: 58,
    instance_id: 'instance-1',
    instance_name: 'test-instance',
    receiver_fingerprint: 'a'.repeat(64),
  });
  fixture.service.outboundStore = {
    hasRetainedMessage: async () => false,
    enqueue: async () => {
      enqueues += 1;
      return { operationCount: 1, recovered: false };
    },
  };
  fixture.service.outboundQueue = { wake: () => undefined };

  const result = await fixture.service.receiveWebhook(
    { instanceName: 'test-instance' },
    {
      ...baseBody,
      message_type: 'outgoing',
      created_at: 1_789_020_365,
      sender: { id: 1, type: 'user', name: 'Agent' },
      attachments: [],
      outbound_snapshot: { version: 1, fingerprint: 'b'.repeat(64) },
      conversation: {
        ...baseBody.conversation,
        contact_inbox: { id: 733, contact_id: 411, source_id: 'source-1' },
        meta: { sender: { id: 411, type: 'contact', identifier: '628123' } },
        messages: [],
      },
    },
    {
      deliveryId: 'delivery-1',
      timestampSeconds: 1_789_020_365,
      receivedAt: new Date('2026-09-11T03:00:00.000Z'),
      routeInstanceId: 'instance-1',
      routeProviderId: 'provider-1',
    },
  );

  assert.equal(enqueues, 1);
  assert.equal(result?.accepted, true);
});
