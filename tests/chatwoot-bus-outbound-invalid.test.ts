process.env.CHATWOOT_AVATAR_SYNC = 'off';

import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import {
  busOutboundMissingId,
  busTerminalError,
  isBusTerminalError,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-bus';

const created = (changes: Record<string, any> = {}) => ({
  id: 6175910,
  event: 'message_created',
  account: { id: 1 },
  inbox: { id: 43 },
  conversation: { id: 88242, additional_attributes: { provider_peer: '628000000001@s.whatsapp.net' } },
  message_type: 'outgoing',
  ...changes,
});

test('a send event without message, account, inbox or conversation id is named; others pass', () => {
  assert.equal(busOutboundMissingId(created()), null);
  assert.equal(busOutboundMissingId(created({ conversation: { id: null } })), 'conversation');
  assert.equal(busOutboundMissingId(created({ conversation: undefined })), 'conversation');
  assert.equal(busOutboundMissingId(created({ inbox: { id: 'x' } })), 'inbox');
  assert.equal(busOutboundMissingId(created({ account: {} })), 'account');
  assert.equal(busOutboundMissingId(created({ id: 0 })), 'message');
  assert.equal(busOutboundMissingId(created({ conversation: { id: '88242' } })), null);
  // Only message_created is a send; other event types keep their own handling.
  assert.equal(busOutboundMissingId({ event: 'message_updated', conversation: { id: null } }), null);
});

test('only errors marked terminal are termed by the bus consumer', () => {
  assert.equal(isBusTerminalError(busTerminalError('x')), true);
  assert.equal(isBusTerminalError(new Error('Invalid Chatwoot conversation id')), false);
  assert.equal(isBusTerminalError(undefined), false);
});

const provider: any = { enabled: true, id: 'prov-1', url: 'https://cw.example', token: 't', accountId: 1 };

function fakeService(displayId: number | null) {
  const calls = { patches: [] as any[], queries: [] as any[], logs: [] as string[], webhooks: 0 };
  const self: any = {
    prismaRepository: {
      instance: { findUnique: async () => ({ id: 'inst-1', name: 'f-ubud' }) },
      chatwoot: { findUnique: async () => provider },
    },
    pgClient: {
      query: async (sql: string, params: any[]) => {
        calls.queries.push(params);
        return { rows: displayId ? [{ display_id: displayId }] : [] };
      },
    },
    isImportHistoryAvailable: () => true,
    patchChatwootMessageViaBus: async (_provider: any, update: any) => {
      calls.patches.push(update);
      return { handled: true, data: { id: update.messageId, status: 'failed' } };
    },
    getClientCwConfig: () => ({}),
    logger: { warn: (line: string) => calls.logs.push(line), info: () => {}, error: () => {} },
    busObserve: () => {},
    rememberBusFreshDelivery: () => {},
    receiveWebhook: async () => {
      calls.webhooks++;
      return { accepted: true };
    },
  };
  self.failInvalidBusOutbound = (ChatwootService.prototype as any).failInvalidBusOutbound;
  const receive = (payload: any) =>
    (ChatwootService.prototype as any).receiveBusOutbound.call(self, 'cw.out.evo.inst-1', {
      delivery_id: 'd-1',
      payload,
    });
  return { receive, calls };
}

test('a send event without conversation id is marked failed in Chatwoot and termed, never sent', async () => {
  const { receive, calls } = fakeService(88242);
  await assert.rejects(receive(created({ conversation: { id: null } })), (error: unknown) => {
    assert.equal(isBusTerminalError(error), true);
    assert.match((error as Error).message, /without conversation id/);
    return true;
  });
  assert.equal(calls.webhooks, 0);
  assert.deepEqual(calls.queries, [[6175910, 1]]);
  assert.equal(calls.patches.length, 1);
  assert.deepEqual(
    { ...calls.patches[0], data: undefined },
    { accountId: 1, conversationId: 88242, messageId: 6175910, data: undefined },
  );
  assert.equal(calls.patches[0].data.status, 'failed');
  assert.equal(calls.patches[0].data.external_error, 'Not sent. Please send the message again.');
  const log = JSON.parse(calls.logs[0]);
  assert.equal(log.event, 'chatwoot_bus_outbound_invalid');
  assert.equal(log.missing, 'conversation');
  assert.equal(log.markedFailed, true);
});

test('when the conversation cannot be found the event is still termed, unmarked', async () => {
  const { receive, calls } = fakeService(null);
  await assert.rejects(receive(created({ conversation: { id: null } })), (error) => isBusTerminalError(error));
  assert.equal(calls.patches.length, 0);
  assert.equal(JSON.parse(calls.logs[0]).markedFailed, false);
});

test('a complete send event goes on to delivery unchanged', async () => {
  const { receive, calls } = fakeService(88242);
  await receive(created());
  assert.equal(calls.webhooks, 1);
  assert.equal(calls.patches.length, 0);
  assert.equal(calls.logs.length, 0);
});
