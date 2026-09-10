import { createHash, randomUUID } from 'node:crypto';

import { ChatwootEvoRouteBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';

export type ChatwootOutboundState =
  | 'pending'
  | 'preparing'
  | 'sending'
  | 'callback_pending'
  | 'failure_callback_pending'
  | 'completed'
  | 'ambiguous'
  | 'quarantined'
  | 'failed';

export type ChatwootOutboundPhase = 'prepare' | 'transport' | 'callback';

export interface ChatwootOutboundOrigin {
  providerId: string;
  baseUrl: string;
  accountId: number;
  inboxId: number;
  conversationId: number;
  messageId: number;
  contactInboxSourceId?: string;
  routeBinding: ChatwootEvoRouteBinding;
}

export interface ChatwootOutboundPayload {
  chatId: string;
  text: string | null;
  attachmentId?: number;
  attachmentUrl?: string;
  quotedChatwootMessageId?: number;
  origin: ChatwootOutboundOrigin;
}

export interface ChatwootOutboundPart {
  operationKey: string;
  messageSetHash: string;
  partIdentity: string;
  partIndex: number;
  partCount: number;
  plannedWhatsappMessageId: string;
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
  callbackAttempts: number;
}

export interface ChatwootOutboundMessageStatus {
  ready: boolean;
  leader: boolean;
  primaryWhatsappMessageId?: string;
}

export interface ChatwootOutboundStore {
  recoverExpired(now: Date): Promise<void>;
  claim(workerId: string, now: Date, leaseExpiresAt: Date): Promise<StoredChatwootOutboundOperation | null>;
  markSending(id: string, workerId: string, now: Date): Promise<boolean>;
  markCallbackPending(
    id: string,
    workerId: string,
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
  schedulePending(id: string, workerId: string, nextAttemptAt: Date, errorClass: string): Promise<void>;
  deferCallback(id: string, workerId: string, nextAttemptAt: Date, errorClass: string): Promise<void>;
  scheduleCallback(id: string, workerId: string, nextAttemptAt: Date, errorClass: string): Promise<void>;
  scheduleFailureCallback(id: string, workerId: string, nextAttemptAt: Date, errorClass: string): Promise<void>;
  scheduleAmbiguous(id: string, workerId: string, nextAttemptAt: Date, errorClass: string): Promise<void>;
  quarantineMessage(operation: StoredChatwootOutboundOperation, workerId: string, errorClass: string): Promise<void>;
  messageStatus(operation: StoredChatwootOutboundOperation): Promise<ChatwootOutboundMessageStatus>;
  findSentMessageId(operation: StoredChatwootOutboundOperation): Promise<string | null>;
}

export interface ChatwootOutboundHandler {
  validate(operation: StoredChatwootOutboundOperation, phase: ChatwootOutboundPhase): Promise<boolean>;
  isReady(operation: StoredChatwootOutboundOperation): Promise<boolean>;
  send(
    operation: StoredChatwootOutboundOperation,
    onTransportStart: () => Promise<void>,
  ): Promise<{ whatsappMessageId: string; result: unknown }>;
  confirm(operation: StoredChatwootOutboundOperation, whatsappMessageId: string): Promise<void>;
  fail(operation: StoredChatwootOutboundOperation): Promise<void>;
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
  const normalizedOrigin = {
    ...params.origin,
    baseUrl: normalizeBaseUrl(requiredString(params.origin.baseUrl, 'Chatwoot base URL')),
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
      origin: normalizedOrigin,
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
      payload: {
        chatId,
        text: 'attachmentUrl' in part && !params.formattedText ? null : params.formattedText,
        attachmentId: 'attachmentId' in part ? part.attachmentId : undefined,
        attachmentUrl: 'attachmentUrl' in part ? part.attachmentUrl : undefined,
        quotedChatwootMessageId: Number.isSafeInteger(quoted) && quoted > 0 ? quoted : undefined,
        origin: normalizedOrigin,
      },
    };
  });
}

export const outboundRetryDelayMs = (attempt: number): number =>
  Math.min(300_000, 5_000 * 2 ** Math.max(0, Math.min(attempt - 1, 6)));

export const MAX_OUTBOUND_PREPARATION_ATTEMPTS = 6;

const errorClass = (error: unknown): string => {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string')
    return error.name.slice(0, 100);
  return 'Error';
};

