process.env.CHATWOOT_AVATAR_SYNC = 'off';

import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { busFreshSendEnabled } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-bus';
import { validatesLocalChatwootOutboundBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-binding';

const route = {
  version: 2,
  provider: 'evo_whatsapp',
  inbox_id: 3,
  instance_id: 'inst-1',
  instance_name: 'p-mila',
  receiver_fingerprint: 'a'.repeat(64),
};
const origin = {
  providerId: 'prov-1',
  baseUrl: 'https://cw.example',
  accountId: 1,
  inboxId: 3,
  inboxName: 'P Mila',
  conversationId: 7,
  messageId: 70,
  routeBinding: route,
  snapshotFingerprint: 'b'.repeat(64),
};
const operation = (changes: Record<string, unknown> = {}): any => ({
  instanceId: 'inst-1',
  chatwootMessageId: 70,
  chatwootInboxId: 3,
  chatwootConversationId: 7,
  webhookDeliveryId: 'd-1',
  preparationAttempts: 0,
  sendAttempts: 0,
  transportOutcomeUnresolved: false,
  payload: { origin, chatId: '120@g.us' },
  ...changes,
});
const provider: any = {
  enabled: true,
  id: 'prov-1',
  url: 'https://cw.example',
  token: 't',
  accountId: 1,
  nameInbox: 'P Mila',
};

const fakeService = (receivedAgoMs: number, routeOverride: Record<string, unknown> = {}) => {
  const observed: string[] = [];
  const self: any = {
    busFreshDeliveries: new Map([['d-1', Date.now() - receivedAgoMs]]),
    outboundInstance: async () => ({ instanceId: 'inst-1', instanceName: 'p-mila' }),
    prismaRepository: { chatwoot: { findUnique: async () => provider } },
    buildEvoRouteBinding: () => ({ ...route, ...routeOverride }),
    waMonitor: { waInstances: { 'p-mila': { instanceId: 'inst-1', connectionStatus: { state: 'open' } } } },
    busObserve: (event: string) => observed.push(event),
    getClientCwConfig: () => ({ url: provider.url, token: provider.token, accountId: 1, nameInbox: 'P Mila' }),
    outboundFenceBinding: () => ({ fence: true }),
  };
  const call = (op: any) => (ChatwootService.prototype as any).freshBusOutboundContext.call(self, op);
  return { self, call, observed };
};

test('local binding check refuses another provider, inbox or instance route', () => {
  assert.equal(validatesLocalChatwootOutboundBinding({ operation: operation(), provider, expectedRoute: route }), true);
  assert.equal(
    validatesLocalChatwootOutboundBinding({ operation: operation(), provider: { ...provider, id: 'x' }, expectedRoute: route }),
    false,
  );
  assert.equal(
    validatesLocalChatwootOutboundBinding({ operation: operation({ chatwootInboxId: 4 }), provider, expectedRoute: route }),
    false,
  );
  assert.equal(
    validatesLocalChatwootOutboundBinding({
      operation: operation(),
      provider,
      expectedRoute: { ...route, receiver_fingerprint: 'c'.repeat(64) },
    }),
    false,
  );
});

test('a fresh first bus send skips the Chatwoot read once', async () => {
  const { self, call, observed } = fakeService(500);
  const context = await call(operation());
  assert.ok(context);
  assert.equal(context.currentMessage, null);
  assert.equal(context.authoritativelyDeleted, false);
  assert.deepEqual(context.providerContext, {
    snapshot_version: 1,
    snapshot_fingerprint: 'b'.repeat(64),
    binding: route,
  });
  assert.deepEqual(observed, ['chatwoot_bus_outbound_fresh_send']);
  assert.equal(self.busFreshDeliveries.has('d-1'), false);
  assert.equal(await call(operation()), null, 'a second preparation re-reads Chatwoot');
});

test('old, retried, HTTP or unbound sends still re-read Chatwoot', async () => {
  assert.equal(await fakeService(6_000).call(operation()), null);
  assert.equal(await fakeService(100).call(operation({ preparationAttempts: 1 })), null);
  assert.equal(await fakeService(100).call(operation({ sendAttempts: 1 })), null);
  assert.equal(await fakeService(100).call(operation({ transportOutcomeUnresolved: true })), null);
  assert.equal(await fakeService(100).call(operation({ webhookDeliveryId: 'http-delivery' })), null);
  assert.equal(await fakeService(100, { receiver_fingerprint: 'c'.repeat(64) }).call(operation()), null);
});

test('the fast path can be switched off', () => {
  assert.equal(busFreshSendEnabled(undefined), true);
  assert.equal(busFreshSendEnabled('false'), false);
});
