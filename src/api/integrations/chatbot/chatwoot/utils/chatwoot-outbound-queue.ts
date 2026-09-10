import { createHash, randomUUID } from 'node:crypto';

export type ChatwootOutboundState =
  | 'pending'
  | 'preparing'
  | 'sending'
  | 'callback_pending'
  | 'completed'
  | 'ambiguous'
  | 'failed';

export interface ChatwootOutboundPayload {
  chatId: string;
  text: string | null;
  attachmentUrl?: string;
  quotedChatwootMessageId?: number;
  chatwootAccountId: number;
  chatwootMessageId: number;
  chatwootInboxId: number;
  chatwootConversationId: number;
  contactInboxSourceId?: string;
}

export interface ChatwootOutboundPart {
  operationKey: string;
  partIdentity: string;
  partIndex: number;
  plannedWhatsappMessageId: string;
  payload: ChatwootOutboundPayload;
}

export interface StoredChatwootOutboundOperation extends ChatwootOutboundPart {
  id: string;
  instanceId: string;
  state: ChatwootOutboundState;
  whatsappMessageId?: string;
  sendAttempts: number;
  callbackAttempts: number;
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
  markCompleted(id: string, workerId: string, now: Date): Promise<void>;
  schedulePending(id: string, workerId: string, nextAttemptAt: Date, errorClass: string): Promise<void>;
  scheduleCallback(id: string, workerId: string, nextAttemptAt: Date, errorClass: string): Promise<void>;
  scheduleAmbiguous(id: string, workerId: string, nextAttemptAt: Date, errorClass: string): Promise<void>;
  findSentMessageId(operation: StoredChatwootOutboundOperation): Promise<string | null>;
}

export interface ChatwootOutboundHandler {
  isReady(operation: StoredChatwootOutboundOperation): Promise<boolean>;
  send(
    operation: StoredChatwootOutboundOperation,
    onTransportStart: () => Promise<void>,
  ): Promise<{ whatsappMessageId: string; result: unknown }>;
  confirm(operation: StoredChatwootOutboundOperation, whatsappMessageId: string): Promise<void>;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const asRequiredInteger = (value: unknown, field: string): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${field}`);
  return number;
};

export function buildChatwootOutboundParts(params: {
  instanceId: string;
  body: any;
  chatId: string;
  formattedText: string | null;
}): ChatwootOutboundPart[] {
  const messageId = asRequiredInteger(params.body?.id, 'Chatwoot message id');
  const accountId = asRequiredInteger(params.body?.account?.id, 'Chatwoot account id');
  const inboxId = asRequiredInteger(params.body?.inbox?.id, 'Chatwoot inbox id');
  const conversationId = asRequiredInteger(params.body?.conversation?.id, 'Chatwoot conversation id');
  const conversationMessages = Array.isArray(params.body?.conversation?.messages)
    ? params.body.conversation.messages
    : [];
  const exactMessages = conversationMessages.filter((message: any) => Number(message?.id) === messageId);
  const sourceMessages =
    exactMessages.length > 0 ? exactMessages : conversationMessages.length === 1 ? conversationMessages : [];
  if (conversationMessages.length > 1 && exactMessages.length === 0) {
    throw new Error('Current Chatwoot message is absent from conversation payload');
  }
  const quoted = Number(params.body?.content_attributes?.in_reply_to);
  const basePayload = {
    chatId: params.chatId,
    text: params.formattedText,
    quotedChatwootMessageId: Number.isSafeInteger(quoted) && quoted > 0 ? quoted : undefined,
    chatwootAccountId: accountId,
    chatwootMessageId: messageId,
    chatwootInboxId: inboxId,
    chatwootConversationId: conversationId,
    contactInboxSourceId: params.body?.conversation?.contact_inbox?.source_id,
  };
  const parts: Array<{ identity: string; attachmentUrl?: string }> = [];

  sourceMessages.forEach((message: any, messageIndex: number) => {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (attachments.length === 0) {
      parts.push({ identity: `message:${message?.id ?? messageIndex}:text` });
      return;
    }
    attachments.forEach((attachment: any, attachmentIndex: number) => {
      if (typeof attachment?.data_url !== 'string' || attachment.data_url.length === 0) {
        throw new Error('Invalid Chatwoot attachment URL');
      }
      const stableAttachment = attachment.id ?? hash(attachment.data_url).slice(0, 24);
      parts.push({
        identity: `message:${message?.id ?? messageIndex}:attachment:${stableAttachment}:${attachmentIndex}`,
        attachmentUrl: attachment.data_url,
      });
    });
  });

  if (parts.length === 0) parts.push({ identity: 'message:current:text' });

  return parts.map((part, partIndex) => {
    const partIdentity = hash(part.identity);
    const operationKey = hash(`${params.instanceId}:${messageId}:${partIdentity}`);
    return {
      operationKey,
      partIdentity,
      partIndex,
      plannedWhatsappMessageId: `WD${operationKey.slice(0, 18).toUpperCase()}`,
      payload: {
        ...basePayload,
        attachmentUrl: part.attachmentUrl,
        text: part.attachmentUrl && !params.formattedText ? null : params.formattedText,
      },
    };
  });
}

export const outboundRetryDelayMs = (attempt: number): number =>
  Math.min(300_000, 5_000 * 2 ** Math.max(0, Math.min(attempt - 1, 6)));

const errorClass = (error: unknown): string => {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string')
    return error.name.slice(0, 100);
  return 'Error';
};

export class ChatwootOutboundQueue {
  private readonly workerId = `chatwoot-outbound-${process.pid}-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
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

