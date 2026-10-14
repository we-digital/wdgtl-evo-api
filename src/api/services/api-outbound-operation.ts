import { createHash, randomUUID } from 'node:crypto';

export interface ApiOutboundRecord {
  id: string;
  instanceId: string;
  fingerprint: string;
  state: string;
  plannedWhatsappMessageId: string;
  destinationJid: string | null;
  result: any;
  claimToken: string | null;
  leaseExpiresAt: Date | null;
  transportStartedAt: Date | null;
  nextAttemptAt: Date;
  attempts: number;
  lastErrorCode: string | null;
}

export interface ApiOutboundStore {
  admit(id: string, instanceId: string, fingerprint: string): Promise<ApiOutboundRecord>;
  read(id: string, instanceId: string): Promise<ApiOutboundRecord | null>;
  claim(record: ApiOutboundRecord, token: string, now: Date, until: Date): Promise<boolean>;
  start(record: ApiOutboundRecord, token: string, destinationJid: string, now: Date): Promise<boolean>;
  receipt(record: ApiOutboundRecord, token: string | null, result: any): Promise<boolean>;
  defer(
    record: ApiOutboundRecord,
    token: string,
    started: boolean,
    code: string,
    next: Date,
    terminal?: boolean,
    retainLease?: boolean,
  ): Promise<void>;
  renew(record: ApiOutboundRecord, token: string, now: Date, until: Date): Promise<boolean>;
  release(record: ApiOutboundRecord, token: string): Promise<void>;
  recover(record: ApiOutboundRecord, now: Date): Promise<ApiOutboundRecord>;
  findReceipt(record: ApiOutboundRecord): Promise<any | null>;
}

const canonical = (value: any): any => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};

export const apiOutboundFingerprint = (route: string, payload: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical({ route, payload })))
    .digest('hex');

export const isApiOperationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export const isApiNonRecipient = (error: any, payload: any): boolean => {
  const number = String(payload?.number || '').replace(/\D/g, '');
  const entries = error?.message;
  if (error?.status !== 400 || !number || !Array.isArray(entries) || entries.length !== 1) return false;
  const item = entries[0];
  return (
    item &&
    !Array.isArray(item) &&
    item.exists === false &&
    item.number === number &&
    item.jid === `${number}@s.whatsapp.net` &&
    Object.keys(item).every((key) => ['number', 'jid', 'exists', 'name'].includes(key))
  );
};

export class ApiOutboundConflict extends Error {
  readonly status = 409;
  constructor() {
    super('API_OPERATION_BINDING_MISMATCH');
  }
}

export interface ApiOutboundHooks {
  messageId: string;
  signal: AbortSignal;
  beforeTransport: (destinationJid?: string) => Promise<void>;
  afterTransport: (receipt: any) => Promise<void>;
}

/** An opt-in durable boundary for API sends. Never infer delivery from HTTP status. */
export class ApiOutboundOperations {
  private stopping = false;
  private readonly active = new Map<string, Promise<any>>();
  constructor(
    private readonly store: ApiOutboundStore,
    private readonly now = () => new Date(),
    private readonly sendTimeoutMs = 120_000,
    private readonly leaseMs = 180_000,
  ) {}

  private view(record: ApiOutboundRecord) {
    return {
      operation: {
        id: record.id,
        fingerprint: record.fingerprint,
        plannedWhatsappMessageId: record.plannedWhatsappMessageId,
        destinationJid: record.destinationJid,
        state: record.state,
        attempts: record.attempts,
        retryAfterMs: Math.max(
          1000,
          Math.max(record.nextAttemptAt.getTime(), record.leaseExpiresAt?.getTime() || 0) - this.now().getTime(),
        ),
        retryAllowed:
          ['pending', 'unknown'].includes(record.state) &&
          record.nextAttemptAt <= this.now() &&
          (!record.leaseExpiresAt || record.leaseExpiresAt <= this.now()) &&
          !this.active.has(record.id),
        transportStarted: Boolean(record.transportStartedAt),
        errorCode: record.lastErrorCode,
      },
      ...(record.state === 'sent' ? { key: record.result.key } : {}),
    };
  }

  private async reconcile(record: ApiOutboundRecord) {
    if (record.state === 'sent' || record.state === 'failed') return record;
    const recovered = await this.store.recover(record, this.now());
    // An exact retained provider ID is evidence even when its message body is unavailable.
    if (recovered.transportStartedAt && recovered.destinationJid) {
      const receipt = await this.store.findReceipt(recovered);
      if (receipt) await this.store.receipt(recovered, null, receipt);
    }
    return (await this.store.read(record.id, record.instanceId))!;
  }

