import { createHash } from 'node:crypto';

import { Message, Prisma } from '@prisma/client';
import { Client } from 'pg';

export const HISTORY_PAGE_SIZE = 250;

export const historySourceFingerprint = (value: unknown): string => {
  const canonical = (item: any): any =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, canonical(item[key])]),
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
};

// Query only this incoming provider batch, not the whole instance history.
export const findStoredHistoryIds = async (
  repository: { findMany(args: Prisma.MessageFindManyArgs): Promise<Array<Pick<Message, 'id' | 'key'>>> },
  instanceId: string,
  ids: string[],
): Promise<Set<string>> => {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  const stored = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += HISTORY_PAGE_SIZE) {
    let after: string | undefined;
    for (;;) {
      const rows = await repository.findMany({
        where: {
          instanceId,
          ...(after ? { id: { gt: after } } : {}),
          OR: unique.slice(offset, offset + HISTORY_PAGE_SIZE).map((id) => ({ key: { path: ['id'], equals: id } })),
        },
        select: { id: true, key: true },
        orderBy: { id: 'asc' },
        take: HISTORY_PAGE_SIZE,
      });
      for (const row of rows) {
        const id = (row.key as { id?: string })?.id;
        if (id) stored.add(id);
      }
      if (rows.length < HISTORY_PAGE_SIZE) break;
      after = rows[rows.length - 1].id;
    }
  }
  return stored;
};

// Timestamp + ID keyset preserves equal-timestamp ordering. The upper boundary
// prevents a live stream extending a scan indefinitely. No payload-wide cache.
export async function* storedHistoryPages(
  repository: { findMany(args: Prisma.MessageFindManyArgs): Promise<Message[]> },
  where: Prisma.MessageWhereInput,
  select?: Prisma.MessageSelect,
): AsyncGenerator<Message[]> {
  const [upper] = await repository.findMany({
    where,
    orderBy: [{ messageTimestamp: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { id: true, messageTimestamp: true },
  });
  if (!upper) return;
  let after: Pick<Message, 'id' | 'messageTimestamp'> | undefined;
  while (true) {
    const page = await repository.findMany({
      ...(select ? { select: { ...select, id: true, messageTimestamp: true } } : {}),
      where: {
        AND: [
          where,
          {
            OR: [
              { messageTimestamp: { lt: upper.messageTimestamp } },
              { messageTimestamp: upper.messageTimestamp, id: { lte: upper.id } },
            ],
          },
          ...(after
            ? [
                {
                  OR: [
                    { messageTimestamp: { gt: after.messageTimestamp } },
                    { messageTimestamp: after.messageTimestamp, id: { gt: after.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ messageTimestamp: 'asc' }, { id: 'asc' }],
      take: HISTORY_PAGE_SIZE,
    });
    if (!page.length) return;
    const last = page[page.length - 1];
    after = { id: last.id, messageTimestamp: last.messageTimestamp };
    yield page;
    if (page.length < HISTORY_PAGE_SIZE) return;
  }
}

// A soft deadline stops further destination work; it never releases source
// locks underneath an outstanding independent database writer.
export async function withLockedHistoryDependencies<T>(
  connectionUri: string,
  instanceName: string,
  ids: string[],
  verify: (rows: Message[]) => Promise<void>,
  write: (signal: AbortSignal) => Promise<T>,
  options: { deadlineMs?: number; clientFactory?: (uri: string) => any } = {},
): Promise<T> {
  const client =
    options.clientFactory?.(connectionUri) ||
    new Client({
      connectionString: connectionUri,
      connectionTimeoutMillis: 5000,
      application_name: 'evo_history_source_guard',
      keepAlive: true,
    });
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Stored history source guard deadline or connection failure'));
  client.on?.('error', abort);
  let closing = false;
  client.on?.('end', () => {
    if (!closing) abort();
  });
  let timer: ReturnType<typeof setTimeout>;
  try {
    await client.connect();
    await client.query('BEGIN');
    // Only this owned read-guard session is non-expiring while its destination
    // callback settles. Statement/lock waits stay bounded; no global setting changes.
    await client.query(
      "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout=0",
    );
    timer = setTimeout(abort, options.deadlineMs ?? 30000);
    timer.unref?.();
    const unique = [...new Set(ids)].sort();
    for (let offset = 0; offset < unique.length; offset += HISTORY_PAGE_SIZE) {
      controller.signal.throwIfAborted();
      const pageIds = unique.slice(offset, offset + HISTORY_PAGE_SIZE);
      const result = await client.query(
        `SELECT m.* FROM "Message" m JOIN "Instance" i ON i.id=m."instanceId"
        WHERE i.name=$1 AND m.id=ANY($2::text[]) ORDER BY m.id FOR SHARE OF m`,
        [instanceName, pageIds],
      );
      if (result.rows.length !== pageIds.length || result.rows.some((row: Message) => !pageIds.includes(row.id)))
        throw new Error('Stored history dependency is missing or changed; refresh before retry');
      await verify(result.rows);
    }
    controller.signal.throwIfAborted();
    const result = await write(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    // write() must settle/clean all owned destination sessions first. A deadline
    // is cancellation admission, never an automatic source transaction expiry.
    closing = true;
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
}
