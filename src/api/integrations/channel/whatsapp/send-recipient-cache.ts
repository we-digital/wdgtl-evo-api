/**
 * Short-lived, per-socket memo of positive send-recipient resolutions
 * (`whatsappNumber` for one number: contact/IsOnWhatsapp reads, a possible
 * USync `onWhatsApp` query, or group metadata plus profile picture for groups).
 *
 * Only resolutions that allow a send are kept. The owner clears it on every
 * connection change and drops an entry when a send to it fails, so a stale
 * entry can at worst repeat a failure the uncached path would also hit once.
 */
export const SEND_RECIPIENT_CACHE_TTL_MS = 5 * 60_000;
export const SEND_RECIPIENT_CACHE_MAX_ENTRIES = 5_000;

export class SendRecipientCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs = SEND_RECIPIENT_CACHE_TTL_MS,
    private readonly maxEntries = SEND_RECIPIENT_CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  public get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  public set(key: string, value: T) {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  public delete(key: string) {
    this.entries.delete(key);
  }

  public clear() {
    this.entries.clear();
  }

  public get size() {
    return this.entries.size;
  }

  /** Resolves through the cache; only results accepted by `cacheable` are stored. */
  public async resolve(key: string, load: () => Promise<T>, cacheable: (value: T) => boolean): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await load();
    if (value !== undefined && cacheable(value)) this.set(key, value);
    return value;
  }
}
