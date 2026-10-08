import { PrismaRepository } from '@api/repository/repository.service';

import { InboundAck, InboundDelivery, InboundStore } from './chatwoot-inbound-queue';

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
  enqueue(item: InboundDelivery) {
    // Repeated notify/append events do not replace a pending frozen native source or reset confirmed delivery.
    return this.rows.upsert({ where: { id: item.id }, create: item, update: {} });
  }
  due(now: Date, limit: number) {
    return this.rows.findMany({
      where: {
        state: 'pending',
        nextAttemptAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: Math.min(limit, 8),
    });
  }
  async claim(id: string, owner: string, now: Date, until: Date) {
    return (
      (
        await this.rows.updateMany({
          where: {
            id,
            state: 'pending',
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
          where: { id, state: 'pending', leaseOwner: owner },
          data: { leaseExpiresAt: until },
        })
      ).count === 1
    );
  }
  async bindInbox(id: string, owner: string, inboxId: number) {
    return (
      (
        await this.rows.updateMany({
          where: { id, state: 'pending', leaseOwner: owner, OR: [{ inboxId: null }, { inboxId }] },
          data: { inboxId },
        })
      ).count === 1
    );
  }
  async finish(id: string, owner: string, ack: InboundAck) {
    return (
      (
        await this.rows.updateMany({
          where: { id, state: 'pending', leaseOwner: owner },
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
  async defer(id: string, owner: string, errorClass: string, until: Date) {
    await this.rows.updateMany({
      where: { id, state: 'pending', leaseOwner: owner },
      data: { nextAttemptAt: until, lastErrorClass: errorClass.slice(0, 100), leaseOwner: null, leaseExpiresAt: null },
    });
  }
}
