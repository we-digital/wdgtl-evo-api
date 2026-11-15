import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContactReadRequest,
  CONTACT_READ_RETRY_DELAYS_MS,
  contactReadTarget,
  isRetryableContactReadStatus,
  nextContactReadDelay,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-contact-read';
import { selectUniqueNativeKeyMessage } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-native-message-key';
import { CHATWOOT_READ_STATE_HEADER } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-read-state';

test('builds a dedicated-token contact_read request for one Chatwoot message', () => {
  const request = buildContactReadRequest({
    baseUrl: 'https://cw.example//',
    accountId: 1,
    conversationId: 42,
    messageId: 99,
    token: 'dedicated-token',
  });

  assert.equal(request.url, 'https://cw.example/api/v1/accounts/1/conversations/42/contact_read');
  assert.deepEqual(request.headers, { [CHATWOOT_READ_STATE_HEADER]: 'dedicated-token' });
  assert.deepEqual(request.data, { message_id: 99 });
});

test('a receipt waits until the message has its Chatwoot binding', () => {
  assert.equal(contactReadTarget(null), null);
  assert.equal(contactReadTarget({ chatwootMessageId: null, chatwootConversationId: null }), null);
  assert.equal(contactReadTarget({ chatwootMessageId: 7, chatwootConversationId: null }), null);
  assert.deepEqual(contactReadTarget({ chatwootMessageId: 7, chatwootConversationId: 3 }), {
    conversationId: 3,
    messageId: 7,
  });
});

test('retries while Chatwoot lacks the message or is restarting, then gives up', () => {
  for (const status of [undefined, 0, 404, 409, 429, 500, 502, 503]) assert.equal(isRetryableContactReadStatus(status), true);
  for (const status of [400, 401, 403, 422]) assert.equal(isRetryableContactReadStatus(status), false);

  const delays = CONTACT_READ_RETRY_DELAYS_MS.map((_, attempt) => nextContactReadDelay(attempt));
  assert.deepEqual(delays, [...CONTACT_READ_RETRY_DELAYS_MS]);
  assert.equal(nextContactReadDelay(CONTACT_READ_RETRY_DELAYS_MS.length), null);
  assert.ok(CONTACT_READ_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0) <= 5 * 60_000);
});

const row = (id: number, remoteJid: string, extra: Record<string, unknown> = {}) =>
  ({
    id: `row-${id}`,
    instanceId: 'instance-1',
    key: { id: 'OWN', remoteJid, fromMe: true },
    message: { conversation: 'Synthetic' },
    messageType: 'conversation',
    chatwootMessageId: 10 + id,
    chatwootInboxId: 1,
    chatwootConversationId: 5,
    chatwootContactInboxSourceId: 'source',
    ...extra,
  }) as any;

test('our message stored under the phone JID is still the unique match for a LID receipt', () => {
  // Lookup by id + fromMe returns the phone-JID row; it stays unique.
  assert.equal(selectUniqueNativeKeyMessage([row(1, '6280000000001@s.whatsapp.net')])?.chatwootMessageId, 11);
  // The same id in two chats is ambiguous and matches nothing.
  assert.equal(selectUniqueNativeKeyMessage([row(1, '6280000000001@s.whatsapp.net'), row(2, '111@lid')]), null);
});

const servicePath = '../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts';

function loadService(t: { after: (fn: () => void) => void }) {
  const modulePath = require.resolve('../src/api/server.module.ts');
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  t.after(() => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  });
  return require(servicePath).ChatwootService;
}

test('a LID receipt for a phone-JID message waits for the binding, then posts contact_read', async (t) => {
  const ChatwootService = loadService(t);
  const service = Object.create(ChatwootService.prototype) as any;
  const lookups: any[] = [];
  const stored: any[] = [{ ...row(1, '6280000000001@s.whatsapp.net'), chatwootMessageId: null }];
  service.prismaRepository = {
    $queryRaw: async (sql: any) => {
      lookups.push(sql.values);
      return stored;
    },
  };
  service.logger = { info() {}, warn() {} };
  service.configService = { get: () => ({ READ_STATE_INGRESS_TOKEN: 'read-token' }) };
  const posts: any[] = [];
  service.contactRead = async (_instance: any, target: any, token: string) => posts.push({ target, token });

  const timers: Array<() => void> = [];
  t.mock.method(global, 'setTimeout', (fn: () => void) => {
    timers.push(fn);
    return { unref() {} } as any;
  });

  const instance = { instanceId: 'instance-1', instanceName: 'synthetic' };
  await service.forwardWhatsappContactRead(instance, { id: 'OWN', remoteJid: '111@lid', fromMe: true }, 0);

  // Matched by id and direction, never by the receipt's LID chat.
  assert.deepEqual(lookups[0], ['instance-1', 'OWN', 'true']);
  assert.equal(posts.length, 0);
  assert.equal(timers.length, 1);

  stored[0] = row(1, '6280000000001@s.whatsapp.net');
  timers.shift()!();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(posts, [{ target: { conversationId: 5, messageId: 11 }, token: 'read-token' }]);
});

test('a receipt that never gets a binding is dropped after the last pause', async (t) => {
  const ChatwootService = loadService(t);
  const service = Object.create(ChatwootService.prototype) as any;
  service.prismaRepository = { $queryRaw: async () => [] };
  const warnings: string[] = [];
  service.logger = { info() {}, warn: (line: string) => warnings.push(line) };
  service.configService = { get: () => ({ READ_STATE_INGRESS_TOKEN: 'read-token' }) };
  let scheduled = 0;
  t.mock.method(global, 'setTimeout', () => {
    scheduled += 1;
    return { unref() {} } as any;
  });

  const instance = { instanceId: 'instance-1', instanceName: 'synthetic' };
  await service.forwardWhatsappContactRead(instance, { id: 'OWN', fromMe: true }, CONTACT_READ_RETRY_DELAYS_MS.length);

  assert.equal(scheduled, 0);
  assert.match(warnings[0], /chatwoot_contact_read_dropped/);
  assert.match(warnings[0], /"reason":"unbound"/);
});
