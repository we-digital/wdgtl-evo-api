import { createHash, randomUUID } from 'node:crypto';

export type InboundPayload = Record<string, any>;
export type InboundAck = { id: number; inbox_id: number; conversation_id: number };
export interface InboundDelivery {
  id: string;
  instanceId: string;
  instanceName: string;
  providerId: string;
  providerFingerprint: string;
  accountId: number;
  inboxId: number | null;
  peer: string;
  sourceId: string;
  fromMe: boolean;
  payload: InboundPayload;
  payloadHash: string;
  state: string;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  result: InboundAck | null;
  lastErrorClass?: string | null;
  createdAt?: Date;
}
export interface InboundStore {
  enqueue(item: InboundDelivery): Promise<InboundDelivery>;
  due(now: Date, limit: number): Promise<InboundDelivery[]>;
  claim(id: string, owner: string, now: Date, until: Date): Promise<boolean>;
  renew(id: string, owner: string, until: Date): Promise<boolean>;
  finish(id: string, owner: string, ack: InboundAck): Promise<boolean>;
  defer(id: string, owner: string, errorClass: string, until: Date): Promise<void>;
  // Terminal, visible end state: the row leaves the retry lanes with its reason kept.
  // The lane is kept so recovery can requeue a closed row into its original lane.
  fail(
    id: string,
    owner: string,
    state: InboundTerminalState,
    errorClass: string,
    lane?: InboundLane,
  ): Promise<boolean>;
}
export type InboundTerminalState = 'failed' | 'ignored';
export type InboundLane = 'live' | 'history';
export const INBOUND_ACTIVE_STATES = ['pending', 'history_pending'] as const;

// Bounded retry: quick retries for transient receiver errors, then a slow
// steady cadence until the failure cap moves the row to a terminal state.
export const INBOUND_RETRY_SCHEDULE_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
export const INBOUND_RETRY_STEADY_MS = 300_000;
export const INBOUND_FAIL_AFTER_MS = 24 * 60 * 60 * 1000;
export function inboundRetryDelayMs(attempts: number): number {
  const index = Math.max(0, Math.trunc(attempts) - 1);
  return INBOUND_RETRY_SCHEDULE_MS[index] ?? INBOUND_RETRY_STEADY_MS;
}

// Errors that cannot change by retrying the same frozen source. The row is
// closed immediately with its reason instead of retrying for a day.
const terminalErrors: Record<string, InboundTerminalState> = {
  InboundTransportOnly: 'ignored',
  InboundHistoryRouteIgnored: 'ignored',
  InboundPayloadTooLarge: 'failed',
  InboundStoredSourceChanged: 'failed',
  InboundIdentityUnavailable: 'failed',
};

export function inboundChatKey(item: Pick<InboundDelivery, 'instanceId' | 'peer'>): string {
  return item.instanceId + '|' + item.peer;
}

function providerTimestampMs(payload: InboundPayload): number | null {
  const value = payload?.messageTimestamp;
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : value && typeof value === 'object' && Number.isFinite(value.low)
          ? (value.high || 0) * 4294967296 + (value.low >>> 0)
          : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export interface InboundQueueOptions {
  concurrency?: number;
  failAfterMs?: number;
  latencyReportMs?: number;
}

// Hash only native source fields; CW back-pointers and delivery receipts are not source content.
export function inboundPayloadHash(body: InboundPayload): string {
  const source = Object.fromEntries(
    ['key', 'message', 'messageType', 'messageTimestamp', 'contextInfo', 'participant', 'pushName'].map((k) => [
      k,
      body[k] ?? null,
    ]),
  );
  // Match the ledger/native JSON representation, including installed SDK Buffer/toJSON fields.
  const stable = (v: any): any =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(JSON.parse(JSON.stringify(source)))))
    .digest('hex');
}
export function inboundDeliveryId(instanceId: string, body: InboundPayload): string {
  const { id, remoteJid, fromMe } = body.key ?? {};
  if (
    !instanceId ||
    typeof id !== 'string' ||
    !id ||
    id.length > 100 ||
    typeof remoteJid !== 'string' ||
    remoteJid.length > 100 ||
    typeof fromMe !== 'boolean'
  )
    throw new Error('InboundIdentityUnavailable');
  return createHash('sha256')
    .update(JSON.stringify([instanceId, remoteJid, id, fromMe]))
    .digest('hex');
}

