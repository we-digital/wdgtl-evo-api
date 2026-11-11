import assert from 'node:assert/strict';
import test from 'node:test';

import axios from 'axios';

import { selectQuotableNativeKeyMessage } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-native-message-key';
import {
  ChatwootOutboundQueue,
  sanitizedOutboundErrorMessage,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';

const GROUP = '120363000000001@g.us';
const PARTICIPANT = '90000000001@lid';

const row = (overrides: any = {}) =>
  ({
    id: 'native-1',
    instanceId: 'receiver-instance',
    key: { id: 'WDSYNTHETIC000001', remoteJid: GROUP, fromMe: false, participant: PARTICIPANT, addressingMode: 'lid' },
    message: { imageMessage: { caption: 'Synthetic caption' }, mediaUrl: 'https://media.example.test/a.png' },
    messageType: 'imageMessage',
    messageTimestamp: 1700000000,
    chatwootMessageId: null,
    chatwootInboxId: null,
    chatwootConversationId: null,
    chatwootContactInboxSourceId: null,
    ...overrides,
  }) as any;

// Prod 2026-11-11: an image sent to a group by one of our own instances was
// stored twice by the receiving instance (media + empty text stub), neither
// row bound to the Chatwoot message.
const ownInstanceGroupCopies = () => [
  row(),
  row({
    id: 'native-2',
    messageType: 'conversation',
    message: { conversation: '', senderKeyDistributionMessage: { groupId: GROUP } },
    messageTimestamp: 1700000008,
  }),
];

const loadService = (t: any) => {
  const serverModulePath = require.resolve('../src/api/server.module.ts');
  const previous = require.cache[serverModulePath];
  require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  t.after(() => {
    if (previous) require.cache[serverModulePath] = previous;
    else delete require.cache[serverModulePath];
  });
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service: any = Object.create(ChatwootService.prototype);
  const warnings: any[] = [];
  service.logger = { warn: (line: string) => warnings.push(JSON.parse(line)), verbose() {}, error() {} };
  return { service, warnings };
};

const replyBody = (overrides: any = {}) => ({
  id: 501,
  content_attributes: { in_reply_to: 401, in_reply_to_external_id: 'WAID:WDSYNTHETIC000001', ...overrides },
});
const instance = { instanceName: 'receiver', instanceId: 'receiver-instance' };

test('quote of a group message sent by our own instance resolves from the unbound stored copies', async (t) => {
  const { service, warnings } = loadService(t);
  const queries: any[] = [];
  service.prismaRepository = {
    message: { findFirst: async () => null },
    $queryRaw: async (sql: any) => {
      queries.push(sql.values);
      return ownInstanceGroupCopies();
    },
  };

  const quoted = await service.getQuotedMessage(replyBody(), instance);

  assert.deepEqual(queries[0].slice(0, 2), ['receiver-instance', 'WDSYNTHETIC000001']);
  assert.deepEqual(quoted.key, {
    id: 'WDSYNTHETIC000001',
    remoteJid: GROUP,
    fromMe: false,
    participant: PARTICIPANT,
    addressingMode: 'lid',
  });
  assert.equal(quoted.message.imageMessage.caption, 'Synthetic caption');
  assert.deepEqual(warnings, []);
});

test('quotable selection keeps the strict pick, prefers bound copies and refuses foreign senders', () => {
  const [media, stub] = ownInstanceGroupCopies();
  assert.equal(selectQuotableNativeKeyMessage([media, stub]), media);
  assert.equal(selectQuotableNativeKeyMessage([stub, media]), media);
  // A lone row keeps the strict selection unchanged.
  assert.equal(selectQuotableNativeKeyMessage([stub]), stub);
  const secondStub = row({ ...stub, id: 'native-2b', messageTimestamp: 1700000009 });
  assert.equal(selectQuotableNativeKeyMessage([stub, secondStub]), stub);
  const emptyMedia = row({ id: 'native-2c', message: { mediaUrl: 'https://media.example.test/b.png' } });
  assert.equal(selectQuotableNativeKeyMessage([stub, emptyMedia]), null);

  const bound = row({
    id: 'native-3',
    message: { imageMessage: { caption: 'Edited caption' } },
    chatwootMessageId: 401,
    chatwootInboxId: 42,
    chatwootConversationId: 37,
    chatwootContactInboxSourceId: 'ci-source',
  });
  assert.equal(selectQuotableNativeKeyMessage([media, stub, bound]), bound);

  const otherSender = row({ id: 'native-4', key: { ...media.key, participant: '90000000002@lid' } });
  assert.equal(selectQuotableNativeKeyMessage([media, otherSender]), null);
  const otherChat = row({ id: 'native-5', key: { ...media.key, remoteJid: '120363000000002@g.us' } });
  assert.equal(selectQuotableNativeKeyMessage([media, otherChat]), null);
  const otherInstance = row({ id: 'native-6', instanceId: 'sender-instance' });
  assert.equal(selectQuotableNativeKeyMessage([media, otherInstance]), null);
});

test('unresolvable quote falls back to no quote and logs the reason with the operation id', async (t) => {
  const { service, warnings } = loadService(t);
  service.prismaRepository = {
    message: { findFirst: async () => null },
    $queryRaw: async () => [],
  };

  const quoted = await service.getQuotedMessage(replyBody(), instance, {
    operationId: 'op-1',
    chatwootMessageId: 501,
    partIndex: 0,
  });

  assert.equal(quoted, null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, 'chatwoot_outbound_quote_unresolved');
  assert.equal(warnings[0].action, 'sent_without_quote');
  assert.equal(warnings[0].operationId, 'op-1');
  assert.equal(warnings[0].quotedChatwootMessageId, 401);
  assert.equal(warnings[0].quotedWhatsappMessageId, 'WDSYNTHETIC000001');
});

test('queued send without a resolvable quote still sends the text, unquoted', async (t) => {
  const { service, warnings } = loadService(t);
  t.mock.method(axios, 'post', async () => ({}));
  service.prismaRepository = {
    message: { findFirst: async () => null },
    $queryRaw: async () => [],
  };
  const sent: any[] = [];
  const waInstance = {
    instanceId: 'receiver-instance',
    connectionStatus: { state: 'open' },
    textMessage: async (data: any) => {
      sent.push(data);
      await data.beforeTransport?.();
      return { key: { id: 'WDPLANNED' }, messageTimestamp: 1700000100 };
    },
  };
  const operation = {
    id: 'op-2',
    instanceId: 'receiver-instance',
    chatwootMessageId: 502,
    partIndex: 0,
    operationKey: 'synthetic-operation',
    plannedWhatsappMessageId: 'WDPLANNED',
    payload: {
      chatId: GROUP,
      text: 'Synthetic reply',
      quotedChatwootMessageId: 401,
      quotedWhatsappMessageId: 'WDSYNTHETIC000001',
      origin: { messageId: 502, inboxId: 42, conversationId: 37 },
    },
  };

  const result = await service.sendQueuedOutbound(
    operation,
    { instance, waInstance },
    async () => {},
    new AbortController().signal,
  );

  assert.equal(result.whatsappMessageId, 'WDPLANNED');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].quoted, null);
  assert.equal(sent[0].text, 'Synthetic reply');
  assert.equal(warnings[0].operationId, 'op-2');
});