export class ChatwootOutboundQueue {
  private readonly workerId = `chatwoot-outbound-${process.pid}-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly store: ChatwootOutboundStore,
    private readonly handler: ChatwootOutboundHandler,
    private readonly pollIntervalMs = 1_000,
    private readonly leaseMs = 600_000,
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
    await this.activeRun;
  }

  public wake() {
    if (this.stopped || this.activeRun) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  public async runOnce(): Promise<boolean> {
    const now = new Date();
    await this.store.recoverExpired(now);
    const operation = await this.store.claim(this.workerId, now, new Date(now.getTime() + this.leaseMs));
    if (!operation) return false;

    if (operation.state === 'callback_pending') {
      await this.confirm(operation);
      return true;
    }
    if (operation.state === 'failure_callback_pending') {
      await this.confirmFailure(operation);
      return true;
    }
    if (operation.state === 'ambiguous') {
      if (!(await this.handler.validate(operation, 'callback'))) {
        await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
        return true;
      }
      const reconciledMessageId = await this.store.findSentMessageId(operation);
      if (reconciledMessageId) {
        await this.store.markCallbackPending(operation.id, this.workerId, reconciledMessageId, null, new Date());
        await this.confirm(operation);
      } else {
        await this.store.scheduleAmbiguous(
          operation.id,
          this.workerId,
          new Date(Date.now() + outboundRetryDelayMs(operation.sendAttempts + 1)),
          'AwaitingExactWhatsappMessage',
        );
      }
      return true;
    }

    if (!(await this.handler.validate(operation, 'prepare'))) {
      await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
      return true;
    }
    if (!(await this.handler.isReady(operation))) {
      await this.retryPreparation(operation, 'WhatsappNotReady');
      return true;
    }

    let transportStarted = false;
    try {
      const sent = await this.handler.send(operation, async () => {
        if (transportStarted) return;
        if (!(await this.handler.validate(operation, 'transport'))) {
          const error = new Error('Outbound binding changed before transport');
          error.name = 'OutboundBindingMismatch';
          throw error;
        }
        const sendStarted = await this.store.markSending(operation.id, this.workerId, new Date());
        if (!sendStarted) throw new Error('OutboundLeaseLost');
        transportStarted = true;
      });
      if (!transportStarted) throw new Error('TransportNotStarted');
      if (!sent.whatsappMessageId) throw new Error('MissingWhatsappMessageId');
      await this.store.markCallbackPending(
        operation.id,
        this.workerId,
        sent.whatsappMessageId,
        sent.result,
        new Date(),
      );
      await this.confirm(operation);
    } catch (error) {
      const classified = errorClass(error);
      const nextAttemptAt = new Date(Date.now() + outboundRetryDelayMs(operation.sendAttempts + 1));
      if (classified === 'OutboundBindingMismatch') {
        await this.store.quarantineMessage(operation, this.workerId, classified);
      } else if (transportStarted) {
        await this.store.scheduleAmbiguous(operation.id, this.workerId, nextAttemptAt, classified);
      } else {
        await this.retryPreparation(operation, classified);
      }
    }
    return true;
  }

  private async retryPreparation(operation: StoredChatwootOutboundOperation, classified: string) {
    if (operation.preparationAttempts + 1 >= MAX_OUTBOUND_PREPARATION_ATTEMPTS) {
      await this.store.markFailureCallbackPending(operation, this.workerId, classified, new Date());
      await this.confirmFailure(operation);
      return;
    }
    await this.store.schedulePending(
      operation.id,
      this.workerId,
      new Date(Date.now() + outboundRetryDelayMs(operation.preparationAttempts + 1)),
      classified,
    );
  }

  private async confirm(operation: StoredChatwootOutboundOperation) {
    try {
      const status = await this.store.messageStatus(operation);
      if (!status.ready || !status.leader || !status.primaryWhatsappMessageId) {
        await this.store.deferCallback(
          operation.id,
          this.workerId,
          new Date(Date.now() + outboundRetryDelayMs(operation.callbackAttempts + 1)),
          'AwaitingMessageParts',
        );
        return;
      }
      if (!(await this.handler.validate(operation, 'callback'))) {
        await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
        return;
      }
      await this.handler.confirm(operation, status.primaryWhatsappMessageId);
      await this.store.markMessageCompleted(operation, this.workerId, new Date());
    } catch (error) {
      if (errorClass(error) === 'OutboundBindingMismatch') {
        await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
        return;
      }
      await this.store.scheduleCallback(
        operation.id,
        this.workerId,
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
          new Date(Date.now() + outboundRetryDelayMs(operation.callbackAttempts + 1)),
          'AwaitingFailureCallbackLeader',
        );
        return;
      }
      if (!(await this.handler.validate(operation, 'callback'))) {
        await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
        return;
      }
      await this.handler.fail(operation);
      await this.store.markMessageFailed(operation, this.workerId, new Date());
    } catch (error) {
      if (errorClass(error) === 'OutboundBindingMismatch') {
        await this.store.quarantineMessage(operation, this.workerId, 'OutboundBindingMismatch');
        return;
      }
      await this.store.scheduleFailureCallback(
        operation.id,
        this.workerId,
        new Date(Date.now() + outboundRetryDelayMs(operation.callbackAttempts + 1)),
        errorClass(error),
      );
    }
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.activeRun) return;
      const run = (async () => {
        const processed = await this.runOnce();
        this.schedule(processed ? 0 : this.pollIntervalMs);
      })()
        .catch(() => this.schedule(this.pollIntervalMs))
        .finally(() => {
          if (this.activeRun === run) this.activeRun = null;
        });
      this.activeRun = run;
    }, delayMs);
    this.timer.unref?.();
  }
}
