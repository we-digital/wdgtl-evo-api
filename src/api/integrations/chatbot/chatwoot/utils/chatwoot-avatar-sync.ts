/**
 * Chatwoot avatar sync for WhatsApp contacts and groups.
 *
 * WhatsApp profile pictures are fetched off the message path, one instance at a
 * time, at a fixed pace (default 12 per minute per instance). Every check leaves
 * a marker (picture id or "none") so a contact is looked at again only after the
 * refresh window, unless WhatsApp tells us the picture changed. Chatwoot gets the
 * picture through `avatar_url`: its AvatarFromUrlJob downloads the file into its
 * own storage, so nothing hotlinks the expiring WhatsApp CDN URL.
 */

export type AvatarLane = 'live' | 'backfill';

export type AvatarSyncJob = {
  jid: string;
  lane: AvatarLane;
  /** Picture changed or removed on WhatsApp: ignore markers and caches. */
  force?: boolean;
  /** Known Chatwoot contact; resolved by jid when absent. */
  contactId?: number;
  /** Whether the Chatwoot contact already shows an avatar, when known. */
  hasAvatar?: boolean;
  reason: string;
};

export type AvatarPicture =
  | { kind: 'picture'; url: string; source: 'cache' | 'stored' | 'whatsapp' }
  | { kind: 'none'; source: 'cache' | 'whatsapp' }
  | { kind: 'rate-limited' }
  | { kind: 'error'; message: string };

export type AvatarMarker = { pictureId: string; checkedAt: number };

export type AvatarApplyResult = 'applied' | 'cleared' | 'unchanged' | 'no-contact';

