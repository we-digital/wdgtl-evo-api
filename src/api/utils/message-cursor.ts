export const MESSAGE_CURSOR_CONTRACT_VERSION = '2026-08-12' as const;
export const MESSAGE_CURSOR_MAX_PAGE_SIZE = 500;

export interface MessageCursor {
  messageTimestamp: number;
  id: string;
}

export interface MessageCursorRecord {
  id: string;
  messageTimestamp: number;
}

export function createMessageCursorPage<T extends MessageCursorRecord>(records: T[], limit: number) {
  const hasMore = records.length > limit;
  const pageRecords = hasMore ? records.slice(0, limit) : records;
  const last = pageRecords[pageRecords.length - 1];

  return {
    contractVersion: MESSAGE_CURSOR_CONTRACT_VERSION,
    records: pageRecords,
    nextCursor:
      hasMore && last
        ? {
            messageTimestamp: last.messageTimestamp,
            id: last.id,
          }
        : null,
    hasMore,
  };
}
