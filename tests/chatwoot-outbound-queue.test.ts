import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBaileysTransportOptions } from '@api/integrations/channel/whatsapp/chatwoot-transport-options';
import { BaileysStartupService } from '@api/integrations/channel/whatsapp/whatsapp.baileys.service';
import { ChatwootProviderDeliveryPart } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';
import { validatesCurrentChatwootOutboundSnapshot } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-binding';
import {
  buildChatwootOutboundParts,
  ChatwootOutboundHandler,
  chatwootWebhookMessageCreatedAt,
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
  inboxName: 'WA - Test',
  snapshotFingerprint: 'b'.repeat(64),
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
  outbound_snapshot: { version: 1, fingerprint: 'b'.repeat(64) },
};

const buildParts = (body: any = webhook) =>
  buildChatwootOutboundParts({
    instanceId: 'instance-1',
    body,
    chatId: 'opaque-chat',
    formattedText: 'caption',
    origin,
  });

const exactSnapshotMatches = (operation: StoredChatwootOutboundOperation, fingerprint: string) =>
  validatesCurrentChatwootOutboundSnapshot({
    operation,
    provider: {
      id: origin.providerId,
      enabled: true,
      url: origin.baseUrl,
      accountId: String(origin.accountId),
      nameInbox: origin.inboxName,
    } as any,
    currentInbox: null,
    conversation: null,
    currentMessage: {
      contract_version: 1,
      account_id: origin.accountId,
      inbox_id: origin.inboxId,
      conversation_id: origin.conversationId,
      message_id: origin.messageId,
      message_type_name: 'outgoing',
      deleted: false,
      destination: 'opaque-chat',
      contact_inbox_source_id: origin.contactInboxSourceId,
      route: { inbox_name: origin.inboxName, channel_type: 'Channel::Api', binding: origin.routeBinding },
      outbound_snapshot: { version: 1, fingerprint },
    },
    expectedRoute: origin.routeBinding,
    currentRoute: origin.routeBinding,
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
  assert.deepEqual(
    first.map((part) => part.payload.attachmentId),
    [10, 11],
  );
  assert.ok(first.every((part) => !part.payload.attachmentUrl.includes('old.jpg')));
  assert.equal(new Set(first.map((part) => part.operationKey)).size, 2);
  assert.ok(first.every((part) => /^WD[A-F0-9]{18}$/.test(part.plannedWhatsappMessageId)));
  assert.ok(first.every((part) => part.messageSetHash === first[0].messageSetHash && part.partCount === 2));
  assert.ok(first.every((part) => part.payload.quotedChatwootMessageId === 99));
});

test('freezes the external WhatsApp quote identity for provider-cache fallback', () => {
  const parts = buildParts({
    ...webhook,
    content_attributes: { in_reply_to: 99, in_reply_to_external_id: 'WAID:3EB0ABC' },
  });

  assert.ok(parts.every((part) => part.payload.quotedChatwootMessageId === 99));
  assert.ok(parts.every((part) => part.payload.quotedWhatsappMessageId === '3EB0ABC'));
  assert.equal(parts[0].messageSetHash, buildParts()[0].messageSetHash);
});

test('freezes selected quote text in the durable outbound operation identity', () => {
  const selected = buildParts({
    ...webhook,
    content_attributes: { in_reply_to: 99, quote_text: 'выбранный фрагмент 🌍' },
  });

  assert.ok(selected.every((part) => part.payload.quoteText === 'выбранный фрагмент 🌍'));
  assert.notEqual(selected[0].messageSetHash, buildParts()[0].messageSetHash);
});

test('freezes a native forward into one deterministic queued provider operation', () => {
  const first = buildChatwootOutboundParts({
    instanceId: 'instance-1',
    body: { ...webhook, attachments: [] },
    chatId: 'opaque-chat',
    formattedText: 'copied fallback text',
    origin,
    nativeForward: {
      sourceChatwootMessageId: 99,
      sourceWhatsappMessageId: 'SOURCE-WA-99',
    },
  });
  const replay = buildChatwootOutboundParts({
    instanceId: 'instance-1',
    body: { ...webhook, attachments: [] },
    chatId: 'opaque-chat',
    formattedText: 'copied fallback text',
    origin,
    nativeForward: {
      sourceChatwootMessageId: 99,
      sourceWhatsappMessageId: 'SOURCE-WA-99',
    },
  });

  assert.equal(first.length, 1);
  assert.deepEqual(replay, first);
  assert.deepEqual(first[0].payload.nativeForward, {
    sourceChatwootMessageId: 99,
    sourceWhatsappMessageId: 'SOURCE-WA-99',
  });
  assert.equal(first[0].payload.text, null);
  assert.match(first[0].plannedWhatsappMessageId, /^WD[A-F0-9]{18}$/);
});

