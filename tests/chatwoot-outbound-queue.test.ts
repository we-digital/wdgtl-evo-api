import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBaileysTransportOptions } from '@api/integrations/channel/whatsapp/chatwoot-transport-options';
import { ChatwootProviderDeliveryPart } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';
import {
  buildChatwootOutboundParts,
  ChatwootOutboundHandler,
  ChatwootOutboundMessageStatus,
  ChatwootOutboundOrigin,
  ChatwootOutboundQueue,
  ChatwootOutboundState,
  ChatwootOutboundStore,
  MAX_OUTBOUND_PREPARATION_ATTEMPTS,
  StoredChatwootOutboundOperation,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';

const origin: ChatwootOutboundOrigin = {
  providerId: 'provider-1',
  baseUrl: 'https://chatwoot.example.invalid',
  accountId: 7,
  inboxId: 58,
  conversationId: 42,
  messageId: 314,
  contactInboxSourceId: 'opaque-contact',
  routeBinding: {
    version: 2,
    provider: 'evo_whatsapp',
    inbox_id: 58,
    instance_id: 'instance-1',
    instance_name: 'test-instance',
    receiver_fingerprint: 'a'.repeat(64),
  },
};

const webhook = {
  event: 'message_created',
  id: 314,
  account: { id: 7 },
  inbox: { id: 58 },
  sender: { available_name: 'Agent' },
  attachments: [
    { id: 11, data_url: 'https://example.invalid/b.pdf' },
    { id: 10, data_url: 'https://example.invalid/a.jpg' },
  ],
  conversation: {
    id: 42,
    contact_inbox: { source_id: 'opaque-contact' },
    messages: [{ id: 313, attachments: [{ id: 1, data_url: 'https://example.invalid/old.jpg' }] }],
  },
  content_attributes: { in_reply_to: 99 },
};

const buildParts = (body: any = webhook) =>
  buildChatwootOutboundParts({
    instanceId: 'instance-1',
    body,
    chatId: 'opaque-chat',
    formattedText: 'caption',
    origin,
  });

test('uses only the exact top-level message and creates attachment identities independent of array order', () => {
  const first = buildParts();
  const reordered = buildParts({ ...webhook, attachments: [...webhook.attachments].reverse() });
  const changedHistory = buildParts({
    ...webhook,
    conversation: {
      ...webhook.conversation,
      messages: [{ id: 999, attachments: [{ id: 999, data_url: 'https://example.invalid/unrelated' }] }],
    },
  });

  assert.equal(first.length, 2);
  assert.deepEqual(first, reordered);
  assert.deepEqual(first, changedHistory);
  assert.deepEqual(first.map((part) => part.payload.attachmentId), [10, 11]);
  assert.ok(first.every((part) => !part.payload.attachmentUrl.includes('old.jpg')));
  assert.equal(new Set(first.map((part) => part.operationKey)).size, 2);
  assert.ok(first.every((part) => /^WD[A-F0-9]{18}$/.test(part.plannedWhatsappMessageId)));
  assert.ok(first.every((part) => part.messageSetHash === first[0].messageSetHash && part.partCount === 2));
});

test('freezes content into the message-set hash and rejects malformed, deletion, and unstable attachment payloads', () => {
  const first = buildParts();
  const changed = buildParts({
    ...webhook,
    attachments: [{ ...webhook.attachments[0], data_url: 'https://example.invalid/changed.pdf' }, webhook.attachments[1]],
  });
  assert.notEqual(first[0].messageSetHash, changed[0].messageSetHash);
  assert.notEqual(
    first[0].messageSetHash,
    buildChatwootOutboundParts({
      instanceId: 'instance-1',
      body: webhook,
      chatId: 'opaque-chat',
      formattedText: 'changed caption',
      origin,
    })[0].messageSetHash,
  );
  assert.throws(() => buildParts({ ...webhook, event: 'message_updated', content_attributes: { deleted: true } }), /event/);
  assert.throws(() => buildParts({ ...webhook, id: null }), /message id/);
  assert.throws(
    () => buildParts({ ...webhook, attachments: [{ data_url: 'https://example.invalid/no-id' }] }),
    /attachment id/,
  );
  assert.throws(
    () => buildParts({ ...webhook, attachments: [webhook.attachments[0], webhook.attachments[0]] }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      buildChatwootOutboundParts({
        instanceId: 'instance-1',
        body: { ...webhook, attachments: [], content: null },
        chatId: 'opaque-chat',
        formattedText: null,
        origin,
      }),
    /empty/,
  );
  assert.throws(
    () =>
      buildParts({
        ...webhook,
        attachments: Array.from({ length: 101 }, (_, index) => ({
          id: index + 1,
          data_url: `https://example.invalid/${index + 1}`,
        })),
      }),
    /part limit/,
  );
});

test('keeps group and direct transport boundary callbacks in named option fields', async () => {
  let starts = 0;
  const beforeTransport = async () => {
    starts += 1;
  };
  const group = buildBaileysTransportOptions({
    messageId: 'WD1',
    ephemeralExpiration: 3600,
    beforeTransport,
  });
  const direct = buildBaileysTransportOptions({ messageId: 'WD2', contextInfo: { mentionedJid: [] }, beforeTransport });

  assert.equal(group.beforeTransport, beforeTransport);
  assert.equal(group.contextInfo, undefined);
  assert.equal(group.ephemeralExpiration, 3600);
  assert.equal(direct.beforeTransport, beforeTransport);
  assert.deepEqual(direct.contextInfo, { mentionedJid: [] });
  await group.beforeTransport();
  await direct.beforeTransport();
  assert.equal(starts, 2);
});

class MemoryStore implements ChatwootOutboundStore {
  operation: StoredChatwootOutboundOperation;
  exactSentMessageId: string | null = null;
  recovered = 0;
  messageReadyOverride: boolean | undefined;
  callbackPartsOverride: ChatwootProviderDeliveryPart[] | undefined;

  constructor(state: ChatwootOutboundState = 'pending') {
    const part = buildParts({ ...webhook, attachments: [] })[0];
    this.operation = {
      ...part,
      id: 'operation-1',
      instanceId: 'instance-1',
      chatwootMessageId: origin.messageId,
      chatwootInboxId: origin.inboxId,
      chatwootConversationId: origin.conversationId,
      state,
      preparationAttempts: 0,
      sendAttempts: state === 'ambiguous' ? 1 : 0,
      callbackAttempts: 0,
    };
  }

  async recoverExpired() {
    this.recovered += 1;
  }

  async claim(): Promise<StoredChatwootOutboundOperation | null> {
    if (!['pending', 'callback_pending', 'failure_callback_pending', 'ambiguous'].includes(this.operation.state)) {
      return null;
    }
    const claimed = { ...this.operation };
    if (this.operation.state === 'pending') this.operation.state = 'preparing';
    return claimed;
  }

  async markSending() {
    if (this.operation.state !== 'preparing') return false;
    this.operation.state = 'sending';
    this.operation.sendAttempts += 1;
    return true;
  }

  async markCallbackPending(_id: string, _workerId: string, whatsappMessageId: string) {
    this.operation.state = 'callback_pending';
    this.operation.whatsappMessageId = whatsappMessageId;
  }

  async markFailureCallbackPending(
    _operation: StoredChatwootOutboundOperation,
    _workerId: string,
    _errorClass: string,
  ) {
    this.operation.state = 'failure_callback_pending';
  }

  async markMessageCompleted() {
    this.operation.state = 'completed';
  }

  async markMessageFailed() {
    this.operation.state = 'failed';
  }

  async schedulePending() {
    this.operation.state = 'pending';
    this.operation.preparationAttempts += 1;
  }

  async deferCallback() {}

  async scheduleCallback() {
    this.operation.state = 'callback_pending';
    this.operation.callbackAttempts += 1;
  }

  async scheduleFailureCallback() {
    this.operation.state = 'failure_callback_pending';
    this.operation.callbackAttempts += 1;
  }

  async scheduleAmbiguous() {
    this.operation.state = 'ambiguous';
  }

  async quarantineMessage() {
    this.operation.state = 'quarantined';
  }

  async messageStatus(): Promise<ChatwootOutboundMessageStatus> {
    const ready =
      this.messageReadyOverride ??
      (this.operation.state === 'callback_pending' && Boolean(this.operation.whatsappMessageId));
    return {
      ready,
      leader: true,
      callbackParts:
        this.callbackPartsOverride ??
        (ready
          ? [
              {
                partKey: this.operation.operationKey,
                partIndex: 0,
                partCount: 1,
                sourceId: this.operation.whatsappMessageId,
              },
            ]
          : []),
    };
  }

  async findSentMessageId() {
    return this.exactSentMessageId;
  }
}

const validHandler = (overrides: Partial<ChatwootOutboundHandler> = {}): ChatwootOutboundHandler => ({
  validate: async () => true,
  isReady: async () => true,
  send: async (operation, onTransportStart) => {
    await onTransportStart();
    return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
  },
  confirm: async () => undefined,
  fail: async () => undefined,
  ...overrides,
});

test('retries a proven pre-transport failure without incrementing send attempts', async () => {
  const store = new MemoryStore();
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({ send: async () => Promise.reject(new Error('MediaDownloadFailed')) }),
  );

  await queue.runOnce();

  assert.equal(store.operation.state, 'pending');
  assert.equal(store.operation.preparationAttempts, 1);
  assert.equal(store.operation.sendAttempts, 0);
});

test('reports terminal preparation failure after the bounded attempt count without sending', async () => {
  const store = new MemoryStore();
  store.operation.preparationAttempts = MAX_OUTBOUND_PREPARATION_ATTEMPTS - 1;
  let failures = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async () => Promise.reject(new Error('MediaDownloadFailed')),
      fail: async () => {
        failures += 1;
      },
    }),
  );

  await queue.runOnce();

  assert.equal(failures, 1);
  assert.equal(store.operation.state, 'failed');
  assert.equal(store.operation.sendAttempts, 0);
});

