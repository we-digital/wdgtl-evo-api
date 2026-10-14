import { ApiOutboundConflict, ApiOutboundRecord, ApiOutboundStore } from './api-outbound-operation';

/** Compare-and-set claims fence concurrent requests and recovered processes. */
export class ApiOutboundPrismaStore implements ApiOutboundStore {
  constructor(
    private readonly db: any,
    private readonly provider = 'postgresql',
  ) {}

  async admit(id: string, instanceId: string, fingerprint: string) {
    try {
      await this.db.apiOutboundOperation.create({
        data: {
          id,
          instanceId,
          fingerprint,
          plannedWhatsappMessageId: id.replace(/-/g, '').toUpperCase(),
        },
      });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
    }
    const record = await this.read(id, instanceId);
    if (!record || record.fingerprint !== fingerprint) throw new ApiOutboundConflict();
    return record;
  }

  async read(id: string, instanceId: string): Promise<ApiOutboundRecord | null> {
    const record = await this.db.apiOutboundOperation.findUnique({ where: { id } });
    if (record && record.instanceId !== instanceId) throw new ApiOutboundConflict();
    return record;
  }

  async claim(record: ApiOutboundRecord, token: string, now: Date, until: Date) {
    const result = await this.db.apiOutboundOperation.updateMany({
      where: {
        id: record.id,
        instanceId: record.instanceId,
        fingerprint: record.fingerprint,
        state: record.state,
        attempts: record.attempts,
        nextAttemptAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        state: 'sending',
        claimToken: token,
        leaseExpiresAt: until,
        transportStartedAt: null,
        destinationJid: null,
        attempts: { increment: 1 },
        lastErrorCode: null,
      },
    });
    return result.count === 1;
  }

  async start(record: ApiOutboundRecord, token: string, destinationJid: string, now: Date) {
    const result = await this.db.apiOutboundOperation.updateMany({
      where: {
        id: record.id,
        state: 'sending',
        claimToken: token,
        leaseExpiresAt: { gt: now },
        transportStartedAt: null,
      },
      data: { destinationJid, transportStartedAt: now },
    });
    return result.count === 1;
  }

  async receipt(record: ApiOutboundRecord, token: string | null, receipt: any) {
    if (receipt?.key?.id !== record.plannedWhatsappMessageId || receipt.key.fromMe !== true) return false;
    const current = await this.read(record.id, record.instanceId);
    if (
      !current?.destinationJid ||
      !current.transportStartedAt ||
      ![receipt.key.remoteJid, receipt.key.remoteJidAlt].includes(current.destinationJid)
    )
      return false;
    if (
      current.attempts !== record.attempts ||
      (!token &&
        (current.claimToken !== record.claimToken ||
          current.transportStartedAt?.getTime() !== record.transportStartedAt?.getTime()))
    )
      return false;
    const result = await this.db.apiOutboundOperation.updateMany({
      where: {
        id: record.id,
        instanceId: record.instanceId,
        state: { in: ['sending', 'unknown'] },
        fingerprint: record.fingerprint,
        destinationJid: current.destinationJid,
        attempts: current.attempts,
        transportStartedAt: current.transportStartedAt,
        claimToken: token || current.claimToken,
      },
      data: { state: 'sent', result: receipt, claimToken: null, leaseExpiresAt: null, lastErrorCode: null },
    });
    return result.count === 1 || (await this.read(record.id, record.instanceId))?.state === 'sent';
  }

  async defer(
    record: ApiOutboundRecord,
    token: string,
    started: boolean,
    code: string,
    next: Date,
    terminal = false,
    retainLease = false,
  ) {
    await this.db.apiOutboundOperation.updateMany({
      where: { id: record.id, state: 'sending', claimToken: token },
      data: {
        state: terminal ? 'failed' : started ? 'unknown' : 'pending',
        nextAttemptAt: next,
        lastErrorCode: code,
        ...(retainLease ? {} : { leaseExpiresAt: null }),
        ...(started || retainLease ? {} : { claimToken: null }),
      },
    });
  }

  async renew(record: ApiOutboundRecord, token: string, now: Date, until: Date) {
    const result = await this.db.apiOutboundOperation.updateMany({
      where: {
        id: record.id,
        instanceId: record.instanceId,
        claimToken: token,
        attempts: record.attempts,
        state: { in: ['sending', 'pending', 'unknown'] },
        leaseExpiresAt: { gt: now },
      },
      data: { leaseExpiresAt: until },
    });
    return result.count === 1;
  }

  async release(record: ApiOutboundRecord, token: string) {
    await this.db.apiOutboundOperation.updateMany({
      where: {
        id: record.id,
        instanceId: record.instanceId,
        claimToken: token,
        attempts: record.attempts,
        state: { in: ['pending', 'unknown'] },
      },
      data: { leaseExpiresAt: null },
    });
  }

  async recover(record: ApiOutboundRecord, now: Date) {
    if (record.state === 'sending' && record.leaseExpiresAt && record.leaseExpiresAt <= now) {
      for (const started of [false, true]) {
        await this.db.apiOutboundOperation.updateMany({
          where: {
            id: record.id,
            instanceId: record.instanceId,
            state: 'sending',
            claimToken: record.claimToken,
            attempts: record.attempts,
            leaseExpiresAt: { lte: now },
            transportStartedAt: started ? { not: null } : null,
          },
          data: {
            state: started ? 'unknown' : 'pending',
            leaseExpiresAt: null,
            nextAttemptAt: now,
            lastErrorCode: 'API_PROCESS_INTERRUPTED',
          },
        });
      }
    }
    return (await this.read(record.id, record.instanceId))!;
  }

  async findReceipt(record: ApiOutboundRecord) {
    const rows = await this.db.message.findMany({
      where: {
        instanceId: record.instanceId,
        key: { path: this.provider === 'mysql' ? '$.id' : ['id'], equals: record.plannedWhatsappMessageId },
      },
      select: { key: true, instanceId: true },
    });
    const match = rows.find(
      ({ key, instanceId }: any) =>
        instanceId === record.instanceId &&
        key?.id === record.plannedWhatsappMessageId &&
        key?.fromMe === true &&
        [key.remoteJid, key.remoteJidAlt].includes(record.destinationJid),
    );
    return match ? { key: match.key } : null;
  }
}