test('keeps pre-upgrade frozen identities stable while retaining new contact snapshot fields', () => {
  const upgradedOrigin = { ...origin, contactId: 411, contactInboxId: 733 };
  const legacy = buildParts();
  const upgraded = buildChatwootOutboundParts({
    instanceId: 'instance-1',
    body: webhook,
    chatId: 'opaque-chat',
    formattedText: 'caption',
    origin: upgradedOrigin,
  });

  assert.deepEqual(
    upgraded.map((part) => ({ key: part.operationKey, hash: part.messageSetHash })),
    legacy.map((part) => ({ key: part.operationKey, hash: part.messageSetHash })),
  );
  assert.ok(upgraded.every((part) => part.payload.origin.contactId === 411));
  assert.ok(upgraded.every((part) => part.payload.origin.contactInboxId === 733));
});

test('freezes content into the message-set hash and rejects malformed, deletion, and unstable attachment payloads', () => {
  const first = buildParts();
  const changed = buildParts({
    ...webhook,
    attachments: [
      { ...webhook.attachments[0], data_url: 'https://example.invalid/changed.pdf' },
      webhook.attachments[1],
    ],
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
  assert.throws(
    () => buildParts({ ...webhook, event: 'message_updated', content_attributes: { deleted: true } }),
    /event/,
  );
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
      claimGeneration: 0,
    };
  }

  async recoverExpired() {
    this.recovered += 1;
  }

  async backlog() {
    return { depth: 1, oldestAt: this.operation.createdAt ?? null };
  }

  async claim(): Promise<StoredChatwootOutboundOperation | null> {
    if (
      !['pending', 'callback_pending', 'failure_callback_pending', 'ambiguous', 'delete_pending'].includes(
        this.operation.state,
      )
    ) {
      return null;
    }
    this.operation.claimGeneration += 1;
    if (this.operation.state === 'pending') this.operation.state = 'preparing';
    return { ...this.operation };
  }

  async markValidated(_id: string, _workerId: string, _claimGeneration: number, now: Date) {
    this.operation.validatedAt = now;
  }

  async markCallbackStarted(_id: string, _workerId: string, _claimGeneration: number, now: Date) {
    this.operation.callbackStartedAt = now;
  }

  async markSending(_id?: string, _workerId?: string, claimGeneration?: number) {
    if (this.operation.state !== 'preparing' || claimGeneration !== this.operation.claimGeneration) return false;
    this.operation.state = 'sending';
    this.operation.sendAttempts += 1;
    return true;
  }

  async markCallbackPending(_id: string, _workerId: string, claimGeneration: number, whatsappMessageId: string) {
    if (claimGeneration !== this.operation.claimGeneration) throw new Error('OutboundLeaseLost');
    this.operation.state = 'callback_pending';
    this.operation.whatsappMessageId = whatsappMessageId;
  }

  leaseHeld = false;
  released = 0;

  async markTransportSent(
    _id: string,
    _workerId: string,
    claimGeneration: number,
    whatsappMessageId: string,
    _result: unknown,
    now: Date,
  ) {
    if (this.operation.state !== 'sending' || claimGeneration !== this.operation.claimGeneration) return false;
    this.operation.state = 'callback_pending';
    this.operation.whatsappMessageId = whatsappMessageId;
    this.operation.sentAt = now;
    this.leaseHeld = true;
    return true;
  }

  async releaseCallbackLease(_id: string, _workerId: string, claimGeneration: number) {
    if (this.operation.state === 'callback_pending' && claimGeneration === this.operation.claimGeneration) {
      this.leaseHeld = false;
      this.released += 1;
    }
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

  async deferPending() {
    this.operation.state = 'pending';
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

  async requestDeletion() {
    this.operation.state = 'delete_pending';
  }

  async markDeleted() {
    this.operation.state = 'deleted';
  }

  async scheduleDeletion() {
    this.operation.state = 'delete_pending';
  }

  async hasRetainedMessage() {
    return true;
  }

  async messageStatus(): Promise<ChatwootOutboundMessageStatus> {
    const ready =
      this.messageReadyOverride ??
      ((this.operation.state === 'callback_pending' && Boolean(this.operation.whatsappMessageId)) ||
        this.operation.state === 'failure_callback_pending');
    return {
      ready,
      leader: true,
      outcome: ready ? (this.operation.state === 'failure_callback_pending' ? 'failure' : 'success') : 'waiting',
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
  prepare: async () => ({ validation: 'valid', context: { prepared: true } }),
  validate: async () => 'valid',
  revalidateTransport: async () => ({ validation: 'valid', providerContext: { snapshot: true } }),
  isReady: async () => true,
  send: async (operation, _context, onTransportStart) => {
    await onTransportStart();
    return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
  },
  confirm: async () => undefined,
  fail: async () => undefined,
  delete: async () => 'deleted',
  ...overrides,
});

test('retries a proven pre-transport failure without incrementing send attempts', async () => {
  const store = new MemoryStore();
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({ send: async () => Promise.reject(new Error('MediaDownloadFailed')) }),
  );

  await queue.runOnce('transport');

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

  await queue.runOnce('transport');

  assert.equal(store.operation.state, 'failure_callback_pending');
  assert.equal(failures, 0);
  await queue.runOnce('maintenance');

  assert.equal(failures, 1);
  assert.equal(store.operation.state, 'failed');
  assert.equal(store.operation.sendAttempts, 0);
});

test('keeps a not-ready WhatsApp operation pending without consuming preparation attempts', async () => {
  const store = new MemoryStore();
  store.operation.preparationAttempts = MAX_OUTBOUND_PREPARATION_ATTEMPTS - 1;
  let sends = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      isReady: async () => false,
      send: async () => {
        sends += 1;
        throw new Error('must not send');
      },
    }),
  );

  await queue.runOnce('transport');

  assert.equal(store.operation.state, 'pending');
  assert.equal(sends, 0);
  assert.equal(store.operation.preparationAttempts, MAX_OUTBOUND_PREPARATION_ATTEMPTS - 1);
  assert.equal(store.operation.sendAttempts, 0);
});