test('reports a bounded not-ready failure without entering transport', async () => {
  const store = new MemoryStore();
  store.operation.preparationAttempts = MAX_OUTBOUND_PREPARATION_ATTEMPTS - 1;
  let sends = 0;
  let failures = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      isReady: async () => false,
      send: async () => {
        sends += 1;
        throw new Error('must not send');
      },
      fail: async () => {
        failures += 1;
      },
    }),
  );

  await queue.runOnce();

  assert.equal(sends, 0);
  assert.equal(failures, 1);
  assert.equal(store.operation.state, 'failed');
  assert.equal(store.operation.sendAttempts, 0);
});

test('reconciles a crash after transport start by exact planned WAID without another send', async () => {
  const store = new MemoryStore();
  let sends = 0;
  let confirmed: ChatwootProviderDeliveryPart[] = [];
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (operation, onTransportStart) => {
        sends += 1;
        await onTransportStart();
        store.exactSentMessageId = operation.plannedWhatsappMessageId;
        throw new Error('CrashAfterSend');
      },
      confirm: async (_operation, callbackParts) => {
        confirmed = callbackParts;
      },
    }),
  );

  await queue.runOnce();
  assert.equal(store.operation.state, 'ambiguous');
  await queue.runOnce();

  assert.equal(sends, 1);
  assert.deepEqual(confirmed, [
    {
      partKey: store.operation.operationKey,
      partIndex: 0,
      partCount: 1,
      sourceId: store.operation.plannedWhatsappMessageId,
    },
  ]);
  assert.equal(store.operation.state, 'completed');
});

