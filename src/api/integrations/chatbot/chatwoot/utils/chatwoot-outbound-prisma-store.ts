import {
  ChatwootOutboundMessageStatus,
  ChatwootOutboundPart,
  ChatwootOutboundPayload,
  ChatwootOutboundState,
  ChatwootOutboundStore,
  StoredChatwootOutboundOperation,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';
import { PrismaRepository } from '@api/repository/repository.service';

const ACTIVE_STATES: ChatwootOutboundState[] = [
  'pending',
  'callback_pending',
  'failure_callback_pending',
  'ambiguous',
  'delete_pending',
];

export class ChatwootOutboundPrismaStore implements ChatwootOutboundStore {
  constructor(private readonly repository: PrismaRepository) {}

  public async enqueue(
    instanceId: string,
    messageId: number,
    inboxId: number,
    conversationId: number,
    parts: ChatwootOutboundPart[],
  ): Promise<void> {
    if (parts.length === 0) throw new Error('Chatwoot outbound part set is empty');
    const existing = await this.messageOperations(instanceId, messageId);
    if (existing.length > 0) {
      if (!this.isExactFrozenPartSet(existing, parts)) {
        await this.quarantineFrozenSet(instanceId, messageId, 'ChangedFrozenPartSet');
        throw new Error('Chatwoot outbound part set is already frozen with different content');
      }
      return;
    }

    try {
      await this.repository.$transaction(
        parts.map((part) =>
          this.repository.chatwootOutboundOperation.create({
            data: {
              operationKey: part.operationKey,
              messageSetHash: part.messageSetHash,
              instanceId,
              chatwootMessageId: messageId,
              chatwootInboxId: inboxId,
              chatwootConversationId: conversationId,
              partIdentity: part.partIdentity,
              partIndex: part.partIndex,
              partCount: part.partCount,
              plannedWhatsappMessageId: part.plannedWhatsappMessageId,
              payload: part.payload as any,
            },
          }),
        ),
      );
    } catch (error) {
      const afterConflict = await this.messageOperations(instanceId, messageId);
      if (afterConflict.length > 0) {
        if (!this.isExactFrozenPartSet(afterConflict, parts)) {
          await this.quarantineFrozenSet(instanceId, messageId, 'ChangedFrozenPartSet');
          throw new Error('Chatwoot outbound part set is already frozen with different content');
        }
        return;
      }
      throw error;
    }
  }

  public async recoverExpired(now: Date): Promise<void> {
    await this.repository.$transaction([
      this.repository.chatwootOutboundOperation.updateMany({
        where: { state: 'preparing', leaseExpiresAt: { lte: now } },
        data: { state: 'pending', leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now },
      }),
      this.repository.chatwootOutboundOperation.updateMany({
        where: { state: 'delete_pending', leaseExpiresAt: { lte: now } },
        data: { leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now },
      }),
      this.repository.chatwootOutboundOperation.updateMany({
        where: { state: 'sending', leaseExpiresAt: { lte: now } },
        data: { state: 'ambiguous', leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now },
      }),
      this.repository.chatwootOutboundOperation.updateMany({
        where: {
          state: { in: ['callback_pending', 'failure_callback_pending', 'ambiguous'] },
          leaseExpiresAt: { lte: now },
        },
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
      if (claimed.count === 1) return this.toStored(candidate);
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
    const updated = await this.repository.chatwootOutboundOperation.updateMany({
      where: { id, state: { in: ['sending', 'ambiguous'] }, leaseOwner: workerId },
      data: {
        state: 'callback_pending',
        whatsappMessageId,
        result: (result ?? undefined) as any,
        sentAt: now,
        lastErrorClass: null,
      },
    });
    if (updated.count !== 1) throw new Error('OutboundLeaseLost');
  }

  public async markFailureCallbackPending(
    operation: StoredChatwootOutboundOperation,
    workerId: string,
    lastErrorClass: string,
    now: Date,
  ): Promise<void> {
    await this.repository.$transaction(async (transaction) => {
      const owned = await transaction.chatwootOutboundOperation.updateMany({
        where: { id: operation.id, leaseOwner: workerId, state: { in: ['preparing', 'pending'] } },
        data: { state: 'failure_callback_pending', nextAttemptAt: now, lastErrorClass },
      });
      if (owned.count !== 1) throw new Error('OutboundLeaseLost');
      await transaction.chatwootOutboundOperation.updateMany({
        where: {
          id: { not: operation.id },
          instanceId: operation.instanceId,
          chatwootMessageId: operation.payload.origin.messageId,
          messageSetHash: operation.messageSetHash,
          state: { in: ['pending', 'preparing'] },
        },
        data: {
          state: 'failure_callback_pending',
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorClass,
        },
      });
    });
  }

  public async markMessageCompleted(
    operation: StoredChatwootOutboundOperation,
    workerId: string,
    now: Date,
  ): Promise<void> {
    await this.repository.$transaction(async (transaction) => {
      await this.assertLeaderLease(operation, workerId, ['callback_pending', 'failure_callback_pending'], transaction);
      const failures = await transaction.chatwootOutboundOperation.count({
        where: this.messageWhere(operation, ['failure_callback_pending']),
      });
      await transaction.chatwootOutboundOperation.updateMany({
        where: this.messageWhere(operation, ['callback_pending', 'failure_callback_pending']),
        data: {
          state: 'completed',
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorClass: failures > 0 ? 'PartialDelivery' : null,
        },
      });
    });
  }

  public async markMessageFailed(
    operation: StoredChatwootOutboundOperation,
    workerId: string,
    now: Date,
  ): Promise<void> {
    await this.repository.$transaction(async (transaction) => {
      await this.assertLeaderLease(operation, workerId, 'failure_callback_pending', transaction);
      await transaction.chatwootOutboundOperation.updateMany({
        where: this.messageWhere(operation, ['failure_callback_pending']),
        data: {
          state: 'failed',
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
    });
  }

  public async schedulePending(
    id: string,
    workerId: string,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, 'pending', nextAttemptAt, lastErrorClass, {
      preparationAttempts: { increment: 1 },
    });
  }

  public async deferCallback(id: string, workerId: string, nextAttemptAt: Date, lastErrorClass: string): Promise<void> {
    const operation = await this.repository.chatwootOutboundOperation.findUnique({ where: { id } });
    const state = operation?.state as ChatwootOutboundState;
    if (!['callback_pending', 'failure_callback_pending'].includes(state)) throw new Error('Invalid callback state');
    await this.schedule(id, workerId, state, nextAttemptAt, lastErrorClass);
  }

  public async scheduleCallback(
    id: string,
    workerId: string,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, 'callback_pending', nextAttemptAt, lastErrorClass, {
      callbackAttempts: { increment: 1 },
    });
  }

  public async scheduleFailureCallback(
    id: string,
    workerId: string,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, 'failure_callback_pending', nextAttemptAt, lastErrorClass, {
      callbackAttempts: { increment: 1 },
    });
  }

  public async scheduleAmbiguous(
    id: string,
    workerId: string,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, 'ambiguous', nextAttemptAt, lastErrorClass);
  }

  public async quarantineMessage(
    operation: StoredChatwootOutboundOperation,
    workerId: string,
    lastErrorClass: string,
  ): Promise<void> {
    const owned = await this.repository.chatwootOutboundOperation.count({
      where: { id: operation.id, leaseOwner: workerId },
    });
    if (owned !== 1) throw new Error('OutboundLeaseLost');
    await this.repository.chatwootOutboundOperation.updateMany({
      where: this.messageWhere(operation, [
        'pending',
        'preparing',
        'sending',
        'callback_pending',
        'failure_callback_pending',
        'ambiguous',
        'delete_pending',
      ]),
      data: {
        state: 'quarantined',
        lastErrorClass,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
  }

  public async requestDeletion(operation: StoredChatwootOutboundOperation): Promise<void> {
    await this.repository.chatwootOutboundOperation.updateMany({
      where: {
        instanceId: operation.instanceId,
        chatwootMessageId: operation.payload.origin.messageId,
        messageSetHash: operation.messageSetHash,
        state: { notIn: ['deleted', 'quarantined'] },
      },
      data: {
        state: 'delete_pending',
        nextAttemptAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorClass: null,
      },
    });
  }

  public async markDeleted(operation: StoredChatwootOutboundOperation, workerId: string, now: Date): Promise<void> {
    await this.repository.$transaction(async (transaction) => {
      const updated = await transaction.chatwootOutboundOperation.updateMany({
        where: { id: operation.id, state: 'delete_pending', leaseOwner: workerId },
        data: {
          state: 'deleted',
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorClass: null,
        },
      });
      if (updated.count !== 1) throw new Error('OutboundLeaseLost');
      const sourceId = operation.whatsappMessageId || operation.plannedWhatsappMessageId;
      if (operation.sendAttempts > 0) {
        await transaction.message.deleteMany({
          where: {
            instanceId: operation.instanceId,
            chatwootMessageId: operation.payload.origin.messageId,
            chatwootInboxId: operation.payload.origin.inboxId,
            chatwootConversationId: operation.payload.origin.conversationId,
            key: { path: ['id'], equals: sourceId },
          },
        });
      }
    });
  }

  public async scheduleDeletion(
    id: string,
    workerId: string,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, 'delete_pending', nextAttemptAt, lastErrorClass, {
      callbackAttempts: { increment: 1 },
    });
  }

  public async hasRetainedMessage(instanceId: string, messageId: number): Promise<boolean> {
    return (
      (await this.repository.chatwootOutboundOperation.count({
        where: { instanceId, chatwootMessageId: messageId },
      })) > 0
    );
  }

  public async retainedOperations(instanceId: string, messageId: number): Promise<StoredChatwootOutboundOperation[]> {
    return (await this.messageOperations(instanceId, messageId)).map((operation) => this.toStored(operation));
  }

  public async messageStatus(operation: StoredChatwootOutboundOperation): Promise<ChatwootOutboundMessageStatus> {
    const operations = await this.messageOperations(operation.instanceId, operation.payload.origin.messageId);
    this.assertStoredMessageSet(operations, operation.messageSetHash, operation.partCount);
    const waiting = operations.some((candidate) =>
      ['pending', 'preparing', 'sending', 'ambiguous', 'delete_pending'].includes(candidate.state),
    );
    const successes = operations.filter(
      (candidate) =>
        ['callback_pending', 'completed'].includes(candidate.state) &&
        typeof candidate.whatsappMessageId === 'string' &&
        candidate.whatsappMessageId.length > 0,
    );
    const failures = operations.filter((candidate) => ['failure_callback_pending', 'failed'].includes(candidate.state));
    const ready = !waiting && successes.length + failures.length === operations.length;
    const outcome = !ready
      ? 'waiting'
      : successes.length === operations.length
        ? 'success'
        : successes.length > 0
          ? 'partial_success'
          : 'failure';
    return {
      ready,
      leader: operation.partIndex === 0,
      outcome,
      callbackParts: ready
        ? successes.map((candidate, partIndex) => ({
            partKey: candidate.operationKey,
            partIndex,
            partCount: successes.length,
            sourceId: candidate.whatsappMessageId,
          }))
        : [],
    };
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
    return typeof key?.id === 'string' && key.id === operation.plannedWhatsappMessageId ? key.id : null;
  }

  private async messageOperations(instanceId: string, messageId: number): Promise<any[]> {
    return this.repository.chatwootOutboundOperation.findMany({
      where: { instanceId, chatwootMessageId: messageId },
      orderBy: { partIndex: 'asc' },
    });
  }

  private isExactFrozenPartSet(existing: any[], parts: ChatwootOutboundPart[]): boolean {
    const expectedHash = parts[0].messageSetHash;
    const exact =
      existing.length === parts.length &&
      existing.every(
        (operation, index) =>
          operation.messageSetHash === expectedHash &&
          operation.partCount === parts.length &&
          operation.partIndex === index &&
          operation.operationKey === parts[index].operationKey &&
          operation.partIdentity === parts[index].partIdentity &&
          operation.plannedWhatsappMessageId === parts[index].plannedWhatsappMessageId,
      );
    return exact;
  }

  private async quarantineFrozenSet(instanceId: string, messageId: number, lastErrorClass: string) {
    await this.repository.chatwootOutboundOperation.updateMany({
      where: { instanceId, chatwootMessageId: messageId },
      data: {
        state: 'quarantined',
        lastErrorClass,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
  }

  private assertStoredMessageSet(existing: any[], messageSetHash: string, partCount: number) {
    const indexes = existing.map((operation) => operation.partIndex);
    if (
      existing.length !== partCount ||
      existing.some((operation) => operation.messageSetHash !== messageSetHash || operation.partCount !== partCount) ||
      indexes.some((index, position) => index !== position)
    ) {
      throw new Error('Invalid frozen Chatwoot outbound part set');
    }
  }

  private messageWhere(operation: StoredChatwootOutboundOperation, states: ChatwootOutboundState[]) {
    return {
      instanceId: operation.instanceId,
      chatwootMessageId: operation.payload.origin.messageId,
      messageSetHash: operation.messageSetHash,
      state: { in: states },
    };
  }

  private async assertLeaderLease(
    operation: StoredChatwootOutboundOperation,
    workerId: string,
    state: ChatwootOutboundState | ChatwootOutboundState[],
    repository: Pick<PrismaRepository, 'chatwootOutboundOperation'> = this.repository,
  ) {
    if (operation.partIndex !== 0) throw new Error('Invalid callback leader');
    const owned = await repository.chatwootOutboundOperation.count({
      where: { id: operation.id, state: Array.isArray(state) ? { in: state } : state, leaseOwner: workerId },
    });
    if (owned !== 1) throw new Error('OutboundLeaseLost');
  }

  private toStored(candidate: any): StoredChatwootOutboundOperation {
    return {
      id: candidate.id,
      operationKey: candidate.operationKey,
      messageSetHash: candidate.messageSetHash,
      instanceId: candidate.instanceId,
      chatwootMessageId: candidate.chatwootMessageId,
      chatwootInboxId: candidate.chatwootInboxId,
      chatwootConversationId: candidate.chatwootConversationId,
      partIdentity: candidate.partIdentity,
      partIndex: candidate.partIndex,
      partCount: candidate.partCount,
      plannedWhatsappMessageId: candidate.plannedWhatsappMessageId,
      whatsappMessageId: candidate.whatsappMessageId,
      state: candidate.state as ChatwootOutboundState,
      payload: candidate.payload as unknown as ChatwootOutboundPayload,
      preparationAttempts: candidate.preparationAttempts,
      sendAttempts: candidate.sendAttempts,
      callbackAttempts: candidate.callbackAttempts,
    };
  }

  private async schedule(
    id: string,
    workerId: string,
    state: ChatwootOutboundState,
    nextAttemptAt: Date,
    lastErrorClass: string,
    increments: Record<string, unknown> = {},
  ) {
    const updated = await this.repository.chatwootOutboundOperation.updateMany({
      where: { id, leaseOwner: workerId },
      data: {
        state,
        nextAttemptAt,
        lastErrorClass,
        leaseOwner: null,
        leaseExpiresAt: null,
        ...increments,
      },
    });
    if (updated.count !== 1) throw new Error('OutboundLeaseLost');
  }
}
