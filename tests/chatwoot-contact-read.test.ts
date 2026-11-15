import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContactReadRequest,
  CONTACT_READ_COALESCE_MS,
  CONTACT_READ_RETRY_DELAYS_MS,
  ContactReadCoalescer,
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

  // Bound now: the receipt waits in the coalescing window, then posts once.
  assert.equal(posts.length, 0);
  assert.equal(timers.length, 1);
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

function manualCoalescer() {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const flushed: any[] = [];
  const coalescer = new ContactReadCoalescer<string>(
    async (read) => {
      flushed.push(read);
    },
    CONTACT_READ_COALESCE_MS,
    (fn, ms) => timers.push({ fn, ms }),
  );
  return { coalescer, timers, flushed };
}

test('a READ burst for one conversation becomes one contact_read with the newest message', async () => {
  const { coalescer, timers, flushed } = manualCoalescer();
  coalescer.add('inst', { conversationId: 5, messageId: 30 }, 0, 'a');
  coalescer.add('inst', { conversationId: 5, messageId: 41 }, 2, 'b');
  coalescer.add('inst', { conversationId: 5, messageId: 12 }, 1, 'c');

  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, CONTACT_READ_COALESCE_MS);
  assert.equal(flushed.length, 0);

  timers.shift()!.fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(flushed, [{ target: { conversationId: 5, messageId: 41 }, attempt: 0, receipts: 3, context: 'c' }]);
  assert.equal(coalescer.size, 0);

  // The next receipt opens a new window.
  coalescer.add('inst', { conversationId: 5, messageId: 42 }, 0, 'd');
  assert.equal(timers.length, 1);
});

test('conversations and WhatsApp numbers are coalesced separately', async () => {
  const { coalescer, timers, flushed } = manualCoalescer();
  coalescer.add('inst-1', { conversationId: 5, messageId: 10 }, 0, 'a');
  coalescer.add('inst-1', { conversationId: 6, messageId: 11 }, 0, 'b');
  coalescer.add('inst-2', { conversationId: 5, messageId: 12 }, 0, 'c');

  assert.equal(timers.length, 3);
  for (const timer of timers.splice(0)) timer.fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    flushed.map((read) => read.target),
    [
      { conversationId: 5, messageId: 10 },
      { conversationId: 6, messageId: 11 },
      { conversationId: 5, messageId: 12 },
    ],
  );
});

test('the service sends one contact_read per conversation for a burst of receipts', async (t) => {
  const ChatwootService = loadService(t);
  const service = Object.create(ChatwootService.prototype) as any;
  const byId: Record<string, any> = {
    A: row(1, '111@lid', { key: { id: 'A', remoteJid: '111@lid', fromMe: true }, chatwootMessageId: 21 }),
    B: row(2, '111@lid', { key: { id: 'B', remoteJid: '111@lid', fromMe: true }, chatwootMessageId: 23 }),
    C: row(3, '111@lid', { key: { id: 'C', remoteJid: '111@lid', fromMe: true }, chatwootMessageId: 22 }),
    D: row(4, '222@lid', {
      key: { id: 'D', remoteJid: '222@lid', fromMe: true },
      chatwootMessageId: 30,
      chatwootConversationId: 9,
    }),
  };
  service.prismaRepository = { $queryRaw: async (sql: any) => [byId[sql.values[1]]] };
  const infos: string[] = [];
  service.logger = { info: (line: string) => infos.push(line), warn() {} };
  service.configService = { get: () => ({ READ_STATE_INGRESS_TOKEN: 'read-token' }) };
  const posts: any[] = [];
  service.contactRead = async (_instance: any, target: any) => posts.push(target);

  const timers: Array<() => void> = [];
  t.mock.method(global, 'setTimeout', (fn: () => void) => {
    timers.push(fn);
    return { unref() {} } as any;
  });

  const instance = { instanceId: 'instance-burst', instanceName: 'synthetic' };
  for (const id of ['A', 'B', 'C', 'D'])
    await service.forwardWhatsappContactRead(instance, { id, remoteJid: '111@lid', fromMe: true }, 0);

  assert.equal(posts.length, 0);
  assert.equal(timers.length, 2);
  for (const fn of timers.splice(0)) fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(posts, [
    { conversationId: 5, messageId: 23 },
    { conversationId: 9, messageId: 30 },
  ]);
  assert.match(infos[0], /"receipts":3/);
});

test('a failed coalesced send retries with the newest receipt and keeps the drop limit', async (t) => {
  const ChatwootService = loadService(t);
  const service = Object.create(ChatwootService.prototype) as any;
  const stored = { current: row(1, '111@lid', { chatwootMessageId: 50 }) };
  service.prismaRepository = { $queryRaw: async () => [stored.current] };
  const warnings: string[] = [];
  service.logger = { info() {}, warn: (line: string) => warnings.push(line) };
  service.configService = { get: () => ({ READ_STATE_INGRESS_TOKEN: 'read-token' }) };
  const posts: any[] = [];
  let failures = 1;
  service.contactRead = async (_instance: any, target: any) => {
    posts.push(target);
    if (failures-- > 0) throw Object.assign(new Error('busy'), { response: { status: 503 } });
  };

  const timers: Array<{ fn: () => void; ms: number }> = [];
  t.mock.method(global, 'setTimeout', (fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return { unref() {} } as any;
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const instance = { instanceId: 'instance-retry', instanceName: 'synthetic' };
  await service.forwardWhatsappContactRead(instance, { id: 'OWN', fromMe: true }, 0);
  timers.shift()!.fn(); // coalescing window
  await settle();
  assert.equal(posts.length, 1);

  // 503 → retry after the first pause.
  assert.equal(timers[0].ms, CONTACT_READ_RETRY_DELAYS_MS[0]);
  // A newer receipt during the pause is merged into the retried send.
  stored.current = row(2, '111@lid', { chatwootMessageId: 55 });
  await service.forwardWhatsappContactRead(instance, { id: 'NEWER', fromMe: true }, 0);
  timers.shift()!.fn(); // retry re-adds the older target into the open window
  timers.shift()!.fn(); // window flush
  await settle();

  assert.deepEqual(posts[1], { conversationId: 5, messageId: 55 });
  assert.equal(posts.length, 2);
  assert.equal(timers.length, 0);

  // Out of attempts: the coalesced send is dropped, not retried.
  failures = 1;
  await service.sendCoalescedContactRead({
    target: { conversationId: 5, messageId: 55 },
    attempt: CONTACT_READ_RETRY_DELAYS_MS.length,
    receipts: 1,
    context: { service, instance },
  });
  assert.equal(timers.length, 0);
  assert.match(warnings.at(-1)!, /chatwoot_contact_read_dropped/);
  assert.match(warnings.at(-1)!, /"reason":"chatwoot_unavailable"/);
});
