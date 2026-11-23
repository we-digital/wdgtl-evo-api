/**
 * Serialized Baileys event processing with a stall watchdog.
 *
 * Every `ev.process` batch of one socket runs in order. A step that never settles
 * (an await on something that never resolves) used to block the instance forever:
 * no live messages, and not even the `close` of a restart, so the status stayed
 * "open" while the socket was gone (f-bukit, 2026-11-23). After `stallMs` the
 * queue logs the stuck step with its stage and moves on; the stuck promise keeps
 * running detached and is logged again if it ever settles.
 */
export type EventStepReport = {
  events: string[];
  stage: string | null;
  elapsedMs: number;
};

export type EventStepQueueOptions = {
  stallMs: number;
  onStall: (report: EventStepReport) => void;
  onLateSettle?: (report: EventStepReport) => void;
  onError: (error: unknown, report: EventStepReport) => void;
  now?: () => number;
};

export const DEFAULT_EVENT_STEP_STALL_MS = 180_000;

export function eventStepStallMs(raw: string | undefined): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) return DEFAULT_EVENT_STEP_STALL_MS;
  return Math.max(5_000, Math.trunc(value));
}

export class EventStepQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: EventStepQueueOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Queues one batch; `work` marks its current stage so a stall names it. */
  push(events: string[], work: (stage: (name: string) => void) => Promise<void>): Promise<void> {
    this.tail = this.tail.then(() => this.run(events, work));
    return this.tail;
  }

  private run(events: string[], work: (stage: (name: string) => void) => Promise<void>): Promise<void> {
    const started = this.now();
    let stage: string | null = null;
    let stalled = false;
    const report = (): EventStepReport => ({ events, stage, elapsedMs: this.now() - started });

    const running = Promise.resolve()
      .then(() =>
        work((name) => {
          stage = name;
        }),
      )
      .catch((error) => {
        try {
          this.options.onError(error, report());
        } catch {
          // Logging must never break the queue.
        }
      })
      .finally(() => {
        if (stalled) this.options.onLateSettle?.(report());
      });

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        stalled = true;
        this.options.onStall(report());
        resolve();
      }, this.options.stallMs);
      (timer as { unref?: () => void }).unref?.();
      running.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
