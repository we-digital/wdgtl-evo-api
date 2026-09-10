import {
  ChatwootOutboundPart,
  ChatwootOutboundPayload,
  ChatwootOutboundState,
  ChatwootOutboundStore,
  StoredChatwootOutboundOperation,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';
import { PrismaRepository } from '@api/repository/repository.service';

const ACTIVE_STATES: ChatwootOutboundState[] = ['pending', 'callback_pending', 'ambiguous'];

export class ChatwootOutboundPrismaStore implements ChatwootOutboundStore {
  constructor(private readonly repository: PrismaRepository) {}

  public async enqueue(
    instanceId: string,
    messageId: number,
    inboxId: number,
    conversationId: number,
    parts: ChatwootOutboundPart[],
  ): Promise<void> {
    await this.repository.$transaction(
      parts.map((part) =>
        this.repository.chatwootOutboundOperation.upsert({
          where: { operationKey: part.operationKey },
          create: {
            operationKey: part.operationKey,
            instanceId,
            chatwootMessageId: messageId,
            chatwootInboxId: inboxId,
            chatwootConversationId: conversationId,
            partIdentity: part.partIdentity,
            partIndex: part.partIndex,
            plannedWhatsappMessageId: part.plannedWhatsappMessageId,
            payload: part.payload as any,
          },
          update: {},
        }),
      ),
    );
  }

  public async recoverExpired(now: Date): Promise<void> {
    await this.repository.$transaction([
      this.repository.chatwootOutboundOperation.updateMany({
        where: { state: 'preparing', leaseExpiresAt: { lte: now } },
        data: { state: 'pending', leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now },
      }),
      this.repository.chatwootOutboundOperation.updateMany({
        where: { state: 'sending', leaseExpiresAt: { lte: now } },
        data: { state: 'ambiguous', leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now },
      }),
      this.repository.chatwootOutboundOperation.updateMany({
        where: { state: { in: ['callback_pending', 'ambiguous'] }, leaseExpiresAt: { lte: now } },
        data: { leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now },
      }),
    ]);
  }

  public async claim(
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<StoredChatwootOutboundOperation | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = await this.repository.chatwootOutboundOperation.findFirst({
        where: {
          state: { in: ACTIVE_STATES },
          nextAttemptAt: { lte: now },
          OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: now } }],
        },
        orderBy: [{ createdAt: 'asc' }, { partIndex: 'asc' }],
      });
      if (!candidate) return null;

      const claimedState = candidate.state === 'pending' ? 'preparing' : candidate.state;
      const claimed = await this.repository.chatwootOutboundOperation.updateMany({
        where: {
          id: candidate.id,
          state: candidate.state,
          OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: { state: claimedState, leaseOwner: workerId, leaseExpiresAt },
      });
      if (claimed.count === 1) {
        return {
          id: candidate.id,
          operationKey: candidate.operationKey,
          instanceId: candidate.instanceId,
          partIdentity: candidate.partIdentity,
          partIndex: candidate.partIndex,
          plannedWhatsappMessageId: candidate.plannedWhatsappMessageId,
          whatsappMessageId: candidate.whatsappMessageId,
          state: candidate.state as ChatwootOutboundState,
          payload: candidate.payload as unknown as ChatwootOutboundPayload,
          sendAttempts: candidate.sendAttempts,
          callbackAttempts: candidate.callbackAttempts,
        };
      }
    }
    return null;
  }

  public async markSending(id: string, workerId: string, now: Date): Promise<boolean> {
    const updated = await this.repository.chatwootOutboundOperation.updateMany({
      where: { id, state: 'preparing', leaseOwner: workerId },
      data: { state: 'sending', sendStartedAt: now, sendAttempts: { increment: 1 } },
    });
    return updated.count === 1;
  }

  public async markCallbackPending(
    id: string,
    workerId: string,
    whatsappMessageId: string,
    result: unknown,
    now: Date,
  ): Promise<void> {
    await this.repository.chatwootOutboundOperation.updateMany({
      where: { id, state: { in: ['sending', 'ambiguous'] }, leaseOwner: workerId },
      data: {
        state: 'callback_pending',
        whatsappMessageId,
        result: (result ?? undefined) as any,
        sentAt: now,
        lastErrorClass: null,
      },
    });
  }

  public async markCompleted(id: string, workerId: string, now: Date): Promise<void> {
    await this.repository.chatwootOutboundOperation.updateMany({
      where: { id, state: 'callback_pending', leaseOwner: workerId },
      data: {
        state: 'completed',
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorClass: null,
      },
    });
  }

  public async schedulePending(
    id: string,
    workerId: string,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, 'pending', nextAttemptAt, lastErrorClass, false);
  }

  public async scheduleCallback(
    id: string,
    workerId: string,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, 'callback_pending', nextAttemptAt, lastErrorClass, true);
  }

  public async scheduleAmbiguous(
    id: string,
    workerId: string,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, 'ambiguous', nextAttemptAt, lastErrorClass, false);
  }

  public async findSentMessageId(operation: StoredChatwootOutboundOperation): Promise<string | null> {
    const message = await this.repository.message.findFirst({
      where: {
        instanceId: operation.instanceId,
        key: { path: ['id'], equals: operation.plannedWhatsappMessageId },
      },
      select: { key: true },
    });
    const key = message?.key as any;
    return typeof key?.id === 'string' ? key.id : null;
  }

  private async schedule(
    id: string,
    workerId: string,
    state: ChatwootOutboundState,
    nextAttemptAt: Date,
    lastErrorClass: string,
    incrementCallback: boolean,
  ) {
    await this.repository.chatwootOutboundOperation.updateMany({
      where: { id, leaseOwner: workerId },
      data: {
        state,
        nextAttemptAt,
        lastErrorClass,
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(incrementCallback ? { callbackAttempts: { increment: 1 } } : {}),
      },
    });
  }
}