export type AvatarSyncDeps = {
  /** Marker from the last check, or null. */
  readMarker(jid: string): Promise<AvatarMarker | null>;
  writeMarker(jid: string, marker: AvatarMarker): Promise<void>;
  /** Free lookup (cache, stored unexpired URL); null when WhatsApp must be asked. */
  peekPicture(jid: string): Promise<AvatarPicture | null>;
  /** One WhatsApp profile picture query. */
  fetchPicture(jid: string): Promise<AvatarPicture>;
  /** Pushes the result to Chatwoot. `url` null means WhatsApp shows no picture. */
  apply(job: AvatarSyncJob, url: string | null, previous: AvatarMarker | null): Promise<AvatarApplyResult>;
  /**
   * Chatwoot contact for a job without a known contactId, looked up before any
   * WhatsApp query; null = not in Chatwoot (no fetch, checked again after the window).
   */
  resolveTarget?(jid: string): Promise<{ contactId: number; hasAvatar: boolean } | { missing: string } | null>;
  log(event: string, fields: Record<string, unknown>): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type AvatarSyncOptions = {
  perMinute: number;
  refreshMs: number;
  maxLive: number;
  maxBackfill: number;
  rateLimitPauseMs: number;
  /** Consecutive rate limits after which the backfill lane is dropped. */
  maxRateLimitStrikes: number;
};

export const DEFAULT_AVATAR_SYNC_OPTIONS: AvatarSyncOptions = {
  perMinute: 12,
  refreshMs: 7 * 24 * 60 * 60 * 1000,
  maxLive: 2_000,
  maxBackfill: 20_000,
  rateLimitPauseMs: 15 * 60 * 1000,
  maxRateLimitStrikes: 3,
};

export type AvatarSyncStats = {
  queuedLive: number;
  queuedBackfill: number;
  processed: number;
  applied: number;
  cleared: number;
  unchanged: number;
  none: number;
  fresh: number;
  noContact: number;
  /** Why the Chatwoot contact lookup missed, e.g. not-found:@lid. */
  noContactReasons: Record<string, number>;
  whatsappFetches: number;
  reusedUrls: number;
  rateLimited: number;
  errors: number;
  droppedFull: number;
  backfillDropped: number;
  pausedUntil: number | null;
  startedAt: number | null;
  lastAt: number | null;
};

const PICTURE_ID_PATTERN = /\/([^/?#]+)(?:[?#]|$)/;

/** File name of a WhatsApp CDN picture URL; it changes when the picture changes. */
export const whatsappPictureId = (url: string | null | undefined): string => {
  if (!url) return '';
  try {
    const path = new URL(url).pathname;
    return path.split('/').filter(Boolean).pop() || '';
  } catch {
    return PICTURE_ID_PATTERN.exec(url)?.[1] || '';
  }
};

/** Expiry of a WhatsApp CDN URL (`oe` = hex unix seconds), in ms; null when unknown. */
export const whatsappUrlExpiresAt = (url: string | null | undefined): number | null => {
  if (!url) return null;
  try {
    const oe = new URL(url).searchParams.get('oe');
    if (!oe || !/^[0-9a-f]+$/i.test(oe)) return null;
    return Number.parseInt(oe, 16) * 1000;
  } catch {
    return null;
  }
};

/** A stored URL is reusable when it is valid for at least another `marginMs`. */
export const reusableWhatsappUrl = (url: string | null | undefined, now: number, marginMs = 2 * 60 * 60 * 1000) => {
  const expiresAt = whatsappUrlExpiresAt(url);
  return !!url && expiresAt !== null && expiresAt - now > marginMs;
};

/**
 * Baileys' profilePictureUrl throws a Boom error built from the IQ error node:
 * 404 item-not-found / 401 not-authorized mean "no visible picture", 429
 * rate-overlimit means slow down. Anything else (timeouts, closed socket) is a
 * transient error that does not leave a marker.
 */
export const classifyProfilePictureError = (error: any): 'none' | 'rate-limited' | 'error' => {
  const code = Number(error?.output?.statusCode ?? error?.data ?? error?.statusCode);
  const text = String(error?.message ?? '').toLowerCase();
  if (code === 429 || text.includes('rate-overlimit') || text.includes('rate overlimit')) return 'rate-limited';
  if ([401, 403, 404].includes(code) || text.includes('item-not-found') || text.includes('not-authorized'))
    return 'none';
  return 'error';
};

export const isSyncableAvatarJid = (jid: string | null | undefined): jid is string =>
  typeof jid === 'string' &&
  /^[^@\s]+@(s\.whatsapp\.net|lid|g\.us)$/.test(jid) &&
  !jid.startsWith('status@') &&
  !jid.startsWith('0@');

/** Chatwoot contact identifier/phone → WhatsApp jid, or null for non-WhatsApp contacts. */
export const chatwootContactJid = (identifier: string | null, phoneNumber: string | null): string | null => {
  if (isSyncableAvatarJid(identifier)) return identifier;
  const digits = (phoneNumber || '').replace(/[^0-9]/g, '');
  if (digits.length >= 6 && digits.length <= 15 && (phoneNumber || '').trim().startsWith('+'))
    return `${digits}@s.whatsapp.net`;
  return null;
};

/** Whether a marker means "checked recently enough". */
export const markerIsFresh = (marker: AvatarMarker | null, now: number, refreshMs: number) =>
  !!marker && now - marker.checkedAt < refreshMs;

/**
 * One queue per WhatsApp instance. Live jobs (conversation activity, picture
 * change events) go before backfill jobs. A single worker fetches at most
 * `perMinute` pictures per minute; markers and stored URLs are free.
 */
export class AvatarSyncQueue {
  private readonly live: AvatarSyncJob[] = [];
  private readonly backfill: AvatarSyncJob[] = [];
  private readonly pending = new Map<string, AvatarSyncJob>();
  /** In-memory copy of fresh markers so repeated activity costs no cache reads. */
  private readonly recentlyChecked = new Map<string, number>();
  private running = false;
  private stopped = false;
  private lastFetchAt = 0;
  private strikes = 0;
  private readonly options: AvatarSyncOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly stats: AvatarSyncStats = {
    queuedLive: 0,
    queuedBackfill: 0,
    processed: 0,
    applied: 0,
    cleared: 0,
    unchanged: 0,
    none: 0,
    fresh: 0,
    noContact: 0,
    noContactReasons: {},
    whatsappFetches: 0,
    reusedUrls: 0,
    rateLimited: 0,
    errors: 0,
    droppedFull: 0,
    backfillDropped: 0,
    pausedUntil: null,
    startedAt: null,
    lastAt: null,
  };

  constructor(
    readonly name: string,
    private readonly deps: AvatarSyncDeps,
    options: Partial<AvatarSyncOptions> = {},
  ) {
    this.options = { ...DEFAULT_AVATAR_SYNC_OPTIONS, ...options };
    this.options.perMinute = Math.max(1, Math.min(60, this.options.perMinute));
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get perMinute() {
    return this.options.perMinute;
  }

  /** Backfill runs may pick their own pace, capped at 60 per minute. */
  setPerMinute(perMinute: number) {
    if (Number.isFinite(perMinute) && perMinute > 0) this.options.perMinute = Math.max(1, Math.min(60, perMinute));
  }

  /** Synchronous and cheap: safe to call from the message path. */
  enqueue(job: AvatarSyncJob): boolean {
    if (this.stopped || !isSyncableAvatarJid(job.jid)) return false;
    const existing = this.pending.get(job.jid);
    if (existing) {
      // Upgrade in place: a forced or live request must not wait behind backfill.
      existing.force = existing.force || job.force;
      existing.contactId = existing.contactId ?? job.contactId;
      existing.hasAvatar = existing.hasAvatar ?? job.hasAvatar;
      if (existing.lane === 'backfill' && job.lane === 'live') {
        const index = this.backfill.indexOf(existing);
        if (index >= 0) this.backfill.splice(index, 1);
        existing.lane = 'live';
        this.live.push(existing);
      }
      this.syncCounts();
      return true;
    }
    if (!job.force) {
      const checkedUntil = this.recentlyChecked.get(job.jid);
      if (checkedUntil && checkedUntil > this.now()) return false;
    }
    const lane = job.lane === 'live' ? this.live : this.backfill;
    const max = job.lane === 'live' ? this.options.maxLive : this.options.maxBackfill;
    if (lane.length >= max) {
      this.stats.droppedFull++;
      return false;
    }
    const copy = { ...job };
    lane.push(copy);
    this.pending.set(job.jid, copy);
    this.syncCounts();
    this.kick();
    return true;
  }

  stop() {
    this.stopped = true;
    this.live.length = 0;
    this.backfill.length = 0;
    this.pending.clear();
    this.syncCounts();
  }

  /** Resolves when both lanes are empty (tests and the backfill report). */
  async idle(): Promise<void> {
    while (this.running) await new Promise((resolve) => setImmediate(resolve));
  }

  private syncCounts() {
    this.stats.queuedLive = this.live.length;
    this.stats.queuedBackfill = this.backfill.length;
  }

  private kick() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.stats.startedAt ??= this.now();
    void this.drain().finally(() => {
      this.running = false;
      if (!this.stopped && (this.live.length || this.backfill.length)) this.kick();
    });
  }

  private next(): AvatarSyncJob | undefined {
    const job = this.live.shift() ?? this.backfill.shift();
    if (job) this.pending.delete(job.jid);
    this.syncCounts();
    return job;
  }

  private async drain() {
    for (let job = this.next(); job; job = this.next()) {
      try {
        await this.process(job);
      } catch (error) {
        this.stats.errors++;
        this.deps.log('chatwoot_avatar_sync_error', { queue: this.name, jid: job.jid, error: String(error) });
      }
      this.stats.processed++;
      this.stats.lastAt = this.now();
      if (this.stats.processed % 50 === 0) this.deps.log('chatwoot_avatar_sync_progress', this.report());
      if (this.stopped) return;
    }
  }

  report() {
    return { queue: this.name, ...this.stats };
  }

  private remember(jid: string, checkedAt: number) {
    if (this.recentlyChecked.size > 50_000) this.recentlyChecked.clear();
    this.recentlyChecked.set(jid, checkedAt + this.options.refreshMs);
  }

  private async waitForSlot() {
    const pausedUntil = this.stats.pausedUntil;
    if (pausedUntil && pausedUntil > this.now()) await this.sleep(pausedUntil - this.now());
    this.stats.pausedUntil = null;
    const gap = 60_000 / this.options.perMinute;
    const wait = this.lastFetchAt + gap - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private async process(job: AvatarSyncJob) {
    const previous = await this.deps.readMarker(job.jid);
    const now = this.now();
    if (!job.force && markerIsFresh(previous, now, this.options.refreshMs)) {
      this.stats.fresh++;
      this.remember(job.jid, previous.checkedAt);
      return;
    }

    if (!job.contactId && this.deps.resolveTarget) {
      const target = await this.deps.resolveTarget(job.jid);
      if (!target || 'missing' in target) {
        this.stats.noContact++;
        const reason = (target as { missing?: string } | null)?.missing ?? 'not-found';
        this.stats.noContactReasons[reason] = (this.stats.noContactReasons[reason] ?? 0) + 1;
        this.remember(job.jid, now);
        return;
      }
      const found = target as { contactId: number; hasAvatar: boolean };
      job.contactId = found.contactId;
      job.hasAvatar ??= found.hasAvatar;
    }

    let picture: AvatarPicture | null = job.force ? null : await this.deps.peekPicture(job.jid);
    if (picture?.kind === 'picture') this.stats.reusedUrls++;
    if (!picture) {
      await this.waitForSlot();
      if (this.stopped) return;
      picture = await this.deps.fetchPicture(job.jid);
      this.lastFetchAt = this.now();
      this.stats.whatsappFetches++;
    }

    if (picture.kind === 'rate-limited') {
      this.stats.rateLimited++;
      this.strikes++;
      this.stats.pausedUntil = this.now() + this.options.rateLimitPauseMs;
      this.deps.log('chatwoot_avatar_sync_rate_limited', {
        queue: this.name,
        strikes: this.strikes,
        pauseMs: this.options.rateLimitPauseMs,
      });
      if (this.strikes >= this.options.maxRateLimitStrikes) {
        this.stats.backfillDropped += this.backfill.length;
        for (const dropped of this.backfill) this.pending.delete(dropped.jid);
        this.backfill.length = 0;
        this.syncCounts();
      }
      // Try once more after the pause, ahead of everything else.
      if (job.lane === 'live' || this.strikes < this.options.maxRateLimitStrikes) {
        this.live.unshift(job);
        this.pending.set(job.jid, job);
        this.syncCounts();
      }
      return;
    }
    if (picture.kind === 'error') {
      this.stats.errors++;
      return;
    }
    this.strikes = 0;

    const url = picture.kind === 'picture' ? picture.url : null;
    const result = await this.deps.apply(job, url, previous);
    if (url === null) this.stats.none++;
    if (result === 'applied') this.stats.applied++;
    if (result === 'cleared') this.stats.cleared++;
    if (result === 'unchanged') this.stats.unchanged++;
    if (result === 'no-contact') this.stats.noContact++;
    const checkedAt = this.now();
    await this.deps.writeMarker(job.jid, { pictureId: whatsappPictureId(url), checkedAt });
    this.remember(job.jid, checkedAt);
  }
}
