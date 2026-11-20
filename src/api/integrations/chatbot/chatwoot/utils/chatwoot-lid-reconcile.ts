// LID → phone identity reconcile, paced for the Chatwoot API.
//
// Baileys emits one `lid-mapping.update` per learned mapping, and a re-pair or a
// history sync emits hundreds within a minute. Reconciling each one inline (with
// REST contact searches) fired ~111 searches/min at Chatwoot, got HTTP 429 and,
// since the limit is per source IP, throttled every other EVO instance as well.
//
// This scheduler takes mappings off the per-instance event queue, coalesces them
// per instance+LID, and runs them one at a time for the whole process at a bounded
// rate. A 429 pauses the whole drain (Retry-After or exponential backoff) and puts
// the mapping back; other failures are logged with their real HTTP status.

export interface LidReconcileJob {
  instanceName: string;
  lid: string;
  phoneJid: string;
}

export interface LidReconcileOptions {
  minIntervalMs?: number;
  maxPending?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

type Run = (job: LidReconcileJob) => Promise<unknown>;
type Observe = (event: string, fields: Record<string, unknown>) => void;

interface Entry extends LidReconcileJob {
  attempts: number;
}

// Status and shape of a Chatwoot SDK/axios error, without bodies or headers.
export function chatwootErrorStatus(error: unknown): number | undefined {
  const value = error as { status?: unknown; response?: { status?: unknown } } | undefined;
  const status = Number(value?.status ?? value?.response?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  const value = error as { body?: any; response?: { headers?: Record<string, unknown> } } | undefined;
  const raw = value?.response?.headers?.['retry-after'] ?? value?.body?.retry_after;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : undefined;
}

// "ApiError: Generic Error" says nothing; name the status and the endpoint shape.
export function describeChatwootError(error: unknown): string {
  const status = chatwootErrorStatus(error);
  const value = error as { name?: string; message?: string; statusText?: string; url?: string } | undefined;
  const name = value?.name || 'Error';
  const path = typeof value?.url === 'string' ? value.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') : '';
  const shape = path.replace(/\/\d+(?=\/|$)/g, '/:id');
  const message = (value?.message || '').replace(/\d{5,}/g, '<n>').slice(0, 160);
  if (status === undefined) return `${name}: ${message || 'unknown error'}`;
  return `${name} HTTP ${status}${value?.statusText ? ' ' + value.statusText : ''}${shape ? ' ' + shape : ''}`;
}

export class LidReconcileScheduler {
  private readonly pending = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pausedUntil = 0;
  private consecutive429 = 0;
  private readonly minIntervalMs: number;
  private readonly maxPending: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private stats = { done: 0, failed: 0, throttled: 0, dropped: 0, coalesced: 0 };

  constructor(
    private readonly run: Run,
    private readonly observe: Observe = () => {},
    options: LidReconcileOptions = {},
    private readonly now = () => Date.now(),
  ) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 500);
    this.maxPending = Math.max(1, options.maxPending ?? 5_000);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    this.backoffBaseMs = Math.max(1, options.backoffBaseMs ?? 5_000);
    this.backoffMaxMs = Math.max(this.backoffBaseMs, options.backoffMaxMs ?? 120_000);
  }

  get size() {
    return this.pending.size;
  }

  enqueue(job: LidReconcileJob) {
    const key = job.instanceName + '|' + job.lid;
    const known = this.pending.get(key);
    if (known) {
      // The newest mapping for this LID wins; one reconcile covers the burst.
      known.phoneJid = job.phoneJid;
      this.stats.coalesced++;
      return;
    }
    if (this.pending.size >= this.maxPending) {
      // Unreconciled LID contacts are repaired later by reconcileStoredLidContacts.
      this.stats.dropped++;
      return;
    }
    this.pending.set(key, { ...job, attempts: 0 });
    this.schedule(0);
  }

  // Drains everything due now (tests). Respects pauses by returning early.
  async drain() {
    while (this.pending.size && this.now() >= this.pausedUntil) await this.step();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number) {
    if (this.timer || this.running) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.tick();
      },
      Math.max(0, delayMs),
    );
    this.timer.unref?.();
  }

  private async tick() {
    const wait = this.pausedUntil - this.now();
    if (wait > 0) return this.schedule(wait);
    await this.step();
    if (this.pending.size) this.schedule(Math.max(this.minIntervalMs, this.pausedUntil - this.now()));
    else this.report();
  }

  private async step() {
    if (this.running) return;
    const first = this.pending.entries().next();
    if (first.done) return;
    const [key, entry] = first.value;
    this.pending.delete(key);
    this.running = true;
    try {
      entry.attempts++;
      await this.run(entry);
      this.consecutive429 = 0;
      this.stats.done++;
    } catch (error) {
      const status = chatwootErrorStatus(error);
      if (status === 429 && entry.attempts < this.maxAttempts) {
        this.consecutive429++;
        this.stats.throttled++;
        const backoff =
          retryAfterMs(error) ??
          Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(this.consecutive429 - 1, 10));
        this.pausedUntil = this.now() + backoff;
        // Back at the end of the line; newer mappings for it still coalesce into it.
        if (!this.pending.has(key)) this.pending.set(key, entry);
        this.observe('chatwoot_lid_reconcile_throttled', {
          instanceName: entry.instanceName,
          status,
          attempts: entry.attempts,
          pauseMs: backoff,
          pending: this.pending.size,
        });
      } else {
        this.stats.failed++;
        this.observe('chatwoot_lid_reconcile_failed', {
          instanceName: entry.instanceName,
          ...(status ? { status } : {}),
          attempts: entry.attempts,
          error: describeChatwootError(error),
        });
      }
    } finally {
      this.running = false;
    }
  }

  private report() {
    const stats = this.stats;
    if (!stats.done && !stats.failed && !stats.throttled && !stats.dropped) return;
    this.stats = { done: 0, failed: 0, throttled: 0, dropped: 0, coalesced: 0 };
    this.observe('chatwoot_lid_reconcile_drained', stats);
  }
}