test('retries only the message-level Chatwoot callback after a successful send', async () => {
  const store = new MemoryStore();
  let sends = 0;
  let callbacks = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (operation, onTransportStart) => {
        sends += 1;
        await onTransportStart();
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
      confirm: async () => {
        callbacks += 1;
        if (callbacks === 1) throw new Error('ChatwootUnavailable');
      },
    }),
  );

  await queue.runOnce();
  assert.equal(store.operation.state, 'callback_pending');
  await queue.runOnce();

  assert.equal(sends, 1);
  assert.equal(callbacks, 2);
  assert.equal(store.operation.state, 'completed');
});

test('replays only deterministic multipart callbacks after a partial callback outage', async () => {
  const store = new MemoryStore('callback_pending');
  store.operation.whatsappMessageId = store.operation.plannedWhatsappMessageId;
  store.messageReadyOverride = true;
  store.operation.partCount = 2;
  const callbackParts: ChatwootProviderDeliveryPart[] = [
    { partKey: 'part-0', partIndex: 0, partCount: 2, sourceId: 'WAID:part-0' },
    { partKey: 'part-1', partIndex: 1, partCount: 2, sourceId: 'WAID:part-1' },
  ];
  store.callbackPartsOverride = callbackParts;
  const callbacks = new Map<string, number>();
  let callbackRuns = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async () => {
        throw new Error('WhatsApp must not run during callback recovery');
      },
      confirm: async (_operation, parts) => {
        callbackRuns += 1;
        for (const part of parts) {
          if (callbackRuns === 1 && part.partIndex === 1) throw new Error('ChatwootUnavailable');
          callbacks.set(part.partKey, (callbacks.get(part.partKey) || 0) + 1);
        }
      },
    }),
  );

  await queue.runOnce();
  assert.equal(store.operation.state, 'callback_pending');
  await queue.runOnce();

  assert.equal(callbackRuns, 2);
  assert.equal(callbacks.get('part-0'), 2);
  assert.equal(callbacks.get('part-1'), 1);
  assert.equal(store.operation.state, 'completed');
});

