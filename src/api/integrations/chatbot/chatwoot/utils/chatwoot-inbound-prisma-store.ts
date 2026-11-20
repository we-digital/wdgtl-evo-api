import { PrismaRepository } from '@api/repository/repository.service';

import { canonicalInboundBody } from './chatwoot-inbound-native-source';
import {
  InboundAck,
  InboundDelivery,
  InboundLane,
  inboundPayloadHash,
  InboundStore,
  InboundTerminalReason,
  InboundTerminalState,
} from './chatwoot-inbound-queue';

// Settled rows (delivered, ignored, already in Chatwoot) are kept this long for
// diagnosis and duplicate suppression, then deleted. Failed rows stay for recovery.
export const INBOUND_RETENTION_STATES = ['confirmed', 'ignored', 'already_present'] as const;
export const INBOUND_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// This delegate is generated from both supported provider schemas at image build time.
interface Delegate {
  deleteMany(args: any): Promise<{ count: number }>;
  upsert(args: any): Promise<InboundDelivery>;
  findMany(args: any): Promise<InboundDelivery[]>;
  updateMany(args: any): Promise<{ count: number }>;
  groupBy(args: any): Promise<{ instanceId: string; _min: { nextAttemptAt: Date | null } }[]>;
}
// History rows fetched per instance in one poll. The queue runs one history row per
// instance at a time, so a few rows per instance keep every instance moving.
const HISTORY_ROWS_PER_INSTANCE = 2;
export class ChatwootInboundPrismaStore implements InboundStore {
  private readonly rows: Delegate;
  constructor(repository: PrismaRepository) {
    this.rows = (repository as unknown as { chatwootInboundDelivery: Delegate }).chatwootInboundDelivery;
  }
  async enqueue(item: InboundDelivery) {
    // Repeated notify/append events do not replace a pending frozen native source or reset confirmed delivery.
    const stored = await this.rows.upsert({ where: { id: item.id }, create: item, update: {} });
    // An 'ignored' row only proves its own frozen payload carried no content
    // (e.g. a sender-key-only copy). Different content under the same key reopens it.
    if (stored.state !== 'ignored' || stored.payloadHash === item.payloadHash) return stored;
    // Rows admitted before the ledger stored base64 bytes hash the same source
    // differently: compare in the stored encoding before reopening.
    if (inboundPayloadHash(canonicalInboundBody(stored.payload), true) === item.payloadHash) return stored;
    const reopened = await this.rows.updateMany({
      where: { id: item.id, state: 'ignored', payloadHash: stored.payloadHash },
      data: {
        payload: item.payload,
        payloadHash: item.payloadHash,
        state: item.state,
        attempts: 0,
        nextAttemptAt: item.nextAttemptAt,
        lastErrorClass: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    return reopened.count === 1 ? { ...stored, ...item, inboxId: stored.inboxId } : stored;
  }
  async due(now: Date, limit: number) {
    const size = Math.max(0, Math.min(Math.trunc(limit), 50));
    if (!size) return [];
    const where = (state: string, extra: Record<string, unknown> = {}) => ({
      state,
      nextAttemptAt: { lte: now },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      ...extra,
    });
    const due = (state: string, take: number, fresh?: boolean) =>
      take <= 0
        ? Promise.resolve([] as InboundDelivery[])
        : this.rows.findMany({
            where: where(state, fresh === undefined ? {} : { attempts: fresh ? 0 : { gt: 0 } }),
            orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
            take,
          });
    // Live first: never-attempted rows ahead of retries, so a retry backlog can
    // not delay new messages. Reconnect history only fills what live leaves.
    const fresh = await due('pending', size, true);
    const retry = await due('pending', size - fresh.length, false);
    const history = await this.dueHistory(where, size - fresh.length - retry.length);
    return [...fresh, ...retry, ...history];
  }
  // Reconnect history is shared fairly between instances: a few rows of every
  // instance with due history, interleaved, oldest instance first. A large or
  // failing backlog of one number can no longer hold the lane for the others.
  private async dueHistory(where: (state: string, extra?: Record<string, unknown>) => any, take: number) {
    if (take <= 0) return [] as InboundDelivery[];
    const instances = await this.rows.groupBy({
      by: ['instanceId'],
      where: where('history_pending'),
      _min: { nextAttemptAt: true },
      orderBy: { _min: { nextAttemptAt: 'asc' } },
      take,
    });
    if (!instances.length) return [] as InboundDelivery[];
    const per = Math.max(1, Math.min(HISTORY_ROWS_PER_INSTANCE, Math.floor(take / instances.length)));
    const batches = await Promise.all(
      instances.map(({ instanceId }) =>
        this.rows.findMany({
          where: where('history_pending', { instanceId }),
          orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
          take: per,
        }),
      ),
    );
    const rows: InboundDelivery[] = [];
    for (let round = 0; round < per; round++)
      for (const batch of batches) if (batch[round] && rows.length < take) rows.push(batch[round]);
    return rows;
  }
  async claim(id: string, owner: string, now: Date, until: Date) {
    return (
      (
        await this.rows.updateMany({
          where: {
            id,
            state: { in: ['pending', 'history_pending'] },
            nextAttemptAt: { lte: now },
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
          },
          data: { leaseOwner: owner, leaseExpiresAt: until, attempts: { increment: 1 } },
        })
      ).count === 1
    );
  }
  async renew(id: string, owner: string, until: Date) {
    return (
      (
        await this.rows.updateMany({
          where: { id, state: { in: ['pending', 'history_pending'] }, leaseOwner: owner },
          data: { leaseExpiresAt: until },
        })
      ).count === 1
    );
  }
  async bindInbox(id: string, owner: string, inboxId: number) {
    return (
      (
        await this.rows.updateMany({
          where: {
            id,
            state: { in: ['pending', 'history_pending'] },
            leaseOwner: owner,
            OR: [{ inboxId: null }, { inboxId }],
          },
          data: { inboxId },
        })
      ).count === 1
    );
  }
  async finish(id: string, owner: string, ack: InboundAck) {
    return (
      (
        await this.rows.updateMany({
          where: { id, state: { in: ['pending', 'history_pending'] }, leaseOwner: owner },
          data: {
            state: 'confirmed',
            result: ack,
            confirmedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorClass: null,
          },
        })
      ).count === 1
    );
  }
  async fail(
    id: string,
    owner: string,
    state: InboundTerminalState,
    errorClass: string,
    lane?: InboundLane,
    reason?: InboundTerminalReason,
  ) {
    return (
      (
        await this.rows.updateMany({
          where: { id, state: { in: ['pending', 'history_pending'] }, leaseOwner: owner },
          data: {
            state,
            lastErrorClass: errorClass.slice(0, 100),
            leaseOwner: null,
            leaseExpiresAt: null,
            ...(lane ? { result: { terminal: state, lane, ...(reason ? { reason } : {}) } } : {}),
          },
        })
      ).count === 1
    );
  }
  // Bus outcomes arrive without a lease: the row was published and released.
  async confirmPublished(id: string, ack: InboundAck) {
    return (
      (
        await this.rows.updateMany({
          where: { id, state: { in: ['pending', 'history_pending'] } },
          data: {
            state: 'confirmed',
            result: ack,
            confirmedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorClass: null,
          },
        })
      ).count === 1
    );
  }
  async failPublished(id: string, state: InboundTerminalState, errorClass: string) {
    return (
      (
        await this.rows.updateMany({
          where: { id, state: { in: ['pending', 'history_pending'] } },
          data: { state, lastErrorClass: errorClass.slice(0, 100), leaseOwner: null, leaseExpiresAt: null },
        })
      ).count === 1
    );
  }
  async advance(errorClasses: string[], now: Date) {
    if (!errorClasses.length) return 0;
    return (
      await this.rows.updateMany({
        where: {
          state: { in: ['pending', 'history_pending'] },
          lastErrorClass: { in: errorClasses },
          nextAttemptAt: { gt: now },
          leaseOwner: null,
        },
        data: { nextAttemptAt: now },
      })
    ).count;
  }
  /**
   * Deletes up to `limit` settled rows last scheduled before `before`. The state +
   * nextAttemptAt prefix walks Cwi_pending_idx, so the 7 GB of TOAST is never read
   * to find them; updatedAt guards rows touched again since (recovery, bus outcome).
   */
  async prune(before: Date, limit: number): Promise<number> {
    const take = Math.max(1, Math.min(Math.trunc(limit), 5_000));
    const rows = await this.rows.findMany({
      where: {
        state: { in: [...INBOUND_RETENTION_STATES] },
        nextAttemptAt: { lt: before },
        updatedAt: { lt: before },
      },
      select: { id: true },
      take,
    });
    if (!rows.length) return 0;
    return (
      await this.rows.deleteMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          state: { in: [...INBOUND_RETENTION_STATES] },
          updatedAt: { lt: before },
        },
      })
    ).count;
  }
  async defer(id: string, owner: string, errorClass: string, until: Date) {
    await this.rows.updateMany({
      where: { id, state: { in: ['pending', 'history_pending'] }, leaseOwner: owner },
      data: { nextAttemptAt: until, lastErrorClass: errorClass.slice(0, 100), leaseOwner: null, leaseExpiresAt: null },
    });
  }
}
