// Outbound attachment prefetch: the download of a staff attachment from
// Chatwoot starts when the send is admitted, so it overlaps the queue claim
// and validation instead of starting only when the transport worker prepares
// the WhatsApp upload. In memory, per process, bounded by entries, bytes and
// age; a miss or failure falls back to the normal download.
import axios from 'axios';

export type PrefetchedMedia = { data: Buffer; contentType?: string };

type Entry = { promise: Promise<PrefetchedMedia | null>; startedAt: number; bytes: number };

export const OUTBOUND_MEDIA_PREFETCH_TTL_MS = 120_000;
export const OUTBOUND_MEDIA_PREFETCH_MAX_ENTRIES = 32;
export const OUTBOUND_MEDIA_PREFETCH_MAX_BYTES = 128 * 1024 * 1024;
export const OUTBOUND_MEDIA_PREFETCH_MAX_FILE_BYTES = 64 * 1024 * 1024;

type Fetcher = (url: string) => Promise<PrefetchedMedia>;

const defaultFetcher: Fetcher = async (url) => {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    maxContentLength: OUTBOUND_MEDIA_PREFETCH_MAX_FILE_BYTES,
  });
  return { data: Buffer.from(response.data), contentType: response.headers?.['content-type'] };
};

export class OutboundMediaPrefetch {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(
    private readonly fetcher: Fetcher = defaultFetcher,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts a download unless one is already running or cached for this URL. */
  public start(url: string) {
    this.evictExpired();
    if (!url || this.entries.has(url)) return;
    while (this.entries.size >= OUTBOUND_MEDIA_PREFETCH_MAX_ENTRIES) this.evictOldest();
    const entry: Entry = { startedAt: this.now(), bytes: 0, promise: null as any };
    entry.promise = this.fetcher(url)
      .then((media) => {
        if (this.entries.get(url) !== entry) return media;
        entry.bytes = media.data.length;
        this.totalBytes += entry.bytes;
        while (this.totalBytes > OUTBOUND_MEDIA_PREFETCH_MAX_BYTES && this.entries.size > 0) this.evictOldest();
        return media;
      })
      .catch((): null => {
        this.drop(url, entry);
        return null;
      });
    this.entries.set(url, entry);
  }

  /** The prefetched bytes, without consuming them (the content-type check). */
  public peek(url: string): Promise<PrefetchedMedia | null> | undefined {
    this.evictExpired();
    return this.entries.get(url)?.promise;
  }

  /** The prefetched bytes, consumed (the actual download). */
  public take(url: string): Promise<PrefetchedMedia | null> | undefined {
    this.evictExpired();
    const entry = this.entries.get(url);
    if (!entry) return undefined;
    return entry.promise.finally(() => this.drop(url, entry));
  }

  public get size() {
    return this.entries.size;
  }

  public get bytes() {
    return this.totalBytes;
  }

  private drop(url: string, entry: Entry) {
    if (this.entries.get(url) !== entry) return;
    this.entries.delete(url);
    this.totalBytes -= entry.bytes;
  }

  private evictOldest() {
    const [url, entry] = this.entries.entries().next().value ?? [];
    if (url !== undefined) this.drop(url, entry);
  }

  private evictExpired() {
    const cutoff = this.now() - OUTBOUND_MEDIA_PREFETCH_TTL_MS;
    for (const [url, entry] of this.entries) if (entry.startedAt <= cutoff) this.drop(url, entry);
  }
}

export const outboundMediaPrefetch = new OutboundMediaPrefetch();

/** Only Chatwoot-hosted files are prefetched (no instance proxy applies to them). */
export function prefetchableChatwootUrl(url: unknown, chatwootBaseUrl: string | null | undefined): url is string {
  if (typeof url !== 'string' || !chatwootBaseUrl) return false;
  try {
    const target = new URL(url);
    return target.protocol === 'https:' && target.host === new URL(chatwootBaseUrl).host;
  } catch {
    return false;
  }
}