test('sends exactly once after repeated not-ready checks recover', async () => {
  const store = new MemoryStore();
  let ready = false;
  let sends = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      isReady: async () => ready,
      send: async (operation, _context, onTransportStart) => {
        sends += 1;
        await onTransportStart();
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
    }),
  );

  await queue.runOnce('transport');
  await queue.runOnce('transport');
  await queue.runOnce('transport');
  assert.equal(store.operation.state, 'pending');
  assert.equal(store.operation.preparationAttempts, 0);
  assert.equal(store.operation.sendAttempts, 0);

  ready = true;
  await queue.runOnce('transport');
  await queue.runOnce('transport');

  assert.equal(sends, 1);
  assert.equal(store.operation.state, 'completed');
  assert.equal(store.operation.preparationAttempts, 0);
  assert.equal(store.operation.sendAttempts, 1);
});

test('quarantines a payload fingerprint changed during a disconnected wait without sending', async () => {
  const store = new MemoryStore();
  let fingerprint = origin.snapshotFingerprint;
  let ready = false;
  let sends = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      prepare: async (operation) => ({
        validation: exactSnapshotMatches(operation, fingerprint) ? 'valid' : 'mismatch',
      }),
      isReady: async () => ready,
      send: async () => {
        sends += 1;
        throw new Error('must not send');
      },
    }),
  );

  await queue.runOnce('transport');
  fingerprint = 'c'.repeat(64);
  ready = true;
  await queue.runOnce('transport');

  assert.equal(store.operation.state, 'quarantined');
  assert.equal(store.operation.sendAttempts, 0);
  assert.equal(sends, 0);
});

