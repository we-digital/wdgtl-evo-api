import { createHash } from 'node:crypto';

import { Message, Prisma } from '@prisma/client';

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

// Keep native donor rows stable until the dependent Chatwoot mutation commits.
// Read/verify one page at a time; only database row locks span the write.
export async function withLockedHistoryDependencies<T>(
  repository: {
    $transaction: (work: (transaction: Prisma.TransactionClient) => Promise<T>, options: any) => Promise<T>;
  },
  instanceName: string,
  ids: string[],
  verify: (rows: Message[]) => Promise<void>,
  write: () => Promise<T>,
): Promise<T> {
  const unique = [...new Set(ids)].sort();
  return repository.$transaction(
    async (transaction) => {
      for (let offset = 0; offset < unique.length; offset += HISTORY_PAGE_SIZE) {
        const pageIds = unique.slice(offset, offset + HISTORY_PAGE_SIZE);
        const rows = await transaction.$queryRaw<Message[]>(Prisma.sql`
        SELECT m.* FROM "Message" m JOIN "Instance" i ON i.id=m."instanceId"
        WHERE i.name=${instanceName} AND m.id IN (${Prisma.join(pageIds)})
        ORDER BY m.id FOR SHARE OF m`);
        if (rows.length !== pageIds.length || rows.some((row) => !pageIds.includes(row.id)))
          throw new Error('Stored history dependency is missing or changed; refresh before retry');
        await verify(rows);
      }
      return write();
    },
    { maxWait: 5000, timeout: 30000 },
  );
}
