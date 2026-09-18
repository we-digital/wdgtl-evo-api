import { createHash, randomUUID } from 'node:crypto';

import { ChatwootProviderDeliveryPart } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';
import { ChatwootEvoRouteBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';

export type ChatwootOutboundState =
  | 'pending'
  | 'preparing'
  | 'sending'
  | 'callback_pending'
  | 'failure_callback_pending'
  | 'completed'
  | 'ambiguous'
  | 'delete_pending'
  | 'deleted'
  | 'quarantined'
  | 'failed';

export type ChatwootOutboundPhase = 'prepare' | 'transport' | 'callback';
export type ChatwootOutboundValidation = 'valid' | 'deleted' | 'mismatch';
export type ChatwootOutboundWorkClass = 'transport' | 'maintenance' | 'any';

export interface ChatwootOutboundOrigin {
  providerId: string;
  baseUrl: string;
  accountId: number;
  inboxId: number;
  conversationId: number;
  messageId: number;
  contactInboxSourceId?: string;
  contactId?: number;
  contactInboxId?: number;
  inboxName: string;
  snapshotFingerprint: string;
  routeBinding: ChatwootEvoRouteBinding;
}

export interface ChatwootOutboundPayload {
  chatId: string;
  text: string | null;
  attachmentId?: number;
  attachmentUrl?: string;
  quotedChatwootMessageId?: number;
  /** Native WhatsApp mention JIDs for group @notifications */
  mentioned?: string[];
  origin: ChatwootOutboundOrigin;
}

export interface ChatwootOutboundPart {
  operationKey: string;
  messageSetHash: string;
  partIdentity: string;
  partIndex: number;
  partCount: number;
  plannedWhatsappMessageId: string;
  laneKey: string;
  payload: ChatwootOutboundPayload;
}

export interface StoredChatwootOutboundOperation extends ChatwootOutboundPart {
  id: string;
  instanceId: string;
  chatwootMessageId: number;
  chatwootInboxId: number;
  chatwootConversationId: number;
  state: ChatwootOutboundState;
  whatsappMessageId?: string;
  preparationAttempts: number;
  sendAttempts: number;
  transportOutcomeUnresolved: boolean;
  callbackAttempts: number;
  claimGeneration: number;
  webhookDeliveryId?: string;
  laneKey: string;
  laneSequence: bigint;
  webhookReceivedAt?: Date;
  messageCreatedAt?: Date;
  createdAt?: Date;
  claimedAt?: Date;
  validatedAt?: Date;
  sendStartedAt?: Date;
  sentAt?: Date;
  callbackStartedAt?: Date;
  callbackContext?: unknown;
}

export interface ChatwootOutboundAdmission {
  deliveryId: string;
  receivedAt: Date;
  messageCreatedAt?: Date;
  maxBacklog: number;
  maxOldestAgeMs: number;
}

export interface ChatwootOutboundBacklog {
  depth: number;
  oldestAt: Date | null;
}

export interface ChatwootOutboundMessageStatus {
  ready: boolean;
  leader: boolean;
  outcome: 'waiting' | 'success' | 'partial_success' | 'failure';
  callbackParts: ChatwootProviderDeliveryPart[];
}

export interface ChatwootOutboundStore {
  recoverExpired(now: Date): Promise<void>;
  claim(
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
    workClass?: ChatwootOutboundWorkClass,
  ): Promise<StoredChatwootOutboundOperation | null>;
  backlog(): Promise<ChatwootOutboundBacklog>;
  markValidated(id: string, workerId: string, claimGeneration: number, now: Date): Promise<void>;
  markCallbackStarted(id: string, workerId: string, claimGeneration: number, now: Date): Promise<void>;
  markSending(
    id: string,
    workerId: string,
    claimGeneration: number,
    providerContext: unknown,
    now: Date,
  ): Promise<boolean>;
  markCallbackPending(
    id: string,
    workerId: string,
    claimGeneration: number,
    whatsappMessageId: string,
    result: unknown,
    now: Date,
  ): Promise<void>;
  markFailureCallbackPending(
    operation: StoredChatwootOutboundOperation,
    workerId: string,
    errorClass: string,
    now: Date,
  ): Promise<void>;
  markMessageCompleted(operation: StoredChatwootOutboundOperation, workerId: string, now: Date): Promise<void>;
  markMessageFailed(operation: StoredChatwootOutboundOperation, workerId: string, now: Date): Promise<void>;
  schedulePending(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    errorClass: string,
  ): Promise<void>;
  deferPending(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    errorClass: string,
  ): Promise<void>;
  deferCallback(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    errorClass: string,
  ): Promise<void>;
  scheduleCallback(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    errorClass: string,
  ): Promise<void>;
  scheduleFailureCallback(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    errorClass: string,
  ): Promise<void>;
  scheduleAmbiguous(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    errorClass: string,
  ): Promise<void>;
  resolveQuarantinedTransport(
    id: string,
    workerId: string,
    claimGeneration: number,
    whatsappMessageId: string,
    now: Date,
  ): Promise<void>;
  scheduleQuarantined(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    errorClass: string,
  ): Promise<void>;
  quarantineMessage(operation: StoredChatwootOutboundOperation, workerId: string, errorClass: string): Promise<void>;
  requestDeletion(operation: StoredChatwootOutboundOperation): Promise<void>;
  markDeleted(operation: StoredChatwootOutboundOperation, workerId: string, now: Date): Promise<void>;
  scheduleDeletion(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    errorClass: string,
  ): Promise<void>;
  hasRetainedMessage(instanceId: string, messageId: number): Promise<boolean>;
  messageStatus(operation: StoredChatwootOutboundOperation): Promise<ChatwootOutboundMessageStatus>;
  findSentMessageId(operation: StoredChatwootOutboundOperation): Promise<string | null>;
}

export interface ChatwootOutboundHandler {
  prepare(
    operation: StoredChatwootOutboundOperation,
    signal: AbortSignal,
  ): Promise<{ validation: ChatwootOutboundValidation; context?: unknown }>;
  validate(
    operation: StoredChatwootOutboundOperation,
    phase: ChatwootOutboundPhase,
    signal: AbortSignal,
  ): Promise<ChatwootOutboundValidation>;
  revalidateTransport(
    operation: StoredChatwootOutboundOperation,
    signal: AbortSignal,
  ): Promise<{ validation: ChatwootOutboundValidation; providerContext?: unknown }>;
  isReady(operation: StoredChatwootOutboundOperation, context: unknown, signal: AbortSignal): Promise<boolean>;
  send(
    operation: StoredChatwootOutboundOperation,
    context: unknown,
    onTransportStart: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<{ whatsappMessageId: string; result: unknown }>;
  confirm(
    operation: StoredChatwootOutboundOperation,
    callbackParts: ChatwootProviderDeliveryPart[],
    signal: AbortSignal,
  ): Promise<void>;
  fail(operation: StoredChatwootOutboundOperation, signal: AbortSignal): Promise<void>;
  delete(operation: StoredChatwootOutboundOperation, signal: AbortSignal): Promise<'deleted' | 'waiting'>;
  observe?(event: string, metrics: Record<string, number | string | null>): void;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const asRequiredInteger = (value: unknown, field: string): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${field}`);
  return number;
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Invalid ${field}`);
  return value.trim();
};

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, '');