  async status(id: string, instanceId: string) {
    id = id.toLowerCase();
    const record = await this.store.read(id, instanceId);
    return record ? this.view(await this.reconcile(record)) : null;
  }

  async send(
    id: string,
    instanceId: string,
    route: string,
    payload: unknown,
    retryAmbiguous: boolean,
    send: (hooks: ApiOutboundHooks) => Promise<any>,
  ) {
    if (!isApiOperationId(id)) throw new Error('INVALID_API_OPERATION_ID');
    id = id.toLowerCase();
    if (this.stopping) throw Object.assign(new Error('API_OPERATIONS_DRAINING'), { status: 503 });
    let record = await this.store.admit(id, instanceId, apiOutboundFingerprint(route, payload));
    record = await this.reconcile(record);
    if (
      this.active.has(id) ||
      ['sent', 'failed', 'sending'].includes(record.state) ||
      (record.state === 'unknown' && !retryAmbiguous) ||
      record.nextAttemptAt > this.now()
    )
      return this.view(record);
    const token = randomUUID();
    if (!(await this.store.claim(record, token, this.now(), new Date(this.now().getTime() + this.leaseMs))))
      return this.view((await this.store.read(id, instanceId))!);
    record = (await this.store.read(id, instanceId))!;
    const abort = new AbortController();
    let started = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error('API_SEND_TIMEOUT'));
      }, this.sendTimeoutMs);
    });
    try {
      const sending = Promise.resolve().then(() =>
        send({
          messageId: record.plannedWhatsappMessageId,
          signal: abort.signal,
          beforeTransport: async (destinationJid) => {
            if (started) throw new Error('API_TRANSPORT_ALREADY_STARTED');
            if (this.stopping || abort.signal.aborted || !destinationJid) throw new Error('API_TRANSPORT_NOT_READY');
            if (!(await this.store.start(record, token, destinationJid, this.now())))
              throw new Error('API_OPERATION_LEASE_LOST');
            started = true;
          },
          afterTransport: async (receipt) => {
            if (!started || receipt?.key?.id !== record.plannedWhatsappMessageId || receipt.key.fromMe !== true)
              throw new Error('API_RECEIPT_MISMATCH');
            if (!(await this.store.receipt(record, token, { key: receipt.key })))
              throw new Error('API_RECEIPT_COMMIT_FAILED');
          },
        }),
      );
      this.active.set(id, sending);
      const renewal = setInterval(
        () => {
          void this.store
            .renew(record, token, this.now(), new Date(this.now().getTime() + this.leaseMs))
            .then((owned) => {
              if (!owned) abort.abort();
            })
            .catch(() => abort.abort());
        },
        Math.max(10, Math.floor(this.leaseMs / 3)),
      );
      renewal.unref?.();
      // A timed-out caller must not overlap another send with the still-live transport.
      void sending
        .finally(async () => {
          settled = true;
          clearInterval(renewal);
          try {
            await this.store.release(record, token);
          } finally {
            if (this.active.get(id) === sending) this.active.delete(id);
          }
        })
        .catch(() => {});
      const result = await Promise.race([sending, timeout]);
      const saved = (await this.store.read(id, instanceId))!;
      if (saved.state !== 'sent' || result?.key?.id !== saved.plannedWhatsappMessageId)
        throw new Error('API_RECEIPT_NOT_COMMITTED');
      return this.view(saved);
    } catch (error) {
      const saved = (await this.store.read(id, instanceId))!;
      // History/webhook work failing after the receipt commit must not lose delivery proof.
      if (saved.state === 'sent') return this.view(saved);
      const terminal = !started && isApiNonRecipient(error, payload);
      const code = terminal
        ? 'EVO_RECIPIENT_NOT_ON_WHATSAPP'
        : error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
          ? error.message
          : 'API_SEND_FAILED';
      const backoff = Math.min(300_000, 5000 * 2 ** Math.min(record.attempts - 1, 6));
      await this.store.defer(
        record,
        token,
        started,
        code,
        new Date(this.now().getTime() + backoff),
        terminal,
        !settled,
      );
      if (settled) await this.store.release(record, token);
      return this.view((await this.store.read(id, instanceId))!);
    } finally {
      clearTimeout(timer!);
    }
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled([...this.active.values()]);
  }
}
