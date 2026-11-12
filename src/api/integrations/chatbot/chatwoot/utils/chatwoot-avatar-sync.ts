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

/**
 * Lanes, highest priority first: a dialog someone opened in Chatwoot, WhatsApp
 * activity and picture events, a conversation list someone loaded, backfill.
 */
export type AvatarLane = 'open' | 'live' | 'list' | 'backfill';
export const AVATAR_LANES: readonly AvatarLane[] = ['open', 'live', 'list', 'backfill'];

export type AvatarSyncJob = {
  jid: string;
  lane: AvatarLane;
  /** Picture changed or removed on WhatsApp: ignore markers and caches. */
  force?: boolean;
  /** Known Chatwoot contact; resolved by jid when absent. */
  contactId?: number;
  /** Whether the Chatwoot contact already shows an avatar, when known. */
  hasAvatar?: boolean;
  /**
   * Chatwoot asked because someone looks at this contact and it shows no avatar:
   * a fresh marker with a picture id does not skip it (the picture never landed).
   */
  viewed?: boolean;
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
  maxOpen: number;
  maxList: number;
  /** Opened dialogs may skip the pacing gap: at most this many in a row ... */
  expressBurst: number;
  /** ... refilled at this many per minute, on top of perMinute. */
  expressPerMinute: number;
  /** Minimum gap between two WhatsApp queries, even for express ones. */
  expressGapMs: number;
  /** An opened dialog asks again about a hidden picture after this long. */
  openNoneRecheckMs: number;
  /**
   * A contact Chatwoot does not have yet (the first message of a new
   * conversation races its creation) is looked up again after this long.
   */
  noContactRetryMs: number;
  rateLimitPauseMs: number;
  /** Consecutive rate limits after which the backfill lane is dropped. */
  maxRateLimitStrikes: number;
};

export const DEFAULT_AVATAR_SYNC_OPTIONS: AvatarSyncOptions = {
  perMinute: 12,
  refreshMs: 7 * 24 * 60 * 60 * 1000,
  maxLive: 2_000,
  maxBackfill: 20_000,
  maxOpen: 200,
  maxList: 2_000,
  expressBurst: 3,
  expressPerMinute: 6,
  expressGapMs: 1_000,
  openNoneRecheckMs: 24 * 60 * 60 * 1000,
  noContactRetryMs: 2 * 60 * 1000,
  rateLimitPauseMs: 15 * 60 * 1000,
  maxRateLimitStrikes: 3,
};

