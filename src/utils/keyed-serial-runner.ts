/**
 * Runs tasks one at a time per key and in parallel across keys.
 *
 * WhatsApp ingest uses it per chat: the messages.upsert loop only admits each
 * message to the durable inbound ledger, then queues the rest of that message's
 * work (Chatwoot delivery, native row, media, contact) here. A slow document in
 * one chat no longer delays every other chat of the same batch, while messages of
 * one chat keep their arrival order.
 */
export class KeyedSerialRunner {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly onError: (key: string, error: unknown) => void = () => {}) {}

  run(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task).catch((error) => this.onError(key, error));
    this.tails.set(key, next);
    this.pending.add(next);
    void next.finally(() => {
      this.pending.delete(next);
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Waits for queued work, at most `timeoutMs`. Resolves true when everything finished. */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.pending.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), left);
      });
      const result = await Promise.race([Promise.allSettled([...this.pending]).then(() => 'done' as const), timedOut]);
      clearTimeout(timer);
      if (result === 'timeout') return this.pending.size === 0;
    }
    return true;
  }
}
