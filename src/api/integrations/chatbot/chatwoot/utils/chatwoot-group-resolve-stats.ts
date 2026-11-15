/**
 * Counters for the per-group single-flight in ChatwootService
 * (resolveProviderPeerConversation), which every inbound group message and
 * "Create group" go through. Process-wide: every channel builds its own
 * ChatwootService. Exposed on /metrics and as a periodic summary log line, so
 * group traffic can be watched after deploy even with METRICS off.
 */
export type GroupResolveSnapshot = {
  resolves: number;
  joins: number;
  errors: number;
  inFlight: number;
  durationMsSum: number;
  durationMsMax: number;
};

export class GroupResolveStats {
  private resolves = 0;
  private joins = 0;
  private errors = 0;
  private inFlight = 0;
  private durationMsSum = 0;
  private durationMsMax = 0;
  private lastSummaryAt: number;
  private lastSummary: GroupResolveSnapshot;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly summaryEveryMs = 5 * 60_000,
  ) {
    this.lastSummaryAt = this.now();
    this.lastSummary = this.snapshot();
  }

  /** A caller that runs the resolution itself; call the result once with its outcome. */
  begin(): (ok: boolean) => number {
    const started = this.now();
    this.inFlight++;
    let done = false;
    return (ok: boolean) => {
      const ms = this.now() - started;
      if (done) return ms;
      done = true;
      this.inFlight--;
      this.resolves++;
      if (!ok) this.errors++;
      this.durationMsSum += ms;
      this.durationMsMax = Math.max(this.durationMsMax, ms);
      return ms;
    };
  }

  /** A caller that waited on a resolution already in flight. */
  join() {
    this.joins++;
  }

  snapshot(): GroupResolveSnapshot {
    return {
      resolves: this.resolves,
      joins: this.joins,
      errors: this.errors,
      inFlight: this.inFlight,
      durationMsSum: this.durationMsSum,
      durationMsMax: this.durationMsMax,
    };
  }

  /** The counts since the last summary, at most every summaryEveryMs and only when something happened. */
  takeSummary(): (Omit<GroupResolveSnapshot, 'durationMsSum'> & { avgMs: number; windowMs: number }) | null {
    const at = this.now();
    if (at - this.lastSummaryAt < this.summaryEveryMs) return null;
    const current = this.snapshot();
    const previous = this.lastSummary;
    const resolves = current.resolves - previous.resolves;
    const joins = current.joins - previous.joins;
    const windowMs = at - this.lastSummaryAt;
    this.lastSummaryAt = at;
    this.lastSummary = current;
    // The window max: reset so each summary reports its own.
    const durationMsMax = this.durationMsMax;
    this.durationMsMax = 0;
    if (!resolves && !joins) return null;
    return {
      resolves,
      joins,
      errors: current.errors - previous.errors,
      inFlight: current.inFlight,
      avgMs: resolves ? Math.round((current.durationMsSum - previous.durationMsSum) / resolves) : 0,
      durationMsMax,
      windowMs,
    };
  }

  /** Prometheus text lines (counters since process start). */
  lines(): string[] {
    const s = this.snapshot();
    return [
      '# HELP evolution_chatwoot_group_resolves_total Group conversation resolutions run (single-flight leaders)',
      '# TYPE evolution_chatwoot_group_resolves_total counter',
      `evolution_chatwoot_group_resolves_total ${s.resolves}`,
      '# HELP evolution_chatwoot_group_resolve_joins_total Callers that joined a resolution already in flight',
      '# TYPE evolution_chatwoot_group_resolve_joins_total counter',
      `evolution_chatwoot_group_resolve_joins_total ${s.joins}`,
      '# HELP evolution_chatwoot_group_resolve_errors_total Group conversation resolutions that failed',
      '# TYPE evolution_chatwoot_group_resolve_errors_total counter',
      `evolution_chatwoot_group_resolve_errors_total ${s.errors}`,
      '# TYPE evolution_chatwoot_group_resolve_in_flight gauge',
      `evolution_chatwoot_group_resolve_in_flight ${s.inFlight}`,
      '# TYPE evolution_chatwoot_group_resolve_duration_seconds_sum counter',
      `evolution_chatwoot_group_resolve_duration_seconds_sum ${s.durationMsSum / 1000}`,
      '# TYPE evolution_chatwoot_group_resolve_duration_seconds_count counter',
      `evolution_chatwoot_group_resolve_duration_seconds_count ${s.resolves}`,
    ];
  }
}

export const groupResolveStats = new GroupResolveStats();