test('quarantines a payload fingerprint changed between preparation and the transport fence', async () => {
  const store = new MemoryStore();
  let fingerprint = origin.snapshotFingerprint;
  let transportCalls = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      prepare: async (operation) => ({
        validation: exactSnapshotMatches(operation, fingerprint) ? 'valid' : 'mismatch',
      }),
      revalidateTransport: async (operation) => ({
        validation: exactSnapshotMatches(operation, fingerprint) ? 'valid' : 'mismatch',
      }),
      send: async (operation, _context, onTransportStart) => {
        fingerprint = 'c'.repeat(64);
        await onTransportStart();
        transportCalls += 1;
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
    }),
  );

  await queue.runOnce('transport');

  assert.equal(store.operation.state, 'quarantined');
  assert.equal(store.operation.sendAttempts, 0);
  assert.equal(transportCalls, 0);
});

test('defers a socket loss immediately before transport without consuming preparation attempts', async () => {
  const store = new MemoryStore();
  let sends = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async () => {
        sends += 1;
        const error = new Error('socket disconnected before transport');
        error.name = 'WhatsappNotReady';
        throw error;
      },
    }),
  );

  await queue.runOnce('transport');

  assert.equal(store.operation.state, 'pending');
  assert.equal(store.operation.preparationAttempts, 0);
  assert.equal(store.operation.sendAttempts, 0);
  assert.equal(sends, 1);
});

test('preserves real Baileys readiness errors at the attempt limit and sends exactly once after recovery', async () => {
  const store = new MemoryStore();
  store.operation.preparationAttempts = MAX_OUTBOUND_PREPARATION_ATTEMPTS - 1;
  let socketReady = false;
  let transports = 0;
  const wa: any = Object.create(BaileysStartupService.prototype);
  wa.whatsappNumber = async () => [{ exists: true, jid: '628123@s.whatsapp.net' }];
  wa.logger = { verbose() {}, debug() {}, error() {} };
  wa.configService = {
    get(key: string) {
      if (key === 'CHATWOOT') return { ENABLED: false };
      if (key === 'OPENAI') return { ENABLED: false };
      if (key === 'DATABASE') return { SAVE_DATA: { NEW_MESSAGE: false } };
      return {};
    },
  };
  wa.localWebhook = { enabled: false };
  wa.localChatwoot = { enabled: false };
  wa.prepareMessage = (message: any) => message;
  wa.sendDataWebhook = () => undefined;
  wa.sendMessage = async (_sender: string, _message: unknown, transport: { beforeTransport?: () => Promise<void> }) => {
    await transport.beforeTransport?.();
    transports += 1;
    return {
      key: { id: store.operation.plannedWhatsappMessageId, remoteJid: '628123@s.whatsapp.net', fromMe: true },
      message: { conversation: 'hello' },
      messageTimestamp: 1,
    };
  };

  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      revalidateTransport: async () => {
        if (!socketReady) {
          const error = new Error('socket disconnected before transport');
          error.name = 'WhatsappNotReady';
          throw error;
        }
        return { validation: 'valid', providerContext: { snapshot: true } };
      },
      send: async (operation, _context, onTransportStart) => {
        const sent = await wa.textMessage(
          {
            number: '628123',
            text: 'hello',
            messageId: operation.plannedWhatsappMessageId,
            beforeTransport: onTransportStart,
          },
          true,
        );
        return { whatsappMessageId: sent.key.id, result: null };
      },
    }),
  );

  await queue.runOnce('transport');
  assert.equal(store.operation.state, 'pending');
  assert.equal(store.operation.preparationAttempts, MAX_OUTBOUND_PREPARATION_ATTEMPTS - 1);
  assert.equal(store.operation.sendAttempts, 0);
  assert.equal(transports, 0);

  socketReady = true;
  await queue.runOnce('transport');
  await queue.runOnce('maintenance');

  assert.equal(store.operation.state, 'completed');
  assert.equal(store.operation.preparationAttempts, MAX_OUTBOUND_PREPARATION_ATTEMPTS - 1);
  assert.equal(store.operation.sendAttempts, 1);
  assert.equal(transports, 1);
});