export type AvatarSyncStats = {
  queuedOpen: number;
  queuedLive: number;
  queuedList: number;
  queuedBackfill: number;
  /** Jobs that waited for a slot and gave way to an opened dialog. */
  preempted: number;
  expressFetches: number;
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
  private readonly lanes: Record<AvatarLane, AvatarSyncJob[]> = { open: [], live: [], list: [], backfill: [] };
  private expressTokens: number;
  private expressRefilledAt = 0;
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
    queuedOpen: 0,
    queuedLive: 0,
    queuedList: 0,
    queuedBackfill: 0,
    preempted: 0,
    expressFetches: 0,
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
    this.expressTokens = this.options.expressBurst;
  }

  private laneMax(lane: AvatarLane) {
    return {
      open: this.options.maxOpen,
      live: this.options.maxLive,
      list: this.options.maxList,
      backfill: this.options.maxBackfill,
    }[lane];
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
    if (this.stopped || !isSyncableAvatarJid(job.jid) || !AVATAR_LANES.includes(job.lane)) return false;
    const existing = this.pending.get(job.jid);
    if (existing) {
      // Merge, and move up when the new request has a higher priority.
      existing.force = existing.force || job.force;
      existing.viewed = existing.viewed || job.viewed;
      existing.contactId = existing.contactId ?? job.contactId;
      existing.hasAvatar = existing.hasAvatar ?? job.hasAvatar;
      if (AVATAR_LANES.indexOf(job.lane) < AVATAR_LANES.indexOf(existing.lane)) {
        const from = this.lanes[existing.lane];
        const index = from.indexOf(existing);
        if (index >= 0) from.splice(index, 1);
        existing.lane = job.lane;
        this.lanes[job.lane].push(existing);
      }
      this.syncCounts();
      return true;
    }
    // Viewed contacts are judged by their marker in the worker; activity is not.
    if (!job.force && !job.viewed) {
      const checkedUntil = this.recentlyChecked.get(job.jid);
      if (checkedUntil && checkedUntil > this.now()) return false;
    }
    const lane = this.lanes[job.lane];
    if (lane.length >= this.laneMax(job.lane)) {
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
    for (const lane of AVATAR_LANES) this.lanes[lane].length = 0;
    this.pending.clear();
    this.syncCounts();
  }

  /** Resolves when both lanes are empty (tests and the backfill report). */
  async idle(): Promise<void> {
    while (this.running) await new Promise((resolve) => setImmediate(resolve));
  }

  private syncCounts() {
    this.stats.queuedOpen = this.lanes.open.length;
    this.stats.queuedLive = this.lanes.live.length;
    this.stats.queuedList = this.lanes.list.length;
    this.stats.queuedBackfill = this.lanes.backfill.length;
  }

  private queuedTotal() {
    return AVATAR_LANES.reduce((sum, lane) => sum + this.lanes[lane].length, 0);
  }

  private kick() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.stats.startedAt ??= this.now();
    void this.drain().finally(() => {
      this.running = false;
      if (!this.stopped && this.queuedTotal()) this.kick();
    });
  }

  private next(): AvatarSyncJob | undefined {
    let job: AvatarSyncJob | undefined;
    for (const lane of AVATAR_LANES) if ((job = this.lanes[lane].shift())) break;
    if (job) this.pending.delete(job.jid);
    this.syncCounts();
    return job;
  }

  private async drain() {
    for (let job = this.next(); job; job = this.next()) {
      try {
        if ((await this.process(job)) === 'requeued') continue;
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

  private remember(jid: string, checkedAt: number, forMs = this.options.refreshMs) {
    if (this.recentlyChecked.size > 50_000) this.recentlyChecked.clear();
    this.recentlyChecked.set(jid, checkedAt + forMs);
  }

  private refillExpress() {
    const now = this.now();
    const every = 60_000 / this.options.expressPerMinute;
    if (!this.expressRefilledAt) this.expressRefilledAt = now;
    const earned = Math.floor((now - this.expressRefilledAt) / every);
    if (earned > 0) {
      this.expressTokens = Math.min(this.options.expressBurst, this.expressTokens + earned);
      this.expressRefilledAt += earned * every;
    }
  }

  /**
   * Waits for the next WhatsApp query slot. An opened dialog may use an express
   * token (short gap). Any other job gives way when an opened dialog arrives
   * meanwhile: returns false and the caller puts it back.
   */
  private async waitForSlot(job: AvatarSyncJob): Promise<boolean> {
    const pausedUntil = this.stats.pausedUntil;
    if (pausedUntil && pausedUntil > this.now()) await this.sleep(pausedUntil - this.now());
    this.stats.pausedUntil = null;
    let gap = 60_000 / this.options.perMinute;
    if (job.lane === 'open') {
      this.refillExpress();
      if (this.expressTokens >= 1) {
        this.expressTokens--;
        this.stats.expressFetches++;
        gap = Math.min(gap, this.options.expressGapMs);
      }
    }
    for (let wait = this.lastFetchAt + gap - this.now(); wait > 0; wait = this.lastFetchAt + gap - this.now()) {
      if (job.lane !== 'open' && this.lanes.open.length) return false;
      await this.sleep(Math.min(wait, 250));
    }
    return !(job.lane !== 'open' && this.lanes.open.length);
  }

  private async process(job: AvatarSyncJob): Promise<'requeued' | void> {
    const previous = await this.deps.readMarker(job.jid);
    const now = this.now();
    if (!job.force && markerIsFresh(previous, now, this.options.refreshMs)) {
      // A viewed contact without an avatar whose picture we did see: re-apply it.
      // A hidden picture: an opened dialog asks WhatsApp again after a day.
      const reapply = job.viewed && job.hasAvatar === false && !!previous.pictureId;
      const recheckHidden =
        job.lane === 'open' && !previous.pictureId && now - previous.checkedAt > this.options.openNoneRecheckMs;
      if (!reapply && !recheckHidden) {
        this.stats.fresh++;
        if (!job.viewed) this.remember(job.jid, previous.checkedAt);
        return;
      }
    }

    if (!job.contactId && this.deps.resolveTarget) {
      const target = await this.deps.resolveTarget(job.jid);
      if (!target || 'missing' in target) {
        this.stats.noContact++;
        const reason = (target as { missing?: string } | null)?.missing ?? 'not-found';
        this.stats.noContactReasons[reason] = (this.stats.noContactReasons[reason] ?? 0) + 1;
        this.remember(job.jid, now, this.options.noContactRetryMs);
        return;
      }
      const found = target as { contactId: number; hasAvatar: boolean };
      job.contactId = found.contactId;
      job.hasAvatar ??= found.hasAvatar;
    }

    let picture: AvatarPicture | null = job.force ? null : await this.deps.peekPicture(job.jid);
    if (picture?.kind === 'picture') this.stats.reusedUrls++;
    if (!picture) {
      if (!(await this.waitForSlot(job))) {
        // An opened dialog goes first; this job keeps its place at the head of its lane.
        this.stats.preempted++;
        this.lanes[job.lane].unshift(job);
        this.pending.set(job.jid, job);
        this.syncCounts();
        return 'requeued';
      }
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
        for (const lane of ['list', 'backfill'] as const) {
          this.stats.backfillDropped += this.lanes[lane].length;
          for (const dropped of this.lanes[lane]) this.pending.delete(dropped.jid);
          this.lanes[lane].length = 0;
        }
        this.syncCounts();
      }
      // Try once more after the pause, at the head of its lane.
      const keep = job.lane === 'open' || job.lane === 'live';
      if (keep || this.strikes < this.options.maxRateLimitStrikes) {
        this.lanes[job.lane].unshift(job);
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