test('existing quote behaviour: a bound Chatwoot id wins and keeps the selected quote text', async (t) => {
  const { service, warnings } = loadService(t);
  const bound = row({
    key: { id: 'BOUND1', remoteJid: '628000000001@s.whatsapp.net', fromMe: true },
    message: { conversation: 'Whole parent' },
    messageType: 'conversation',
    chatwootMessageId: 401,
  });
  const lookups: any[] = [];
  service.prismaRepository = {
    message: {
      findFirst: async (query: any) => {
        lookups.push(query.where);
        return bound;
      },
    },
    $queryRaw: async () => assert.fail('key lookup is only a fallback'),
  };

  const quoted = await service.getQuotedMessage(replyBody({ quote_text: 'Selected part' }), instance);

  assert.deepEqual(lookups, [{ chatwootMessageId: 401, instanceId: 'receiver-instance' }]);
  assert.deepEqual(quoted, { key: bound.key, message: { conversation: 'Selected part' } });

  assert.equal(await service.getQuotedMessage({ content_attributes: {} }, instance), null);
  assert.deepEqual(warnings, []);
});

test('preparation failures keep the class and log a sanitized message with the operation id', async () => {
  assert.equal(
    sanitizedOutboundErrorMessage({ status: 400, error: 'Bad Request', message: ['Quoted WhatsApp message not found'] }),
    'Quoted WhatsApp message not found',
  );
  assert.equal(
    sanitizedOutboundErrorMessage(
      new Error('fetch https://s3.example.test/a.png?X-Amz-Signature=SECRET failed for 6281234567890@s.whatsapp.net'),
    ),
    'fetch <url> failed for <address>',
  );
  assert.equal(sanitizedOutboundErrorMessage(new Error('number 6281234567890 invalid')), 'number <n> invalid');
  assert.equal(sanitizedOutboundErrorMessage(undefined), null);

  const observed: any[] = [];
  const scheduled: any[] = [];
  const queue: any = new ChatwootOutboundQueue(
    {
      schedulePending: async (...args: any[]) => scheduled.push(args),
    } as any,
    { observe: (event: string, metrics: any) => observed.push({ event, ...metrics }) } as any,
  );
  await queue.retryPreparation(
    { id: 'op-3', chatwootMessageId: 503, partIndex: 1, preparationAttempts: 0, claimGeneration: 1 },
    'HttpBadRequest',
    { status: 400, error: 'Bad Request', message: ['Synthetic failure for 6281234567890'] },
  );
  assert.deepEqual(observed, [
    {
      event: 'chatwoot_outbound_preparation_failed',
      operationId: 'op-3',
      chatwootMessageId: 503,
      partIndex: 1,
      attempt: 1,
      maxAttempts: 6,
      errorClass: 'HttpBadRequest',
      errorMessage: 'Synthetic failure for <n>',
    },
  ]);
  assert.equal(scheduled[0][4], 'HttpBadRequest');
});
