/**
 * A WhatsApp delete (revoke) marks the Chatwoot message deleted first; only
 * after Chatwoot confirms is EVO's own row marked. A Chatwoot failure leaves
 * the row untouched so the next revoke delivery can retry.
 */
export async function confirmProviderDeletionBeforeMarkingLocal<T>({
  softDelete,
  markLocal,
}: {
  softDelete: () => Promise<T>;
  markLocal: () => Promise<unknown>;
}): Promise<T> {
  const result = await softDelete();
  await markLocal();
  return result;
}

/** The stored key with `deleted: true`; everything else (id, chat, direction) kept. */
export function markWhatsappKeyDeleted(key: unknown): Record<string, unknown> {
  const base = key && typeof key === 'object' && !Array.isArray(key) ? (key as Record<string, unknown>) : {};
  return { ...base, deleted: true };
}

type DeleteTargetRow = {
  key?: unknown;
  status?: unknown;
  chatwootMessageId?: unknown;
  chatwootConversationId?: unknown;
} | null;

/**
 * Cheap decision on the plain EVO row, before any binding reconciliation:
 * no row or no Chatwoot pointers → unmapped (nothing to mark); a row already
 * marked (our own staff delete echoed back, a repeated revoke) → done.
 */
export function providerDeleteFastPath(row: DeleteTargetRow): 'unmapped' | 'already_deleted' | 'proceed' {
  if (!row) return 'unmapped';
  const key = row.key && typeof row.key === 'object' ? (row.key as Record<string, unknown>) : {};
  if (row.status === 'DELETED' || key.deleted === true) return 'already_deleted';
  const pointer = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
  if (!pointer(row.chatwootMessageId) || !pointer(row.chatwootConversationId)) return 'unmapped';
  return 'proceed';
}

export type ProviderDeleteLimiterOptions = {
  concurrency?: number;
  maxQueued?: number;
  attempts?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  onDrop?: (instanceId: string) => void;
  onFailure?: (instanceId: string, error: unknown, attempt: number, final: boolean) => void;
};

/**
 * WhatsApp revokes arrive un-awaited from the Baileys event loop and can come
 * in bursts (a group admin clearing a thread). Each one takes a Chatwoot
 * request that locks its chat, so they run at most `concurrency` at a time per
 * instance, wait in a bounded queue, and retry a failure with backoff.
 */
export class ProviderDeleteLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly attempts: number;
  private readonly backoffMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ProviderDeleteLimiterOptions = {}) {
    this.concurrency = options.concurrency ?? 3;
    this.maxQueued = options.maxQueued ?? 500;
    this.attempts = options.attempts ?? 3;
    this.backoffMs = options.backoffMs ?? [2000, 5000];
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public async run<T>(instanceId: string, task: () => Promise<T>): Promise<T | undefined> {
    if (!(await this.acquire(instanceId))) {
      this.options.onDrop?.(instanceId);
      return undefined;
    }
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await task();
        } catch (error) {
          const final = attempt >= this.attempts;
          this.options.onFailure?.(instanceId, error, attempt, final);
          if (final) return undefined;
          await this.sleep(this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)] ?? 0);
        }
      }
    } finally {
      this.release(instanceId);
    }
  }

  private acquire(instanceId: string): Promise<boolean> {
    const active = this.active.get(instanceId) ?? 0;
    if (active < this.concurrency) {
      this.active.set(instanceId, active + 1);
      return Promise.resolve(true);
    }
    const queue = this.waiting.get(instanceId) ?? [];
    if (queue.length >= this.maxQueued) return Promise.resolve(false);
    this.waiting.set(instanceId, queue);
    return new Promise<boolean>((resolve) => queue.push(() => resolve(true)));
  }

  private release(instanceId: string) {
    const queue = this.waiting.get(instanceId);
    const next = queue?.shift();
    if (queue && !queue.length) this.waiting.delete(instanceId);
    if (next) {
      next();
      return;
    }
    const active = (this.active.get(instanceId) ?? 1) - 1;
    if (active > 0) this.active.set(instanceId, active);
    else this.active.delete(instanceId);
  }
}