export function buildChatwootOutboundParts(params: {
  instanceId: string;
  body: any;
  chatId: string;
  formattedText: string | null;
  origin: ChatwootOutboundOrigin;
  mentioned?: string[];
}): ChatwootOutboundPart[] {
  const instanceId = requiredString(params.instanceId, 'EVO instance id');
  const messageId = asRequiredInteger(params.body?.id, 'Chatwoot message id');
  const accountId = asRequiredInteger(params.body?.account?.id, 'Chatwoot account id');
  const inboxId = asRequiredInteger(params.body?.inbox?.id, 'Chatwoot inbox id');
  const conversationId = asRequiredInteger(params.body?.conversation?.id, 'Chatwoot conversation id');
  if (params.body?.event !== 'message_created') throw new Error('Invalid Chatwoot outbound event');
  if (
    params.origin.accountId !== accountId ||
    params.origin.inboxId !== inboxId ||
    params.origin.conversationId !== conversationId ||
    params.origin.messageId !== messageId ||
    params.origin.routeBinding.instance_id !== instanceId ||
    params.origin.routeBinding.inbox_id !== inboxId
  ) {
    throw new Error('Chatwoot outbound origin mismatch');
  }
  requiredString(params.origin.providerId, 'Chatwoot provider id');
  requiredString(params.origin.inboxName, 'Chatwoot inbox name');
  if (
    Number(params.body?.outbound_snapshot?.version) !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(params.body?.outbound_snapshot?.fingerprint || '')) ||
    params.origin.snapshotFingerprint !== params.body.outbound_snapshot.fingerprint
  ) {
    throw new Error('Invalid Chatwoot outbound snapshot');
  }
  const normalizedOrigin = {
    ...params.origin,
    baseUrl: normalizeBaseUrl(requiredString(params.origin.baseUrl, 'Chatwoot base URL')),
  };
  const hashOrigin = {
    providerId: normalizedOrigin.providerId,
    baseUrl: normalizedOrigin.baseUrl,
    accountId: normalizedOrigin.accountId,
    inboxId: normalizedOrigin.inboxId,
    conversationId: normalizedOrigin.conversationId,
    messageId: normalizedOrigin.messageId,
    contactInboxSourceId: normalizedOrigin.contactInboxSourceId,
    inboxName: normalizedOrigin.inboxName,
    snapshotFingerprint: normalizedOrigin.snapshotFingerprint,
    routeBinding: normalizedOrigin.routeBinding,
  };
  const chatId = requiredString(params.chatId, 'WhatsApp destination');
  const quoted = Number(params.body?.content_attributes?.in_reply_to);
  if (params.body?.attachments !== undefined && !Array.isArray(params.body.attachments)) {
    throw new Error('Invalid current Chatwoot attachments');
  }
  const attachments = (params.body?.attachments || []).map((attachment: any) => {
    const attachmentId = asRequiredInteger(attachment?.id, 'Chatwoot attachment id');
    const attachmentUrl = requiredString(attachment?.data_url, 'Chatwoot attachment URL');
    return { attachmentId, attachmentUrl };
  });
  attachments.sort((left, right) => left.attachmentId - right.attachmentId);
  if (new Set(attachments.map((attachment) => attachment.attachmentId)).size !== attachments.length) {
    throw new Error('Duplicate Chatwoot attachment id');
  }
  if (attachments.length > MAX_CHATWOOT_OUTBOUND_PARTS) {
    throw new Error('Chatwoot outbound message exceeds provider part limit');
  }
  if (attachments.length === 0 && (typeof params.formattedText !== 'string' || params.formattedText.length === 0)) {
    throw new Error('Invalid empty Chatwoot outbound message');
  }

  const partSpecs =
    attachments.length > 0
      ? attachments.map((attachment) => ({ identity: `attachment:${attachment.attachmentId}`, ...attachment }))
      : [{ identity: 'text' }];
  const canonicalSet = partSpecs.map((part) => ({
    identity: part.identity,
    attachmentId: 'attachmentId' in part ? part.attachmentId : null,
    attachmentUrl: 'attachmentUrl' in part ? part.attachmentUrl : null,
  }));
  const messageSetHash = hash(
    JSON.stringify({
      instanceId,
      messageId,
      chatId,
      text: params.formattedText,
      quoted: Number.isSafeInteger(quoted) && quoted > 0 ? quoted : null,
      mentioned: Array.isArray(params.mentioned) ? [...params.mentioned].sort() : [],
      // Contact and contact-inbox numeric IDs strengthen new snapshots, but are
      // excluded from the frozen identity so pre-upgrade retained rows replay
      // against their original operation keys instead of being quarantined.
      origin: hashOrigin,
      parts: canonicalSet,
    }),
  );

  return partSpecs.map((part, partIndex) => {
    const partIdentity = hash(part.identity);
    const operationKey = hash(`${instanceId}:${messageId}:${messageSetHash}:${partIdentity}`);
    return {
      operationKey,
      messageSetHash,
      partIdentity,
      partIndex,
      partCount: partSpecs.length,
      plannedWhatsappMessageId: `WD${operationKey.slice(0, 18).toUpperCase()}`,
      laneKey: hash(`${instanceId}:${chatId}`),
      payload: {
        chatId,
        text: 'attachmentUrl' in part && !params.formattedText ? null : params.formattedText,
        attachmentId: 'attachmentId' in part ? part.attachmentId : undefined,
        attachmentUrl: 'attachmentUrl' in part ? part.attachmentUrl : undefined,
        quotedChatwootMessageId: Number.isSafeInteger(quoted) && quoted > 0 ? quoted : undefined,
        mentioned: Array.isArray(params.mentioned) && params.mentioned.length ? params.mentioned : undefined,
        origin: normalizedOrigin,
      },
    };
  });
}