test('reconciles a crash after transport start by exact planned WAID without another send', async () => {
  const store = new MemoryStore();
  let sends = 0;
  let confirmed: ChatwootProviderDeliveryPart[] = [];
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (operation, _context, onTransportStart) => {
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
  await queue.runOnce('maintenance');

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
      send: async (operation, _context, onTransportStart) => {
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
  await queue.runOnce('maintenance');

  assert.equal(sends, 1);
  assert.equal(callbacks, 2);
  assert.equal(store.operation.state, 'completed');
});

test('uses exactly two authoritative phases and does not reverse-read before the conditional callback', async () => {
  const store = new MemoryStore();
  const calls = { prepare: 0, revalidate: 0, legacyValidate: 0, callback: 0 };
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      prepare: async () => {
        calls.prepare += 1;
        return { validation: 'valid', context: { prepared: true } };
      },
      revalidateTransport: async () => {
        calls.revalidate += 1;
        return { validation: 'valid', providerContext: { snapshot: true } };
      },
      validate: async () => {
        calls.legacyValidate += 1;
        return 'valid';
      },
      confirm: async () => {
        calls.callback += 1;
      },
    }),
  );

  await queue.runOnce('transport');
  await queue.runOnce('maintenance');

  assert.deepEqual(calls, { prepare: 1, revalidate: 1, legacyValidate: 0, callback: 1 });
  assert.equal(store.operation.state, 'completed');
});

test('keeps transport capacity available while a callback worker is blocked', async () => {
  const transport = new MemoryStore().operation;
  const maintenance = new MemoryStore('callback_pending').operation;
  maintenance.id = 'callback-operation';
  maintenance.whatsappMessageId = maintenance.plannedWhatsappMessageId;
  let transportClaimed = false;
  let maintenanceClaimed = false;
  let releaseCallback: () => void;
  const callbackReleased = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });
  let reportCallbackStarted: () => void;
  const callbackStarted = new Promise<void>((resolve) => {
    reportCallbackStarted = resolve;
  });
  let reportTransportStarted: () => void;
  const transportStarted = new Promise<void>((resolve) => {
    reportTransportStarted = resolve;
  });
  const store = {
    recoverExpired: async () => undefined,
    claim: async (_workerId: string, _now: Date, _lease: Date, workClass: string) => {
      if (workClass === 'maintenance' && !maintenanceClaimed) {
        maintenanceClaimed = true;
        maintenance.claimGeneration += 1;
        return { ...maintenance };
      }
      if (workClass === 'transport' && !transportClaimed) {
        transportClaimed = true;
        transport.state = 'preparing';
        transport.claimGeneration += 1;
        return { ...transport };
      }
      return null;
    },
    messageStatus: async () => ({
      ready: true,
      leader: true,
      outcome: 'success',
      callbackParts: [
        {
          partKey: maintenance.operationKey,
          partIndex: 0,
          partCount: 1,
          sourceId: maintenance.whatsappMessageId,
        },
      ],
    }),
    markCallbackStarted: async () => undefined,
    markMessageCompleted: async () => {
      maintenance.state = 'completed';
    },
    markValidated: async () => undefined,
    markSending: async () => true,
    markCallbackPending: async () => {
      transport.state = 'callback_pending';
    },
  } as unknown as ChatwootOutboundStore;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      prepare: async () => {
        await callbackStarted;
        return { validation: 'valid', context: {} };
      },
      send: async (operation, _context, onTransportStart) => {
        await onTransportStart();
        reportTransportStarted();
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
      confirm: async () => {
        reportCallbackStarted();
        await callbackReleased;
      },
    }),
    1,
    60_000,
    undefined,
    { transport: 1, maintenance: 1 },
  );

  await queue.start();
  await transportStarted;
  const maintenanceStateWhileTransportStarted = maintenance.state;
  releaseCallback();
  await queue.stop();
  assert.equal(maintenanceStateWhileTransportStarted, 'callback_pending');
  assert.equal(transport.state, 'callback_pending');
  assert.equal(maintenance.state, 'completed');
});

test('honors the poll interval when both worker classes are idle', async () => {
  let claims = 0;
  const store = {
    recoverExpired: async () => undefined,
    claim: async () => {
      claims += 1;
      return null;
    },
  } as unknown as ChatwootOutboundStore;
  const queue = new ChatwootOutboundQueue(store, validHandler(), 250, 60_000, undefined, {
    transport: 1,
    maintenance: 1,
  });

  await queue.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await queue.stop();

  assert.equal(claims, 2);
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
      send: async (_operation, _context, onTransportStart) => {
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
      prepare: async () => ({ validation: 'mismatch' }),
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
      send: async (operation, _context, onTransportStart) => {
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
  assert.equal(store.operation.state, 'callback_pending');
});

test('completes a mixed multipart outcome with only the delivered mappings and no sibling resend', async () => {
  const store = new MemoryStore('failure_callback_pending');
  store.operation.partCount = 2;
  store.messageReadyOverride = true;
  store.callbackPartsOverride = [{ partKey: 'sent-part', partIndex: 0, partCount: 1, sourceId: 'WAID:sent' }];
  store.messageStatus = async () => ({
    ready: true,
    leader: true,
    outcome: 'partial_success',
    callbackParts: store.callbackPartsOverride,
  });
  let sends = 0;
  let confirmed: ChatwootProviderDeliveryPart[] = [];
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async () => {
        sends += 1;
        throw new Error('must not resend a mixed outcome');
      },
      confirm: async (_operation, parts) => {
        confirmed = parts;
      },
    }),
  );

  await queue.runOnce();

  assert.equal(sends, 0);
  assert.deepEqual(confirmed, store.callbackPartsOverride);
  assert.equal(store.operation.state, 'completed');
});