export class ChatwootInboundQueue {
  private readonly owner = randomUUID();
  private readonly active = new Map<string, Promise<InboundAck | undefined>>();
  // One in-flight delivery per instance+peer keeps per-chat order; different chats run in parallel.
  private readonly activeChats = new Set<string>();
  private activeHistory = 0;
  private timer: NodeJS.Timeout | null = null;
  private reportTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private filling = false;
  private refill = false;
  private readonly concurrency: number;
  private readonly failAfterMs: number;
  private readonly latencyReportMs: number;
  private latencies: Record<string, { provider: number[]; queue: number[]; failed: number }> = {};
  constructor(
    private readonly store: InboundStore,
    private readonly deliver: (item: InboundDelivery) => Promise<InboundAck>,
    private readonly observe: (event: string, fields: Record<string, unknown>) => void = () => {},
    // A fixed delay is only used by tests; production uses the bounded schedule.
    private readonly retryMs?: number,
    private readonly leaseMs = 120_000,
    private readonly now = () => new Date(),
    options: InboundQueueOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.min(32, Math.trunc(options.concurrency ?? 2)));
    this.failAfterMs = Math.max(60_000, options.failAfterMs ?? INBOUND_FAIL_AFTER_MS);
    this.latencyReportMs = Math.max(1_000, options.latencyReportMs ?? 60_000);
  }

  async submit(item: InboundDelivery): Promise<InboundAck | undefined> {
    // The database commit precedes all receiver reads/writes; no in-memory retry receipt substitutes for it.
    const stored = await this.store.enqueue(item);
    if (stored.state === 'confirmed') return stored.result ?? undefined;
    if (stored.state === 'failed' || stored.state === 'ignored') return undefined;
    return this.attempt(stored) ?? Promise.resolve(undefined);
  }
  start() {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), 1_000);
    this.timer.unref?.();
    this.reportTimer = setInterval(() => this.reportLatency(), this.latencyReportMs);
    this.reportTimer.unref?.();
    this.kick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.timer = null;
    this.reportTimer = null;
    await Promise.allSettled([...this.active.values()]);
  }
  // Drains what is due now: fills free slots, waits, and repeats while work was
  // started (tests and manual drains). Deferred rows are not due again here.
  async poll() {
    for (let round = 0; round < 1_000 && !this.stopped; round++) {
      const started = await this.fill();
      if (!started.length) return;
      await Promise.allSettled(started);
    }
  }
  private kick() {
    void this.fill().catch((e) => this.observe('chatwoot_inbound_poll_failed', { errorClass: e?.name || 'Error' }));
  }
  private async fill(): Promise<Promise<InboundAck | undefined>[]> {
    if (this.stopped) return [];
    if (this.filling) {
      this.refill = true;
      return [];
    }
    this.filling = true;
    const started: Promise<InboundAck | undefined>[] = [];
    try {
      do {
        this.refill = false;
        const free = this.concurrency - this.active.size;
        if (free <= 0) break;
        // Over-fetch so rows of a busy chat do not leave slots idle.
        const items = await this.store.due(this.now(), Math.min(50, free * 4));
        for (const item of items) {
          if (this.stopped || this.active.size >= this.concurrency) break;
          const work = this.attempt(item);
          if (work) started.push(work);
        }
      } while (this.refill && !this.stopped);
    } finally {
      this.filling = false;
    }
    return started;
  }
  private attempt(item: InboundDelivery): Promise<InboundAck | undefined> | undefined {
    const known = this.active.get(item.id);
    if (known) return known;
    // Live submissions and polling share the same slots. Overflow is already
    // committed to the ledger: polling claims it later without holding a lease.
    if (this.stopped || this.active.size >= this.concurrency) return undefined;
    const history = item.state === 'history_pending';
    // Per chat for live order; history additionally holds its instance, since
    // the stored-history importer admits one writer per instance at a time.
    const keys = history ? [inboundChatKey(item), 'history|' + item.instanceId] : [inboundChatKey(item)];
    if (keys.some((key) => this.activeChats.has(key))) return undefined;
    // History never takes the last live slots: live delivery stays ahead of reconnect backlogs.
    if (history && this.activeHistory >= Math.max(1, Math.floor(this.concurrency / 2))) return undefined;
    for (const key of keys) this.activeChats.add(key);
    if (history) this.activeHistory++;
    const work = this.perform(item).finally(() => {
      this.active.delete(item.id);
      for (const key of keys) this.activeChats.delete(key);
      if (history) this.activeHistory--;
      if (this.timer && !this.stopped) this.kick();
    });
    this.active.set(item.id, work);
    return work;
  }
  private record(lane: string, providerMs: number | null, queueMs: number | null) {
    const bucket = (this.latencies[lane] ??= { provider: [], queue: [], failed: 0 });
    if (providerMs !== null && bucket.provider.length < 10_000) bucket.provider.push(providerMs);
    if (queueMs !== null && bucket.queue.length < 10_000) bucket.queue.push(queueMs);
  }
  reportLatency() {
    const windows = this.latencies;
    this.latencies = {};
    for (const [lane, bucket] of Object.entries(windows)) {
      const provider = [...bucket.provider].sort((a, b) => a - b);
      const queue = [...bucket.queue].sort((a, b) => a - b);
      this.observe('chatwoot_inbound_latency', {
        lane,
        confirmed: provider.length,
        failed: bucket.failed,
        providerP50Ms: provider.length ? percentile(provider, 0.5) : null,
        providerP95Ms: provider.length ? percentile(provider, 0.95) : null,
        queueP50Ms: queue.length ? percentile(queue, 0.5) : null,
        queueP95Ms: queue.length ? percentile(queue, 0.95) : null,
        queueMaxMs: queue.length ? queue[queue.length - 1] : null,
      });
    }
  }
  private async perform(item: InboundDelivery): Promise<InboundAck | undefined> {
    const now = this.now();
    if (this.stopped || !(await this.store.claim(item.id, this.owner, now, new Date(now.getTime() + this.leaseMs))))
      return;
    const attempts = item.attempts + 1;
    const lane: InboundLane = item.state === 'history_pending' ? 'history' : 'live';
    let lost = false;
    let renewing = false;
    const heartbeat = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        void this.store
          .renew(item.id, this.owner, new Date(this.now().getTime() + this.leaseMs))
          .then((ok) => {
            if (!ok) lost = true;
          })
          .catch(() => {
            lost = true;
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(10, Math.floor(this.leaseMs / 4)),
    );
    heartbeat.unref?.();
    try {
      const ack = await this.deliver({ ...item, leaseOwner: this.owner });
      if (
        lost ||
        !Number.isSafeInteger(ack?.id) ||
        ack.id <= 0 ||
        !Number.isSafeInteger(ack.inbox_id) ||
        ack.inbox_id <= 0 ||
        !Number.isSafeInteger(ack.conversation_id) ||
        ack.conversation_id <= 0
      )
        throw new Error('InboundReceiverOutcomeUnconfirmed');
      if (!(await this.store.finish(item.id, this.owner, ack))) throw new Error('InboundReceiptLeaseLost');
      const done = this.now().getTime();
      const provider = providerTimestampMs(item.payload);
      const providerMs = provider === null ? null : Math.max(0, done - provider);
      const queueMs = item.createdAt ? Math.max(0, done - new Date(item.createdAt).getTime()) : null;
      this.record(lane, providerMs, queueMs);
      this.observe('chatwoot_inbound_confirmed', {
        instanceId: item.instanceId,
        inboxId: ack.inbox_id,
        destinationId: ack.id,
        lane,
        attempts,
        providerLatencyMs: providerMs,
        queueLatencyMs: queueMs,
      });
      return ack;
    } catch (error) {
      const errorClass =
        error instanceof Error && /^Inbound[A-Za-z]+$/.test(error.message)
          ? error.message
          : error instanceof Error
            ? error.name
            : 'Error';
      // Unknown HTTP outcomes remain retryable. The next attempt MUST read exact receiver owners before POST.
      // Only the failure cap or a deterministic source error closes the row, with its reason kept.
      const at = this.now().getTime();
      const age = at - new Date(item.createdAt ?? at).getTime();
      const terminal: InboundTerminalState | undefined =
        terminalErrors[errorClass] ?? (age >= this.failAfterMs ? 'failed' : undefined);
      if (terminal && !lost && (await this.store.fail(item.id, this.owner, terminal, errorClass, lane))) {
        if (terminal === 'failed') (this.latencies[lane] ??= { provider: [], queue: [], failed: 0 }).failed++;
        this.observe(terminal === 'failed' ? 'chatwoot_inbound_failed' : 'chatwoot_inbound_ignored', {
          instanceId: item.instanceId,
          lane,
          errorClass,
          attempts,
          ageMs: age,
        });
        return;
      }
      const delay = this.retryMs ?? inboundRetryDelayMs(attempts);
      await this.store.defer(item.id, this.owner, errorClass, new Date(at + delay));
      this.observe('chatwoot_inbound_pending', {
        instanceId: item.instanceId,
        lane,
        errorClass,
        attempts,
        retryInMs: delay,
      });
      return;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
