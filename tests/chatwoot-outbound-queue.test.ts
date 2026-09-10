import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatwootOutboundParts,
  ChatwootOutboundHandler,
  ChatwootOutboundQueue,
  ChatwootOutboundState,
  ChatwootOutboundStore,
  StoredChatwootOutboundOperation,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';

const webhook = {
  id: 314,
  account: { id: 7 },
  inbox: { id: 58 },
  conversation: {
    id: 42,
    contact_inbox: { source_id: 'opaque-contact' },
    messages: [
      { id: 313, attachments: [{ id: 1, data_url: 'https://example.invalid/old.jpg' }] },
      {
        id: 314,
        attachments: [
          { id: 10, data_url: 'https://example.invalid/a.jpg' },
          { id: 11, data_url: 'https://example.invalid/b.pdf' },
        ],
      },
    ],
  },
  content_attributes: { in_reply_to: 99 },
};

test('creates stable operations only for the current Chatwoot message and each attachment', () => {
  const first = buildChatwootOutboundParts({
    instanceId: 'instance-1',
    body: webhook,
    chatId: 'opaque-chat',
    formattedText: 'caption',
  });
  const repeated = buildChatwootOutboundParts({
    instanceId: 'instance-1',
    body: webhook,
    chatId: 'opaque-chat',
    formattedText: 'caption',
  });

  assert.equal(first.length, 2);
  assert.deepEqual(first, repeated);
  assert.equal(new Set(first.map((part) => part.operationKey)).size, 2);
  assert.ok(first.every((part) => /^WD[A-F0-9]{18}$/.test(part.plannedWhatsappMessageId)));
  assert.ok(first.every((part) => !part.payload.attachmentUrl.includes('old.jpg')));
});

test('rejects malformed and ambiguous conversation payloads before enqueue', () => {
  assert.throws(
    () =>
      buildChatwootOutboundParts({
        instanceId: 'instance-1',
        body: { ...webhook, id: null },
        chatId: 'opaque-chat',
        formattedText: 'text',
      }),
    /Invalid Chatwoot message id/,
  );
  assert.throws(
    () =>
      buildChatwootOutboundParts({
        instanceId: 'instance-1',
        body: { ...webhook, id: 999 },
        chatId: 'opaque-chat',
        formattedText: 'text',
      }),
    /absent from conversation payload/,
  );
});

class MemoryStore implements ChatwootOutboundStore {
  operation: StoredChatwootOutboundOperation;
  exactSentMessageId: string | null = null;
  recovered = 0;

  constructor(state: ChatwootOutboundState = 'pending') {
    const part = buildChatwootOutboundParts({
      instanceId: 'instance-1',
      body: { ...webhook, conversation: { ...webhook.conversation, messages: [{ id: 314, attachments: [] }] } },
      chatId: 'opaque-chat',
      formattedText: 'text',
    })[0];
    this.operation = {
      ...part,
      id: 'operation-1',
      instanceId: 'instance-1',
      state,
      sendAttempts: state === 'ambiguous' ? 1 : 0,
      callbackAttempts: 0,
    };
  }

  async recoverExpired() {
    this.recovered += 1;
  }

  async claim(_workerId: string): Promise<StoredChatwootOutboundOperation | null> {
    if (!['pending', 'callback_pending', 'ambiguous'].includes(this.operation.state)) return null;
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

  async markCompleted() {
    this.operation.state = 'completed';
  }

  async schedulePending() {
    this.operation.state = 'pending';
  }

  async scheduleCallback() {
    this.operation.state = 'callback_pending';
    this.operation.callbackAttempts += 1;
  }

  async scheduleAmbiguous() {
    this.operation.state = 'ambiguous';
  }

  async findSentMessageId() {
    return this.exactSentMessageId;
  }
}

test('retries a proven pre-transport failure without incrementing send attempts', async () => {
  const store = new MemoryStore();
  const handler: ChatwootOutboundHandler = {
    isReady: async () => true,
    send: async () => {
      throw new Error('MediaDownloadFailed');
    },
    confirm: async () => undefined,
  };
  const queue = new ChatwootOutboundQueue(store, handler);

  await queue.runOnce();

  assert.equal(store.operation.state, 'pending');
  assert.equal(store.operation.sendAttempts, 0);
});

test('reconciles a crash after transport start by exact planned WAID without another send', async () => {
  const store = new MemoryStore();
  let sends = 0;
  let confirmed: string | null = null;
  const handler: ChatwootOutboundHandler = {
    isReady: async () => true,
    send: async (operation, onTransportStart) => {
      sends += 1;
      await onTransportStart();
      store.exactSentMessageId = operation.plannedWhatsappMessageId;
      throw new Error('CrashAfterSend');
    },
    confirm: async (_operation, whatsappMessageId) => {
      confirmed = whatsappMessageId;
    },
  };
  const queue = new ChatwootOutboundQueue(store, handler);

  await queue.runOnce();
  assert.equal(store.operation.state, 'ambiguous');
  await queue.runOnce();

  assert.equal(sends, 1);
  assert.equal(confirmed, store.operation.plannedWhatsappMessageId);
  assert.equal(store.operation.state, 'completed');
});

test('retries only the Chatwoot callback after a successful send', async () => {
  const store = new MemoryStore();
  let sends = 0;
  let callbacks = 0;
  const handler: ChatwootOutboundHandler = {
    isReady: async () => true,
    send: async (operation, onTransportStart) => {
      sends += 1;
      await onTransportStart();
      return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
    },
    confirm: async () => {
      callbacks += 1;
      if (callbacks === 1) throw new Error('ChatwootUnavailable');
    },
  };
  const queue = new ChatwootOutboundQueue(store, handler);

  await queue.runOnce();
  assert.equal(store.operation.state, 'callback_pending');
  await queue.runOnce();

  assert.equal(sends, 1);
  assert.equal(callbacks, 2);
  assert.equal(store.operation.state, 'completed');
});

test('keeps a missing WAID ambiguous after transport start', async () => {
  const store = new MemoryStore();
  const handler: ChatwootOutboundHandler = {
    isReady: async () => true,
    send: async (_operation, onTransportStart) => {
      await onTransportStart();
      return { whatsappMessageId: '', result: null };
    },
    confirm: async () => undefined,
  };
  const queue = new ChatwootOutboundQueue(store, handler);

  await queue.runOnce();

  assert.equal(store.operation.state, 'ambiguous');
  assert.equal(store.operation.sendAttempts, 1);
});