export const outboundRetryDelayMs = (attempt: number): number =>
  Math.min(300_000, 5_000 * 2 ** Math.max(0, Math.min(attempt - 1, 6)));

export const MAX_OUTBOUND_PREPARATION_ATTEMPTS = 6;
export const MAX_CHATWOOT_OUTBOUND_PARTS = 100;

const errorClass = (error: unknown): string => {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string')
    return error.name.slice(0, 100);
  return 'Error';
};

export class ChatwootOutboundQueue {
  private readonly workerId = `chatwoot-outbound-${process.pid}-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private readonly activeRuns = new Set<Promise<void>>();
  private stopped = true;

  constructor(
    private readonly store: ChatwootOutboundStore,
    private readonly handler: ChatwootOutboundHandler,
    private readonly pollIntervalMs = 1_000,
    private readonly leaseMs = 600_000,
    private readonly timeouts = { validation: 20_000, readiness: 10_000, send: 120_000, callback: 30_000 },
    private readonly concurrency = { transport: 4, maintenance: 2 },
  ) {}

  public async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.store.recoverExpired(new Date());
    this.schedule(0);
  }

  public async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.all(this.activeRuns);
  }

  public wake() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  public async runOnce(workClass: ChatwootOutboundWorkClass = 'any'): Promise<boolean> {
    const now = new Date();
    await this.store.recoverExpired(now);
    const operation = await this.store.claim(this.workerId, now, new Date(now.getTime() + this.leaseMs), workClass);
    if (!operation) return false;

    if (operation.state === 'callback_pending') {
      await this.confirm(operation);
      return true;
    }
    if (operation.state === 'failure_callback_pending') {
      await this.confirmFailure(operation);
      return true;
    }
    if (operation.state === 'delete_pending') {
      await this.delete(operation);
      return true;
    }
    if (operation.state === 'ambiguous') {
      let validation: ChatwootOutboundValidation;
      try {
        validation = await this.withTimeout('OutboundValidationTimeout', this.timeouts.validation, (signal) =>
          this.handler.validate(operation, 'callback', signal),
        );
      } catch (error) {
        await this.store.scheduleAmbiguous(
          operation.id,
          this.workerId,
          operation.claimGeneration,
          new Date(Date.now() + outboundRetryDelayMs(operation.sendAttempts + 1)),
          errorClass(error),
        );
        return true;
      }
      if (validation === 'deleted') {
        await this.store.requestDeletion(operation);
        return true;
      }
      if (validation === 'mismatch') {
        await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
        return true;
      }
      const reconciledMessageId = await this.store.findSentMessageId(operation);
      if (reconciledMessageId) {
        await this.store.markCallbackPending(
          operation.id,
          this.workerId,
          operation.claimGeneration,
          reconciledMessageId,
          null,
          new Date(),
        );
        this.wake();
      } else {
        await this.store.scheduleAmbiguous(
          operation.id,
          this.workerId,
          operation.claimGeneration,
          new Date(Date.now() + outboundRetryDelayMs(operation.sendAttempts + 1)),
          'AwaitingExactWhatsappMessage',
        );
      }
      return true;
    }
    if (operation.state === 'quarantined') {
      const reconciledMessageId = await this.store.findSentMessageId(operation);
      if (reconciledMessageId) {
        await this.store.resolveQuarantinedTransport(
          operation.id,
          this.workerId,
          operation.claimGeneration,
          reconciledMessageId,
          new Date(),
        );
        this.wake();
      } else {
        await this.store.scheduleQuarantined(
          operation.id,
          this.workerId,
          operation.claimGeneration,
          new Date(Date.now() + outboundRetryDelayMs(operation.sendAttempts + 1)),
          'AwaitingExactWhatsappMessage',
        );
      }
      return true;
    }

    let validation: ChatwootOutboundValidation;
    let ready: boolean;
    let preparedContext: unknown;
    try {
      const prepared = await this.withTimeout('OutboundValidationTimeout', this.timeouts.validation, (signal) =>
        this.handler.prepare(operation, signal),
      );
      validation = prepared.validation;
      preparedContext = prepared.context;
      if (validation === 'deleted') {
        await this.store.requestDeletion(operation);
        return true;
      }
      if (validation === 'valid') {
        operation.validatedAt = new Date();
        await this.store.markValidated(operation.id, this.workerId, operation.claimGeneration, operation.validatedAt);
      }
      ready =
        validation === 'valid'
          ? await this.withTimeout('OutboundReadinessTimeout', this.timeouts.readiness, (signal) =>
              this.handler.isReady(operation, preparedContext, signal),
            )
          : false;
    } catch (error) {
      if (errorClass(error) === 'OutboundMessageDeleted') {
        await this.store.requestDeletion(operation);
        return true;
      }
      await this.retryPreparation(operation, errorClass(error));
      return true;
    }
    if (validation === 'mismatch') {
      await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
      return true;
    }
    if (!ready) {
      await this.deferUntilWhatsappReady(operation);
      return true;
    }

    let transportStarted = false;
    let transportStartedAt: Date | undefined;
    try {
      const sent = await this.withTimeout('OutboundSendTimeout', this.timeouts.send, (signal) =>
        this.handler.send(
          operation,
          preparedContext,
          async () => {
            if (transportStarted) return;
            if (signal.aborted) {
              const error = new Error('Outbound operation aborted before transport fencing');
              error.name = 'OutboundOperationAborted';
              throw error;
            }
            const transportSnapshot = await this.withTimeout(
              'OutboundValidationTimeout',
              this.timeouts.validation,
              (signal) => this.handler.revalidateTransport(operation, signal),
            );
            const transportValidation = transportSnapshot.validation;
            if (transportValidation === 'deleted') {
              const error = new Error('Chatwoot message was deleted before transport');
              error.name = 'OutboundMessageDeleted';
              throw error;
            }
            if (transportValidation === 'mismatch') {
              const error = new Error('Outbound binding changed before transport');
              error.name = 'OutboundBindingMismatch';
              throw error;
            }
            if (signal.aborted) {
              const error = new Error('Outbound operation aborted before transport fencing');
              error.name = 'OutboundOperationAborted';
              throw error;
            }
            transportStartedAt = new Date();
            const sendStarted = await this.store.markSending(
              operation.id,
              this.workerId,
              operation.claimGeneration,
              transportSnapshot.providerContext,
              transportStartedAt,
            );
            if (!sendStarted) throw new Error('OutboundLeaseLost');
            transportStarted = true;
          },
          signal,
        ),
      );
      if (!transportStarted) throw new Error('TransportNotStarted');
      if (!sent.whatsappMessageId) throw new Error('MissingWhatsappMessageId');
      const sentAt = new Date();
      operation.sendStartedAt = transportStartedAt;
      operation.sentAt = sentAt;
      await this.store.markCallbackPending(
        operation.id,
        this.workerId,
        operation.claimGeneration,
        sent.whatsappMessageId,
        sent.result,
        sentAt,
      );
      this.handler.observe?.('chatwoot_outbound_transport_sent', {
        commitToClaimMs: this.duration(operation.createdAt, operation.claimedAt),
        validationMs: this.duration(operation.claimedAt, operation.validatedAt),
        transportMs: this.duration(transportStartedAt, sentAt),
      });
      this.wake();
    } catch (error) {
      const classified = errorClass(error);
      const nextAttemptAt = new Date(Date.now() + outboundRetryDelayMs(operation.sendAttempts + 1));
      if (classified === 'OutboundMessageDeleted') {
        await this.store.requestDeletion(operation);
      } else if (classified === 'OutboundBindingMismatch') {
        await this.store.quarantineMessage(operation, this.workerId, classified);
      } else if (transportStarted) {
        await this.store.scheduleAmbiguous(
          operation.id,
          this.workerId,
          operation.claimGeneration,
          nextAttemptAt,
          classified,
        );
      } else if (classified === 'WhatsappNotReady') {
        await this.deferUntilWhatsappReady(operation);
      } else {
        await this.retryPreparation(operation, classified);
      }
    }
    return true;
  }

  private async deferUntilWhatsappReady(operation: StoredChatwootOutboundOperation) {
    await this.store.deferPending(
      operation.id,
      this.workerId,
      operation.claimGeneration,
      new Date(Date.now() + outboundRetryDelayMs(operation.claimGeneration)),
      'WhatsappNotReady',
    );
  }

  private async retryPreparation(operation: StoredChatwootOutboundOperation, classified: string) {
    if (operation.preparationAttempts + 1 >= MAX_OUTBOUND_PREPARATION_ATTEMPTS) {
      await this.store.markFailureCallbackPending(operation, this.workerId, classified, new Date());
      this.wake();
      return;
    }
    await this.store.schedulePending(
      operation.id,
      this.workerId,
      operation.claimGeneration,
      new Date(Date.now() + outboundRetryDelayMs(operation.preparationAttempts + 1)),
      classified,
    );
  }

  private async confirm(operation: StoredChatwootOutboundOperation) {
    try {
      const status = await this.store.messageStatus(operation);
      if (
        !status.ready ||
        !status.leader ||
        (status.outcome === 'success' && status.callbackParts.length !== operation.partCount)
      ) {
        await this.store.deferCallback(
          operation.id,
          this.workerId,
          operation.claimGeneration,
          new Date(Date.now() + outboundRetryDelayMs(operation.callbackAttempts + 1)),
          'AwaitingMessageParts',
        );
        return;
      }
      operation.callbackStartedAt = new Date();
      await this.store.markCallbackStarted(
        operation.id,
        this.workerId,
        operation.claimGeneration,
        operation.callbackStartedAt,
      );
      await this.withTimeout('OutboundCallbackTimeout', this.timeouts.callback, (signal) =>
        this.handler.confirm(operation, status.callbackParts, signal),
      );
      await this.store.markMessageCompleted(operation, this.workerId, new Date());
      this.observeCompletion(operation, 'success');
    } catch (error) {
      if (errorClass(error) === 'OutboundMessageDeleted') {
        await this.store.requestDeletion(operation);
        return;
      }
      if (errorClass(error) === 'OutboundBindingMismatch') {
        await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
        return;
      }
      await this.store.scheduleCallback(
        operation.id,
        this.workerId,
        operation.claimGeneration,
        new Date(Date.now() + outboundRetryDelayMs(operation.callbackAttempts + 1)),
        errorClass(error),
      );
    }
  }

  private async confirmFailure(operation: StoredChatwootOutboundOperation) {
    try {
      const status = await this.store.messageStatus(operation);
      if (!status.leader) {
        await this.store.deferCallback(
          operation.id,
          this.workerId,
          operation.claimGeneration,
          new Date(Date.now() + outboundRetryDelayMs(operation.callbackAttempts + 1)),
          'AwaitingFailureCallbackLeader',
        );
        return;
      }
      if (!status.ready) {
        await this.store.deferCallback(
          operation.id,
          this.workerId,
          operation.claimGeneration,
          new Date(Date.now() + outboundRetryDelayMs(operation.callbackAttempts + 1)),
          'AwaitingMessageParts',
        );
        return;
      }
      operation.callbackStartedAt = new Date();
      await this.store.markCallbackStarted(
        operation.id,
        this.workerId,
        operation.claimGeneration,
        operation.callbackStartedAt,
      );
      if (status.outcome === 'partial_success') {
        await this.withTimeout('OutboundCallbackTimeout', this.timeouts.callback, (signal) =>
          this.handler.confirm(operation, status.callbackParts, signal),
        );
        await this.store.markMessageCompleted(operation, this.workerId, new Date());
        this.observeCompletion(operation, 'partial_success');
      } else {
        await this.withTimeout('OutboundCallbackTimeout', this.timeouts.callback, (signal) =>
          this.handler.fail(operation, signal),
        );
        await this.store.markMessageFailed(operation, this.workerId, new Date());
        this.observeCompletion(operation, 'failure');
      }
    } catch (error) {
      if (errorClass(error) === 'OutboundMessageDeleted') {
        await this.store.requestDeletion(operation);
        return;
      }
      if (errorClass(error) === 'OutboundBindingMismatch') {
        await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
        return;
      }
      await this.store.scheduleFailureCallback(
        operation.id,
        this.workerId,
        operation.claimGeneration,
        new Date(Date.now() + outboundRetryDelayMs(operation.callbackAttempts + 1)),
        errorClass(error),
      );
    }
  }

  private async delete(operation: StoredChatwootOutboundOperation) {
    try {
      const outcome = await this.withTimeout('OutboundDeleteTimeout', this.timeouts.callback, (signal) =>
        this.handler.delete(operation, signal),
      );
      if (outcome === 'deleted') {
        await this.store.markDeleted(operation, this.workerId, new Date());
      } else {
        await this.store.scheduleDeletion(
          operation.id,
          this.workerId,
          operation.claimGeneration,
          new Date(Date.now() + outboundRetryDelayMs(operation.sendAttempts + 1)),
          'AwaitingExactWhatsappMessage',
        );
      }
    } catch (error) {
      if (errorClass(error) === 'OutboundBindingMismatch') {
        await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
        return;
      }
      await this.store.scheduleDeletion(
        operation.id,
        this.workerId,
        operation.claimGeneration,
        new Date(Date.now() + outboundRetryDelayMs(operation.callbackAttempts + 1)),
        errorClass(error),
      );
    }
  }

  private async withTimeout<T>(
    errorName: string,
    timeoutMs: number,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error(errorName);
        error.name = errorName;
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([task(controller.signal), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private duration(start: Date | undefined, end: Date | undefined): number | null {
    return start && end ? Math.max(0, end.getTime() - start.getTime()) : null;
  }

  private observeCompletion(operation: StoredChatwootOutboundOperation, outcome: string) {
    const now = new Date();
    this.handler.observe?.('chatwoot_outbound_completed', {
      outcome,
      messageToReceiptMs: this.duration(operation.messageCreatedAt, operation.webhookReceivedAt),
      receiptToCommitMs: this.duration(operation.webhookReceivedAt, operation.createdAt),
      sentToCallbackMs: this.duration(operation.sentAt, now),
      totalMs: this.duration(operation.messageCreatedAt ?? operation.createdAt, now),
    });
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.fillSlots('transport', this.concurrency.transport);
      this.fillSlots('maintenance', this.concurrency.maintenance);
      this.schedule(this.pollIntervalMs);
    }, delayMs);
    this.timer.unref?.();
  }

  private fillSlots(workClass: Exclude<ChatwootOutboundWorkClass, 'any'>, limit: number) {
    const activeOfClass = [...this.activeRuns].filter((run: any) => run.workClass === workClass).length;
    for (let index = activeOfClass; index < Math.max(1, limit); index += 1) {
      let processed = false;
      const run: Promise<void> & { workClass?: string } = this.runOnce(workClass)
        .then((result) => {
          processed = result;
        })
        .catch(() => undefined)
        .finally(() => {
          this.activeRuns.delete(run);
          if (processed) this.wake();
        });
      run.workClass = workClass;
      this.activeRuns.add(run);
    }
  }
}
