import {
  ChatwootOutboundAdmission,
  ChatwootOutboundBacklog,
  ChatwootOutboundMessageStatus,
  ChatwootOutboundPart,
  ChatwootOutboundPayload,
  ChatwootOutboundState,
  ChatwootOutboundStore,
  ChatwootOutboundWorkClass,
  StoredChatwootOutboundOperation,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';
import { PrismaRepository } from '@api/repository/repository.service';

const ACTIVE_STATES: ChatwootOutboundState[] = [
  'pending',
  'preparing',
  'sending',
  'callback_pending',
  'failure_callback_pending',
  'ambiguous',
  'delete_pending',
];
const TRANSPORT_STATES: ChatwootOutboundState[] = ['pending'];
const MAINTENANCE_STATES: ChatwootOutboundState[] = [
  'callback_pending',
  'failure_callback_pending',
  'ambiguous',
  'delete_pending',
  'quarantined',
];
const LANE_BLOCKING_STATES: ChatwootOutboundState[] = [
  'pending',
  'preparing',
  'sending',
  'ambiguous',
  'delete_pending',
];
const LANE_BLOCKING_STATE_WHERE = {
  OR: [{ state: { in: LANE_BLOCKING_STATES } }, { state: 'quarantined', transportOutcomeUnresolved: true }],
};
const ACTIVE_STATE_WHERE = {
  OR: [{ state: { in: ACTIVE_STATES } }, { state: 'quarantined', transportOutcomeUnresolved: true }],
};

export class ChatwootOutboundPrismaStore implements ChatwootOutboundStore {
  constructor(
    private readonly repository: PrismaRepository,
    private readonly transactionOptions = { maxWait: 2_000, timeout: 5_000 },
  ) {}

  public async enqueue(
    instanceId: string,
    messageId: number,
    inboxId: number,
    conversationId: number,
    parts: ChatwootOutboundPart[],
    admission: ChatwootOutboundAdmission,
  ): Promise<{ recovered: boolean; backlog?: ChatwootOutboundBacklog }> {
    if (parts.length === 0) throw new Error('Chatwoot outbound part set is empty');
    if (parts.some((part) => part.laneKey !== parts[0].laneKey)) {
      throw new Error('Chatwoot outbound part set spans multiple lanes');
    }

    const [knownReceipt, knownOperations] = await Promise.all([
      this.repository.chatwootOutboundWebhookDelivery.findUnique({
        where: { deliveryId: admission.deliveryId },
      }),
      this.repository.chatwootOutboundOperation.findMany({
        where: { instanceId, chatwootMessageId: messageId },
        orderBy: { partIndex: 'asc' },
      }),
    ]);
    let backlog: ChatwootOutboundBacklog | undefined;
    if (!knownReceipt && knownOperations.length === 0) {
      backlog = await this.backlog();
      if (backlog.depth + parts.length > admission.maxBacklog) {
        throw Object.assign(new Error('Chatwoot outbound backlog capacity is exhausted'), {
          name: 'ChatwootOutboundBacklogExceeded',
          status: 503,
        });
      }
      if (backlog.oldestAt && admission.receivedAt.getTime() - backlog.oldestAt.getTime() > admission.maxOldestAgeMs) {
        throw Object.assign(new Error('Chatwoot outbound backlog is too old'), {
          name: 'ChatwootOutboundBacklogTooOld',
          status: 503,
        });
      }
    }

    const outcome = await this.repository.$transaction(async (transaction) => {
      const lane = await transaction.chatwootOutboundLane.upsert({
        where: { laneKey: parts[0].laneKey },
        create: { laneKey: parts[0].laneKey, nextSequence: 1, updatedAt: admission.receivedAt },
        update: { nextSequence: { increment: 1 } },
      });
      const receipt = await transaction.chatwootOutboundWebhookDelivery.findUnique({
        where: { deliveryId: admission.deliveryId },
      });
      const existing = await transaction.chatwootOutboundOperation.findMany({
        where: { instanceId, chatwootMessageId: messageId },
        orderBy: { partIndex: 'asc' },
      });
      if (receipt) {
        if (receipt.instanceId !== instanceId || receipt.chatwootMessageId !== messageId) {
          throw Object.assign(new Error('Chatwoot delivery identifier was replayed for another operation'), {
            name: 'ChatwootWebhookReplayRejected',
            status: 409,
          });
        }
        if (receipt.messageSetHash !== parts[0].messageSetHash || !this.isExactFrozenPartSet(existing, parts)) {
          await this.preserveUnresolvedTransportFence(transaction, instanceId, messageId);
          await transaction.chatwootOutboundOperation.updateMany({
            where: { instanceId, chatwootMessageId: messageId },
            data: {
              state: 'quarantined',
              lastErrorClass: 'ChangedFrozenPartSet',
              leaseOwner: null,
              leaseExpiresAt: null,
            },
          });
          return { recovered: false, rejection: 'ChangedFrozenPartSet' as const };
        }
        return { recovered: true, rejection: null };
      }
      if (existing.length > 0) {
        if (!this.isExactFrozenPartSet(existing, parts)) {
          await this.preserveUnresolvedTransportFence(transaction, instanceId, messageId);
          await transaction.chatwootOutboundOperation.updateMany({
            where: { instanceId, chatwootMessageId: messageId },
            data: {
              state: 'quarantined',
              lastErrorClass: 'ChangedFrozenPartSet',
              leaseOwner: null,
              leaseExpiresAt: null,
            },
          });
          return { recovered: false, rejection: 'ChangedFrozenPartSet' as const };
        }
        await transaction.chatwootOutboundWebhookDelivery.create({
          data: {
            deliveryId: admission.deliveryId,
            instanceId,
            chatwootMessageId: messageId,
            messageSetHash: parts[0].messageSetHash,
            receivedAt: admission.receivedAt,
          },
        });
        return { recovered: true, rejection: null };
      }
      await transaction.chatwootOutboundWebhookDelivery.create({
        data: {
          deliveryId: admission.deliveryId,
          instanceId,
          chatwootMessageId: messageId,
          messageSetHash: parts[0].messageSetHash,
          receivedAt: admission.receivedAt,
        },
      });
      await Promise.all(
        parts.map((part) =>
          transaction.chatwootOutboundOperation.create({
            data: {
              operationKey: part.operationKey,
              messageSetHash: part.messageSetHash,
              instanceId,
              chatwootMessageId: messageId,
              chatwootInboxId: inboxId,
              chatwootConversationId: conversationId,
              webhookDeliveryId: admission.deliveryId,
              laneKey: part.laneKey,
              laneSequence: lane.nextSequence,
              partIdentity: part.partIdentity,
              partIndex: part.partIndex,
              partCount: part.partCount,
              plannedWhatsappMessageId: part.plannedWhatsappMessageId,
              payload: part.payload as any,
              webhookReceivedAt: admission.receivedAt,
              messageCreatedAt: admission.messageCreatedAt,
            },
          }),
        ),
      );
      return {
        recovered: false,
        rejection: null,
        backlog: {
          depth: (backlog?.depth ?? 0) + parts.length,
          oldestAt: backlog?.oldestAt ?? admission.receivedAt,
        },
      };
    }, this.transactionOptions);
    if (outcome.rejection === 'ChangedFrozenPartSet') {
      throw new Error('Chatwoot outbound part set is already frozen with different content');
    }
    return { recovered: outcome.recovered, ...(outcome.backlog ? { backlog: outcome.backlog } : {}) };
  }

  public async backlog(): Promise<ChatwootOutboundBacklog> {
    const [depth, oldest] = await Promise.all([
      this.repository.chatwootOutboundOperation.count({ where: ACTIVE_STATE_WHERE }),
      this.repository.chatwootOutboundOperation.findFirst({
        where: ACTIVE_STATE_WHERE,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    return { depth, oldestAt: oldest?.createdAt ?? null };
  }

  public async recoverExpired(now: Date): Promise<void> {
    await this.repository.$transaction([
      this.repository.chatwootOutboundOperation.updateMany({
        where: {
          transportOutcomeUnresolved: false,
          whatsappMessageId: null,
          OR: [
            { state: { in: ['sending', 'ambiguous'] } },
            {
              state: 'quarantined',
              OR: [{ sendAttempts: { gt: 0 } }, { sendStartedAt: { not: null } }],
            },
          ],
        },
        data: { transportOutcomeUnresolved: true },
      }),
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
        data: {
          state: 'ambiguous',
          transportOutcomeUnresolved: true,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: now,
        },
      }),
      this.repository.chatwootOutboundOperation.updateMany({
        where: {
          state: { in: ['callback_pending', 'failure_callback_pending', 'ambiguous', 'quarantined'] },
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
    workClass: ChatwootOutboundWorkClass = 'any',
  ): Promise<StoredChatwootOutboundOperation | null> {
    const states =
      workClass === 'transport' ? TRANSPORT_STATES : workClass === 'maintenance' ? MAINTENANCE_STATES : ACTIVE_STATES;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let candidate = null;
      let cursor: string | undefined;
      while (!candidate) {
        const candidates = await this.repository.chatwootOutboundOperation.findMany({
          where: {
            state: { in: states },
            nextAttemptAt: { lte: now },
            AND: [
              { OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: now } }] },
              ...(workClass === 'maintenance'
                ? [
                    {
                      OR: [
                        { state: { in: ['callback_pending', 'failure_callback_pending'] }, partIndex: 0 },
                        { state: 'ambiguous' },
                        { state: 'delete_pending' },
                        { state: 'quarantined', transportOutcomeUnresolved: true },
                      ],
                    },
                  ]
                : []),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { partIndex: 'asc' }, { id: 'asc' }],
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          take: 64,
        });
        for (const eligible of candidates) {
          if (workClass === 'maintenance' && (await this.isMaintenanceEligible(eligible))) {
            candidate = eligible;
            break;
          }
          if (workClass !== 'maintenance' && !(await this.hasLanePredecessor(eligible))) {
            candidate = eligible;
            break;
          }
        }
        if (candidate || candidates.length < 64) break;
        cursor = candidates[candidates.length - 1].id;
      }
      if (!candidate) return null;

      const claimedState = candidate.state === 'pending' ? 'preparing' : candidate.state;
      const claimed = await this.repository.chatwootOutboundOperation.updateMany({
        where: {
          id: candidate.id,
          state: candidate.state,
          OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: {
          state: claimedState,
          leaseOwner: workerId,
          leaseExpiresAt,
          claimGeneration: { increment: 1 },
          claimedAt: now,
        },
      });
      if (claimed.count === 1)
        return this.toStored({
          ...candidate,
          state: claimedState,
          claimGeneration: candidate.claimGeneration + 1,
          claimedAt: now,
        });
    }
    return null;
  }

  public async markValidated(id: string, workerId: string, claimGeneration: number, now: Date): Promise<void> {
    const updated = await this.repository.chatwootOutboundOperation.updateMany({
      where: { id, state: 'preparing', leaseOwner: workerId, claimGeneration },
      data: { validatedAt: now },
    });
    if (updated.count !== 1) throw new Error('OutboundLeaseLost');
  }

  public async markCallbackStarted(id: string, workerId: string, claimGeneration: number, now: Date): Promise<void> {
    const updated = await this.repository.chatwootOutboundOperation.updateMany({
      where: {
        id,
        state: { in: ['callback_pending', 'failure_callback_pending'] },
        leaseOwner: workerId,
        claimGeneration,
      },
      data: { callbackStartedAt: now },
    });
    if (updated.count !== 1) throw new Error('OutboundLeaseLost');
  }

  public async markSending(
    id: string,
    workerId: string,
    claimGeneration: number,
    providerContext: unknown,
    now: Date,
  ): Promise<boolean> {
    const updated = await this.repository.chatwootOutboundOperation.updateMany({
      where: { id, state: 'preparing', leaseOwner: workerId, claimGeneration },
      data: {
        state: 'sending',
        callbackContext: providerContext as any,
        sendStartedAt: now,
        sendAttempts: { increment: 1 },
        transportOutcomeUnresolved: true,
      },
    });
    return updated.count === 1;
  }

  public async markCallbackPending(
    id: string,
    workerId: string,
    claimGeneration: number,
    whatsappMessageId: string,
    result: unknown,
    now: Date,
  ): Promise<void> {
    const updated = await this.repository.chatwootOutboundOperation.updateMany({
      where: { id, state: { in: ['sending', 'ambiguous'] }, leaseOwner: workerId, claimGeneration },
      data: {
        state: 'callback_pending',
        whatsappMessageId,
        result: (result ?? undefined) as any,
        sentAt: now,
        transportOutcomeUnresolved: false,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
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
        where: {
          id: operation.id,
          leaseOwner: workerId,
          claimGeneration: operation.claimGeneration,
          state: { in: ['preparing', 'pending'] },
        },
        data: {
          state: 'failure_callback_pending',
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorClass,
        },
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
      if (operation.partIndex !== 0) throw new Error('Invalid callback leader');
      const callbackStates: ChatwootOutboundState[] = ['callback_pending', 'failure_callback_pending'];
      const failures = await transaction.chatwootOutboundOperation.count({
        where: this.messageWhere(operation, ['failure_callback_pending']),
      });
      const data = {
        state: 'completed',
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorClass: failures > 0 ? 'PartialDelivery' : null,
      };
      const leader = await transaction.chatwootOutboundOperation.updateMany({
        where: {
          ...this.messageWhere(operation, callbackStates),
          id: operation.id,
          leaseOwner: workerId,
          claimGeneration: operation.claimGeneration,
        },
        data,
      });
      if (leader.count !== 1) throw new Error('OutboundLeaseLost');
      await transaction.chatwootOutboundOperation.updateMany({
        where: { ...this.messageWhere(operation, callbackStates), id: { not: operation.id } },
        data,
      });
    });
  }

  public async markMessageFailed(
    operation: StoredChatwootOutboundOperation,
    workerId: string,
    now: Date,
  ): Promise<void> {
    await this.repository.$transaction(async (transaction) => {
      if (operation.partIndex !== 0) throw new Error('Invalid callback leader');
      const data = {
        state: 'failed',
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      const leader = await transaction.chatwootOutboundOperation.updateMany({
        where: {
          ...this.messageWhere(operation, ['failure_callback_pending']),
          id: operation.id,
          leaseOwner: workerId,
          claimGeneration: operation.claimGeneration,
        },
        data,
      });
      if (leader.count !== 1) throw new Error('OutboundLeaseLost');
      await transaction.chatwootOutboundOperation.updateMany({
        where: { ...this.messageWhere(operation, ['failure_callback_pending']), id: { not: operation.id } },
        data,
      });
    });
  }

  public async schedulePending(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, claimGeneration, 'pending', nextAttemptAt, lastErrorClass, {
      preparationAttempts: { increment: 1 },
    });
  }

  public async deferPending(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, claimGeneration, 'pending', nextAttemptAt, lastErrorClass);
  }

  public async deferCallback(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    const operation = await this.repository.chatwootOutboundOperation.findUnique({ where: { id } });
    const state = operation?.state as ChatwootOutboundState;
    if (!['callback_pending', 'failure_callback_pending'].includes(state)) throw new Error('Invalid callback state');
    await this.schedule(id, workerId, claimGeneration, state, nextAttemptAt, lastErrorClass);
  }

  public async scheduleCallback(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, claimGeneration, 'callback_pending', nextAttemptAt, lastErrorClass, {
      callbackAttempts: { increment: 1 },
    });
  }

  public async scheduleFailureCallback(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, claimGeneration, 'failure_callback_pending', nextAttemptAt, lastErrorClass, {
      callbackAttempts: { increment: 1 },
    });
  }

  public async scheduleAmbiguous(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, claimGeneration, 'ambiguous', nextAttemptAt, lastErrorClass);
  }

  public async resolveQuarantinedTransport(
    id: string,
    workerId: string,
    claimGeneration: number,
    whatsappMessageId: string,
    now: Date,
  ): Promise<void> {
    const updated = await this.repository.chatwootOutboundOperation.updateMany({
      where: {
        id,
        state: 'quarantined',
        transportOutcomeUnresolved: true,
        leaseOwner: workerId,
        claimGeneration,
      },
      data: {
        whatsappMessageId,
        sentAt: now,
        transportOutcomeUnresolved: false,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (updated.count !== 1) throw new Error('OutboundLeaseLost');
  }

  public async scheduleQuarantined(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, claimGeneration, 'quarantined', nextAttemptAt, lastErrorClass);
  }

  public async quarantineMessage(
    operation: StoredChatwootOutboundOperation,
    workerId: string,
    lastErrorClass: string,
  ): Promise<void> {
    await this.repository.$transaction(async (transaction) => {
      const activeStates: ChatwootOutboundState[] = [
        'pending',
        'preparing',
        'sending',
        'callback_pending',
        'failure_callback_pending',
        'ambiguous',
        'delete_pending',
      ];
      const data = {
        state: 'quarantined',
        lastErrorClass,
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      const owned = await transaction.chatwootOutboundOperation.updateMany({
        where: {
          id: operation.id,
          state: { in: activeStates },
          leaseOwner: workerId,
          claimGeneration: operation.claimGeneration,
        },
        data,
      });
      if (owned.count !== 1) throw new Error('OutboundLeaseLost');
      await transaction.chatwootOutboundOperation.updateMany({
        where: { ...this.messageWhere(operation, activeStates), id: { not: operation.id } },
        data,
      });
    });
  }

  public async requestDeletion(operation: StoredChatwootOutboundOperation): Promise<void> {
    await this.repository.chatwootOutboundOperation.updateMany({
      where: {
        instanceId: operation.instanceId,
        chatwootMessageId: operation.payload.origin.messageId,
        messageSetHash: operation.messageSetHash,
        state: { not: 'deleted' },
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
        where: {
          id: operation.id,
          state: 'delete_pending',
          leaseOwner: workerId,
          claimGeneration: operation.claimGeneration,
        },
        data: {
          state: 'deleted',
          completedAt: now,
          transportOutcomeUnresolved: false,
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
            key: { path: ['id'], equals: sourceId },
          },
        });
      }
    });
  }

  public async scheduleDeletion(
    id: string,
    workerId: string,
    claimGeneration: number,
    nextAttemptAt: Date,
    lastErrorClass: string,
  ): Promise<void> {
    await this.schedule(id, workerId, claimGeneration, 'delete_pending', nextAttemptAt, lastErrorClass, {
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

  private async hasLanePredecessor(candidate: any): Promise<boolean> {
    if (!candidate.laneKey || BigInt(candidate.laneSequence ?? 0) <= 0n) {
      return (
        (await this.repository.chatwootOutboundOperation.count({
          where: {
            id: { not: candidate.id },
            AND: [
              LANE_BLOCKING_STATE_WHERE,
              {
                OR: [
                  { createdAt: { lt: candidate.createdAt } },
                  { createdAt: candidate.createdAt, partIndex: { lt: candidate.partIndex } },
                ],
              },
            ],
          },
        })) > 0
      );
    }
    return (
      (await this.repository.chatwootOutboundOperation.count({
        where: {
          AND: [
            LANE_BLOCKING_STATE_WHERE,
            {
              OR: [
                {
                  laneKey: candidate.laneKey,
                  OR: [
                    { laneSequence: { lt: candidate.laneSequence } },
                    { laneSequence: candidate.laneSequence, partIndex: { lt: candidate.partIndex } },
                  ],
                },
                { laneKey: '', createdAt: { lte: candidate.createdAt } },
              ],
            },
          ],
        },
      })) > 0
    );
  }

  private async isMaintenanceEligible(candidate: any): Promise<boolean> {
    if (candidate.state === 'ambiguous') return true;
    if (candidate.state === 'quarantined') return candidate.transportOutcomeUnresolved === true;
    if (candidate.state === 'delete_pending') return !(await this.hasLanePredecessor(candidate));
    if (!['callback_pending', 'failure_callback_pending'].includes(candidate.state) || candidate.partIndex !== 0) {
      return false;
    }
    return (
      (await this.repository.chatwootOutboundOperation.count({
        where: {
          instanceId: candidate.instanceId,
          chatwootMessageId: candidate.chatwootMessageId,
          messageSetHash: candidate.messageSetHash,
          state: { in: LANE_BLOCKING_STATES },
        },
      })) === 0
    );
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
          operation.plannedWhatsappMessageId === parts[index].plannedWhatsappMessageId &&
          this.retainedContactIdentityMatches(operation.payload?.origin, parts[index].payload.origin),
      );
    return exact;
  }

  private retainedContactIdentityMatches(existing: any, replay: ChatwootOutboundPayload['origin']): boolean {
    return (
      (existing?.contactId === undefined || existing?.contactId === null || existing.contactId === replay.contactId) &&
      (existing?.contactInboxId === undefined ||
        existing?.contactInboxId === null ||
        existing.contactInboxId === replay.contactInboxId)
    );
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

  private async preserveUnresolvedTransportFence(
    repository: any,
    instanceId: string,
    messageId: number,
  ): Promise<void> {
    await repository.chatwootOutboundOperation.updateMany({
      where: {
        instanceId,
        chatwootMessageId: messageId,
        transportOutcomeUnresolved: false,
        whatsappMessageId: null,
        OR: [
          { state: { in: ['sending', 'ambiguous'] } },
          {
            state: 'quarantined',
            OR: [{ sendAttempts: { gt: 0 } }, { sendStartedAt: { not: null } }],
          },
        ],
      },
      data: { transportOutcomeUnresolved: true },
    });
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
      transportOutcomeUnresolved: candidate.transportOutcomeUnresolved ?? false,
      callbackAttempts: candidate.callbackAttempts,
      claimGeneration: candidate.claimGeneration,
      webhookDeliveryId: candidate.webhookDeliveryId ?? undefined,
      laneKey: candidate.laneKey,
      laneSequence: BigInt(candidate.laneSequence ?? 0),
      webhookReceivedAt: candidate.webhookReceivedAt ?? undefined,
      messageCreatedAt: candidate.messageCreatedAt ?? undefined,
      createdAt: candidate.createdAt ?? undefined,
      claimedAt: candidate.claimedAt ?? undefined,
      validatedAt: candidate.validatedAt ?? undefined,
      sendStartedAt: candidate.sendStartedAt ?? undefined,
      sentAt: candidate.sentAt ?? undefined,
      callbackStartedAt: candidate.callbackStartedAt ?? undefined,
      callbackContext: candidate.callbackContext ?? undefined,
    };
  }

  private async schedule(
    id: string,
    workerId: string,
    claimGeneration: number,
    state: ChatwootOutboundState,
    nextAttemptAt: Date,
    lastErrorClass: string,
    increments: Record<string, unknown> = {},
  ) {
    const updated = await this.repository.chatwootOutboundOperation.updateMany({
      where: { id, leaseOwner: workerId, claimGeneration },
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