test('waits for the complete frozen multipart set before the provider callback sequence', async () => {
  const store = new MemoryStore('callback_pending');
  store.operation.whatsappMessageId = store.operation.plannedWhatsappMessageId;
  store.messageReadyOverride = false;
  let callbacks = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      confirm: async () => {
        callbacks += 1;
      },
    }),
  );

  await queue.runOnce();
  assert.equal(callbacks, 0);
  assert.equal(store.operation.state, 'callback_pending');

  store.messageReadyOverride = true;
  await queue.runOnce();
  assert.equal(callbacks, 1);
  assert.equal(store.operation.state, 'completed');
});

test('quarantines a binding change detected during the success callback', async () => {
  const store = new MemoryStore('callback_pending');
  store.operation.whatsappMessageId = store.operation.plannedWhatsappMessageId;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      confirm: async () => {
        const error = new Error('binding changed after validation');
        error.name = 'OutboundBindingMismatch';
        throw error;
      },
    }),
  );

  await queue.runOnce();

  assert.equal(store.operation.state, 'quarantined');
  assert.equal(store.operation.callbackAttempts, 0);
});

test('keeps a missing WAID ambiguous after transport start', async () => {
  const store = new MemoryStore();
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (_operation, onTransportStart) => {
        await onTransportStart();
        return { whatsappMessageId: '', result: null };
      },
    }),
  );

  await queue.runOnce();

  assert.equal(store.operation.state, 'ambiguous');
  assert.equal(store.operation.sendAttempts, 1);
});

test('quarantines a changed origin binding before preparation or callback', async () => {
  const store = new MemoryStore();
  let sends = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      validate: async () => false,
      send: async () => {
        sends += 1;
        throw new Error('should not send');
      },
    }),
  );

  await queue.runOnce();

  assert.equal(sends, 0);
  assert.equal(store.operation.state, 'quarantined');
});

test('waits for an in-flight operation when the worker is stopped for drain', async () => {
  const store = new MemoryStore();
  let releaseTransport: () => void;
  const transportReleased = new Promise<void>((resolve) => {
    releaseTransport = resolve;
  });
  let reportTransportStarted: () => void;
  const transportStarted = new Promise<void>((resolve) => {
    reportTransportStarted = resolve;
  });
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (operation, onTransportStart) => {
        await onTransportStart();
        reportTransportStarted();
        await transportReleased;
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
    }),
  );

  await queue.start();
  await transportStarted;
  let stopped = false;
  const stopping = queue.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  releaseTransport();
  await stopping;

  assert.equal(stopped, true);
  assert.equal(store.operation.state, 'completed');
});
