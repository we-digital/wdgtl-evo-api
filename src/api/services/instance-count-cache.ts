export type InstanceCounts = { Message: number; Contact: number; Chat: number };

type CountRow = { instanceId: string; _count: { _all: number } };
type GroupByDelegate = { groupBy: (args: any) => Promise<unknown> };
export type InstanceCountRepository = { message: GroupByDelegate; contact: GroupByDelegate; chat: GroupByDelegate };

type Entry = { counts: InstanceCounts; at: number };

/**
 * Per-instance history counts for `fetchInstances`, kept off the request path.
 *
 * Prisma's `_count` include counted every Message row of every instance on each
 * call (2.0M rows; 1.08 s mean, 72 s max on prod 11-17..11-25), although callers
 * poll the list for connection state. Counts are display-only, so:
 * - fresh (< freshMs): served from memory;
 * - stale (< maxStaleMs): served from memory, one background refresh;
 * - older or missing: counted now, once per id set (concurrent callers share it).
 * One refresh counts all requested ids with three grouped index scans.
 */
export class InstanceCountCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: () => InstanceCountRepository,
    private readonly freshMs = 5 * 60_000,
    private readonly maxStaleMs = 60 * 60_000,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  public async get(instanceIds: string[]): Promise<Map<string, InstanceCounts>> {
    const ids = [...new Set(instanceIds)].sort();
    const now = this.now();
    const missing: string[] = [];
    const stale: string[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      const age = entry ? now - entry.at : Infinity;
      if (age > this.maxStaleMs) missing.push(id);
      else if (age > this.freshMs) stale.push(id);
    }

    if (missing.length) await this.refresh(missing);
    if (stale.length) this.refresh(stale).catch(this.onError);

    const result = new Map<string, InstanceCounts>();
    for (const id of ids) result.set(id, this.entries.get(id)?.counts ?? { Message: 0, Contact: 0, Chat: 0 });
    return result;
  }

  private refresh(ids: string[]): Promise<void> {
    const flightKey = ids.join('\n');
    const running = this.inflight.get(flightKey);
    if (running) return running;
    const flight = this.count(ids).finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, flight);
    return flight;
  }

  private async count(ids: string[]) {
    const repository = this.repository();
    const query = (delegate: GroupByDelegate) =>
      delegate.groupBy({
        by: ['instanceId'],
        where: { instanceId: { in: ids } },
        _count: { _all: true },
      }) as Promise<CountRow[]>;
    const [messages, contacts, chats] = await Promise.all([
      query(repository.message),
      query(repository.contact),
      query(repository.chat),
    ]);
    const at = this.now();
    const byId = (rows: CountRow[]) => new Map(rows.map((row) => [row.instanceId, row._count._all]));
    const m = byId(messages);
    const c = byId(contacts);
    const h = byId(chats);
    for (const id of ids) {
      this.entries.set(id, { at, counts: { Message: m.get(id) ?? 0, Contact: c.get(id) ?? 0, Chat: h.get(id) ?? 0 } });
    }
  }
}
