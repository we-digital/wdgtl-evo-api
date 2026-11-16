/**
 * Retention for ApiSentMessage (api-sent-messages.ts): an id only matters while its fromMe echo, a history sync or
 * a replay can still arrive, so rows older than API_SENT_MESSAGE_RETENTION_DAYS (default 30, 0 = off) are
 * deleted in small batches every 6 hours. The first run waits a jittered minute after start.
 */
export interface ApiSentMessageRetentionRepository {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETE_BATCH = `DELETE FROM "ApiSentMessage" WHERE ctid IN (
  SELECT ctid FROM "ApiSentMessage" WHERE "createdAt" < $1 LIMIT $2
)`;

export const apiSentMessageRetentionDays = (value = process.env.API_SENT_MESSAGE_RETENTION_DAYS): number => {
  if (value === undefined || value.trim() === '') return 30;
  const days = Number(value);
  return Number.isInteger(days) && days >= 0 ? days : 30;
};

export class ApiSentMessageRetention {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly repository: ApiSentMessageRetentionRepository,
    private readonly logger: Logger,
    private readonly days = apiSentMessageRetentionDays(),
    private readonly options = {
      intervalMs: 6 * 60 * 60 * 1000,
      firstDelayMs: 60_000 + Math.floor(Math.random() * 60_000),
      batch: 5_000,
      maxBatches: 200,
    },
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.days === 0 || this.timer) return;
    const schedule = (delay: number) => {
      this.timer = setTimeout(async () => {
        await this.runOnce();
        if (this.timer) schedule(this.options.intervalMs);
      }, delay);
      this.timer.unref?.();
    };
    schedule(this.options.firstDelayMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** Deletes expired rows; returns how many. Never throws. */
  runOnce(): Promise<number> {
    if (this.days === 0) return Promise.resolve(0);
    this.running = (async () => {
      const cutoff = new Date(this.now() - this.days * DAY_MS);
      let deleted = 0;
      try {
        for (let i = 0; i < this.options.maxBatches; i += 1) {
          const count = await this.repository.$executeRawUnsafe(DELETE_BATCH, cutoff, this.options.batch);
          deleted += count;
          if (count < this.options.batch) break;
        }
        if (deleted > 0)
          this.logger.info(JSON.stringify({ event: 'api_sent_message_retention', deleted, days: this.days }));
      } catch (error) {
        this.logger.warn(
          JSON.stringify({ event: 'api_sent_message_retention_failed', errorClass: error?.name ?? 'Error', deleted }),
        );
      }
      return deleted;
    })();
    return this.running;
  }
}
