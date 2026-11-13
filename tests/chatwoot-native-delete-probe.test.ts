process.env.CHATWOOT_AVATAR_SYNC = 'off';

import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { validatesCurrentChatwootOutboundSnapshot } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-binding';

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
const operation: any = {
  instanceId: 'inst-1',
  chatwootMessageId: 70,
  chatwootInboxId: 3,
  chatwootConversationId: 7,
  payload: { origin, chatId: '120@g.us' },
};
const provider: any = { enabled: true, id: 'prov-1', url: 'https://cw.example', accountId: 1, nameInbox: 'P Mila' };
const current = (changes: Record<string, unknown> = {}) => ({
  contract_version: 1,
  account_id: 1,
  inbox_id: 3,
  conversation_id: 7,
  message_id: 70,
  message_type_name: 'outgoing',
  deleted: false,
  destination: '120@g.us',
  route: { inbox_name: 'P Mila', channel_type: 'Channel::Api', binding: route },
  outbound_snapshot: { version: 1, fingerprint: 'b'.repeat(64) },
  ...changes,
});
const validate = (currentMessage: any, extra: Record<string, unknown> = {}) =>
  validatesCurrentChatwootOutboundSnapshot({
    operation,
    provider,
    currentInbox: null,
    conversation: null,
    currentMessage,
    expectedRoute: route,
    currentRoute: route,
    ...extra,
  });

test('a deletion read accepts the not-yet-deleted message Chatwoot probes with', () => {
  assert.equal(validate(current(), { forDeletion: true }), true);
  assert.equal(validate(current({ deleted: true }), { forDeletion: true }), true);
});

test('a deletion read accepts content edited after the send', () => {
  const edited = current({ outbound_snapshot: { version: 1, fingerprint: 'c'.repeat(64) } });
  assert.equal(validate(edited), false);
  assert.equal(validate(edited, { forDeletion: true }), true);
});

test('a deletion read still refuses another destination, conversation or route', () => {
  assert.equal(validate(current({ destination: '999@g.us' }), { forDeletion: true }), false);
  assert.equal(validate(current({ conversation_id: 8 }), { forDeletion: true }), false);
  assert.equal(
    validate(current({ route: { inbox_name: 'P Mila', channel_type: 'Channel::Api', binding: { ...route, instance_id: 'x' } } }), {
      forDeletion: true,
    }),
    false,
  );
});

test('the probe, the queued deletion and the synthetic deletion all use the deletion read', async () => {
  const service = Object.create(ChatwootService.prototype) as any;
  const calls: unknown[][] = [];
  service.currentOutboundContext = async (...args: unknown[]) => {
    calls.push(args.slice(2));
    return { ok: true };
  };
  assert.deepEqual(await service.currentDeletionContext({}, new AbortController().signal), { ok: true });
  assert.deepEqual(calls, [[false, false, true]]);
});