test('times out pre-transport preparation without allowing a late transport start', async () => {
  const store = new MemoryStore();
  let transports = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (_operation, _context, onTransportStart, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (signal.aborted) {
          const error = new Error('aborted');
          error.name = 'OutboundOperationAborted';
          throw error;
        }
        transports += 1;
        await onTransportStart();
        throw new Error('unexpected');
      },
    }),
    1,
    1_000,
    { validation: 100, readiness: 100, send: 5, callback: 100 },
  );

  await queue.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(transports, 0);
  assert.equal(store.operation.state, 'pending');
  assert.equal(store.operation.sendAttempts, 0);
});

test('fences two stale timed-out claims across the exact three-attempt race', async () => {
  const store = new MemoryStore();
  const releases: Array<() => void> = [];
  const entered: Array<Promise<void>> = [];
  const enteredResolvers: Array<() => void> = [];
  for (let index = 0; index < 3; index += 1) {
    entered.push(new Promise<void>((resolve) => enteredResolvers.push(resolve)));
  }
  let attempts = 0;
  let transports = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (operation, _context, onTransportStart) => {
        const attempt = attempts++;
        enteredResolvers[attempt]();
        if (attempt < 2) await new Promise<void>((resolve) => releases.push(resolve));
        await onTransportStart();
        transports += 1;
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
    }),
    1,
    1_000,
    { validation: 100, readiness: 100, send: 5, callback: 100 },
  );

  await queue.runOnce();
  const second = queue.runOnce();
  await entered[1];
  releases[0]();
  await second;
  const third = queue.runOnce();
  await entered[2];
  releases[1]();
  await third;
  await queue.runOnce('maintenance');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(attempts, 3);
  assert.equal(transports, 1);
  assert.equal(store.operation.sendAttempts, 1);
  assert.equal(store.operation.state, 'completed');
  assert.equal(store.operation.claimGeneration, 4);
});

test('keeps deletion pending for an uncertain send and never invokes send again', async () => {
  const store = new MemoryStore('delete_pending');
  store.operation.sendAttempts = 1;
  let sends = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async () => {
        sends += 1;
        throw new Error('must not send');
      },
      delete: async () => 'waiting',
    }),
  );

  await queue.runOnce();

  assert.equal(sends, 0);
  assert.equal(store.operation.state, 'delete_pending');
});

test('soft-delete before its webhook preserves a deletion claim without callback or resend', async () => {
  const store = new MemoryStore('callback_pending');
  store.operation.whatsappMessageId = store.operation.plannedWhatsappMessageId;
  let sends = 0;
  let callbacks = 0;
  let deletions = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async () => {
        sends += 1;
        throw new Error('must not resend after authoritative deletion');
      },
      confirm: async () => {
        const error = new Error('deleted before callback');
        error.name = 'OutboundMessageDeleted';
        throw error;
      },
      delete: async () => {
        deletions += 1;
        return 'deleted';
      },
    }),
  );

  await queue.runOnce();
  assert.equal(store.operation.state, 'delete_pending');

  await store.requestDeletion(store.operation);
  await queue.runOnce();

  assert.equal(store.operation.state, 'deleted');
  assert.equal(sends, 0);
  assert.equal(callbacks, 0);
  assert.equal(deletions, 1);
});

