import { PrismaRepository } from '@api/repository/repository.service';

import { InboundAck, InboundDelivery, InboundLane, InboundStore, InboundTerminalState } from './chatwoot-inbound-queue';

// This delegate is generated from both supported provider schemas at image build time.
interface Delegate {
  upsert(args: any): Promise<InboundDelivery>;
  findMany(args: any): Promise<InboundDelivery[]>;
  updateMany(args: any): Promise<{ count: number }>;
}
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
    const due = (state: string, take: number, fresh?: boolean) =>
      take <= 0
        ? Promise.resolve([] as InboundDelivery[])
        : this.rows.findMany({
            where: {
              state,
              nextAttemptAt: { lte: now },
              OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
              ...(fresh === undefined ? {} : { attempts: fresh ? 0 : { gt: 0 } }),
            },
            orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
            take,
          });
    // Live first: never-attempted rows ahead of retries, so a retry backlog can
    // not delay new messages. Reconnect history only fills what live leaves.
    const fresh = await due('pending', size, true);
    const retry = await due('pending', size - fresh.length, false);
    const history = await due('history_pending', size - fresh.length - retry.length);
    return [...fresh, ...retry, ...history];
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
  async fail(id: string, owner: string, state: InboundTerminalState, errorClass: string, lane?: InboundLane) {
    return (
      (
        await this.rows.updateMany({
          where: { id, state: { in: ['pending', 'history_pending'] }, leaseOwner: owner },
          data: {
            state,
            lastErrorClass: errorClass.slice(0, 100),
            leaseOwner: null,
            leaseExpiresAt: null,
            ...(lane ? { result: { terminal: state, lane } } : {}),
          },
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
  async defer(id: string, owner: string, errorClass: string, until: Date) {
    await this.rows.updateMany({
      where: { id, state: { in: ['pending', 'history_pending'] }, leaseOwner: owner },
      data: { nextAttemptAt: until, lastErrorClass: errorClass.slice(0, 100), leaseOwner: null, leaseExpiresAt: null },
    });
  }
}