  public stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  public wake() {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  public async runOnce(): Promise<boolean> {
    const now = new Date();
    await this.store.recoverExpired(now);
    const operation = await this.store.claim(this.workerId, now, new Date(now.getTime() + this.leaseMs));
    if (!operation) return false;

    if (operation.state === 'callback_pending') {
      await this.confirm(operation, operation.whatsappMessageId || operation.plannedWhatsappMessageId);
      return true;
    }

    if (operation.state === 'ambiguous') {
      const reconciledMessageId = await this.store.findSentMessageId(operation);
      if (reconciledMessageId) {
        await this.store.markCallbackPending(operation.id, this.workerId, reconciledMessageId, null, new Date());
        await this.confirm(operation, reconciledMessageId);
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

    if (!(await this.handler.isReady(operation))) {
      await this.store.schedulePending(
        operation.id,
        this.workerId,
        new Date(Date.now() + outboundRetryDelayMs(operation.sendAttempts + 1)),
        'WhatsappNotReady',
      );
      return true;
    }

    let transportStarted = false;
    try {
      const sent = await this.handler.send(operation, async () => {
        if (transportStarted) return;
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
      await this.confirm(operation, sent.whatsappMessageId);
    } catch (error) {
      const nextAttemptAt = new Date(Date.now() + outboundRetryDelayMs(operation.sendAttempts + 1));
      if (transportStarted) {
        await this.store.scheduleAmbiguous(operation.id, this.workerId, nextAttemptAt, errorClass(error));
      } else {
        await this.store.schedulePending(operation.id, this.workerId, nextAttemptAt, errorClass(error));
      }
    }
    return true;
  }

  private async confirm(operation: StoredChatwootOutboundOperation, whatsappMessageId: string) {
    try {
      await this.handler.confirm(operation, whatsappMessageId);
      await this.store.markCompleted(operation.id, this.workerId, new Date());
    } catch (error) {
      await this.store.scheduleCallback(
        operation.id,
        this.workerId,
        new Date(Date.now() + outboundRetryDelayMs(operation.callbackAttempts + 1)),
        errorClass(error),
      );
    }
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.stopped || this.running) return;
      this.running = true;
      try {
        const processed = await this.runOnce();
        this.running = false;
        this.schedule(processed ? 0 : this.pollIntervalMs);
      } catch {
        this.running = false;
        this.schedule(this.pollIntervalMs);
      }
    }, delayMs);
    this.timer.unref?.();
  }
}