test('deletion webhook before callback claims deletion without callback or resend', async () => {
  const store = new MemoryStore('callback_pending');
  store.operation.whatsappMessageId = store.operation.plannedWhatsappMessageId;
  let sends = 0;
  let callbacks = 0;
  let deletions = 0;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async () => {
        sends += 1;
        throw new Error('must not resend after deletion webhook');
      },
      confirm: async () => {
        callbacks += 1;
      },
      delete: async () => {
        deletions += 1;
        return 'deleted';
      },
    }),
  );

  await store.requestDeletion(store.operation);
  await queue.runOnce();

  assert.equal(store.operation.state, 'deleted');
  assert.equal(sends, 0);
  assert.equal(callbacks, 0);
  assert.equal(deletions, 1);
});

test('commits the exact WAID right after relay and releases the lane before local post-send work', async () => {
  const store = new MemoryStore();
  let stateAfterRelay: string | undefined;
  let leaseHeldAfterRelay: boolean | undefined;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (operation, _context, onTransportStart, _signal, onTransportComplete) => {
        await onTransportStart();
        await onTransportComplete({ whatsappMessageId: operation.plannedWhatsappMessageId, result: null });
        stateAfterRelay = store.operation.state;
        leaseHeldAfterRelay = store.leaseHeld;
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
    }),
  );

  assert.equal(await queue.runOnce('transport'), true);
  assert.equal(stateAfterRelay, 'callback_pending');
  assert.equal(leaseHeldAfterRelay, true);
  assert.equal(store.leaseHeld, false);
  assert.equal(store.released, 1);
  assert.equal(store.operation.sendAttempts, 1);
  assert.equal(store.operation.whatsappMessageId, store.operation.plannedWhatsappMessageId);
});

test('keeps a relayed message callback-pending when local post-send persistence fails', async () => {
  const store = new MemoryStore();
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (operation, _context, onTransportStart, _signal, onTransportComplete) => {
        await onTransportStart();
        await onTransportComplete({ whatsappMessageId: operation.plannedWhatsappMessageId, result: null });
        throw Object.assign(new Error('history write failed'), { name: 'PrismaClientKnownRequestError' });
      },
    }),
  );

  await queue.runOnce('transport');
  assert.equal(store.operation.state, 'callback_pending');
  assert.equal(store.leaseHeld, false);
  assert.equal(store.operation.sendAttempts, 1);
  await queue.runOnce('maintenance');
  assert.equal(store.operation.state, 'completed');
});

test('without an early relay receipt the final send result still commits the WAID once', async () => {
  const store = new MemoryStore();
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (operation, _context, onTransportStart, _signal, onTransportComplete) => {
        await onTransportStart();
        await onTransportComplete({ whatsappMessageId: '', result: null });
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
    }),
  );

  await queue.runOnce('transport');
  assert.equal(store.operation.state, 'callback_pending');
  assert.equal(store.released, 0);
  assert.equal(store.operation.sendAttempts, 1);
});

test('ignores a relay receipt before the durable transport fence', async () => {
  const store = new MemoryStore();
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (operation, _context, onTransportStart, _signal, onTransportComplete) => {
        await onTransportComplete({ whatsappMessageId: operation.plannedWhatsappMessageId, result: null });
        assert.equal(store.operation.state, 'preparing');
        await onTransportStart();
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
    }),
  );

  await queue.runOnce('transport');
  assert.equal(store.operation.state, 'callback_pending');
  assert.equal(store.released, 0);
});

test('reports webhook-to-sent latency percentiles per window', async () => {
  const store = new MemoryStore();
  const events: { event: string; metrics: Record<string, unknown> }[] = [];
  const receivedAt = new Date(Date.now() - 1_500);
  store.operation.webhookReceivedAt = receivedAt;
  store.operation.messageCreatedAt = new Date(receivedAt.getTime() - 200);
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      send: async (operation, _context, onTransportStart, _signal, onTransportComplete) => {
        await onTransportStart();
        await onTransportComplete({ whatsappMessageId: operation.plannedWhatsappMessageId, result: null });
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
      observe: (event, metrics) => events.push({ event, metrics }),
    }),
  );

  await queue.runOnce('transport');
  queue.reportLatency();
  queue.reportLatency();
  const reports = events.filter(({ event }) => event === 'chatwoot_outbound_latency');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].metrics.sent, 1);
  assert.ok((reports[0].metrics.totalP50Ms as number) >= 1_500);
  assert.equal(reports[0].metrics.totalP95Ms, reports[0].metrics.totalP50Ms);
  assert.equal(reports[0].metrics.messageToReceiptP50Ms, 200);
  assert.equal(typeof reports[0].metrics.transportP95Ms, 'number');
});

test('passes the preparation context to the transport fence and reports its phases', async () => {
  const store = new MemoryStore();
  const events: { event: string; metrics: Record<string, unknown> }[] = [];
  store.operation.webhookReceivedAt = new Date(Date.now() - 500);
  const prepared = { prepared: 'snapshot' };
  let fenceContext: unknown;
  const queue = new ChatwootOutboundQueue(
    store,
    validHandler({
      prepare: async () => ({ validation: 'valid', context: prepared }),
      revalidateTransport: async (_operation, _signal, context) => {
        fenceContext = context;
        return { validation: 'valid', providerContext: { snapshot: true }, snapshotReused: true };
      },
      send: async (operation, _context, onTransportStart, _signal, onTransportComplete) => {
        await onTransportStart();
        await onTransportComplete({ whatsappMessageId: operation.plannedWhatsappMessageId, result: null });
        return { whatsappMessageId: operation.plannedWhatsappMessageId, result: null };
      },
      observe: (event, metrics) => events.push({ event, metrics }),
    }),
  );

  await queue.runOnce('transport');
  queue.reportLatency();
  assert.equal(fenceContext, prepared);
  const sent = events.find(({ event }) => event === 'chatwoot_outbound_transport_sent');
  assert.equal(sent?.metrics.fenceReused, 1);
  assert.equal(typeof sent?.metrics.preparationMs, 'number');
  assert.equal(typeof sent?.metrics.fenceMs, 'number');
  const report = events.find(({ event }) => event === 'chatwoot_outbound_latency');
  assert.equal(report?.metrics.fenceReused, 1);
  assert.equal(typeof report?.metrics.preparationP50Ms, 'number');
  assert.equal(typeof report?.metrics.fenceP95Ms, 'number');
  assert.ok(
    (report?.metrics.preparationP50Ms as number) + (report?.metrics.fenceP50Ms as number) <=
      (report?.metrics.preTransportP50Ms as number) + 1,
  );
});

test('shares one expired-lease recovery pass across claims within the interval', async () => {
  const store = new MemoryStore('completed');
  const queue = new ChatwootOutboundQueue(store, validHandler());

  await Promise.all([queue.runOnce('transport'), queue.runOnce('maintenance'), queue.runOnce('transport')]);
  await queue.runOnce('transport');
  assert.equal(store.recovered, 1);
});

test('backs off exact-WAID reconciliation for a long-unresolved ambiguous send', async () => {
  const store = new MemoryStore('ambiguous');
  store.operation.claimGeneration = 500;
  let nextAttemptAt: Date | undefined;
  store.scheduleAmbiguous = async (_id: string, _worker: string, _generation: number, next: Date) => {
    nextAttemptAt = next;
    store.operation.state = 'ambiguous';
  };
  const queue = new ChatwootOutboundQueue(store, validHandler());

  await queue.runOnce('maintenance');
  assert.ok(nextAttemptAt);
  assert.ok(nextAttemptAt.getTime() - Date.now() > 290_000);
});

test('reads Chatwoot webhook created_at as ISO or epoch seconds', () => {
  const receivedAt = new Date('2026-11-10T12:00:05.000Z');
  assert.equal(
    chatwootWebhookMessageCreatedAt('2026-11-10T12:00:04.250Z', receivedAt)?.toISOString(),
    '2026-11-10T12:00:04.250Z',
  );
  assert.equal(
    chatwootWebhookMessageCreatedAt(Date.parse('2026-11-10T12:00:04Z') / 1000, receivedAt)?.toISOString(),
    '2026-11-10T12:00:04.000Z',
  );
  assert.equal(
    chatwootWebhookMessageCreatedAt(String(Date.parse('2026-11-10T12:00:03Z') / 1000), receivedAt)?.toISOString(),
    '2026-11-10T12:00:03.000Z',
  );
  assert.equal(chatwootWebhookMessageCreatedAt('2026-11-10T13:00:00Z', receivedAt), undefined);
  assert.equal(chatwootWebhookMessageCreatedAt(null, receivedAt), undefined);
  assert.equal(chatwootWebhookMessageCreatedAt('not a date', receivedAt), undefined);
});
