import { Message, Prisma, PrismaClient } from '@prisma/client';
import { isDeepStrictEqual } from 'util';

export type NativeMessageKeyScope = { remoteJid?: unknown; fromMe?: unknown };

const POINTERS = [
  'chatwootMessageId',
  'chatwootInboxId',
  'chatwootConversationId',
  'chatwootContactInboxSourceId',
] as const;

function completePointers(row: Message): boolean {
  return (
    [row.chatwootMessageId, row.chatwootInboxId, row.chatwootConversationId].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) &&
    typeof row.chatwootContactInboxSourceId === 'string' &&
    row.chatwootContactInboxSourceId.length > 0
  );
}

// Only passive metadata observed on plain text receives may differ for this
// read-only preference. These copies are never qualified for native writes.
function passiveTextCopy(row: Message, bound: Message): boolean {
  if (row.messageType !== 'conversation' || bound.messageType !== 'conversation') return false;
  const key = { ...(row.key as Record<string, unknown>) };
  const expectedKey = { ...(bound.key as Record<string, unknown>) };
  for (const field of ['participant', 'addressingMode']) {
    if (key[field] !== undefined && expectedKey[field] !== undefined && key[field] !== expectedKey[field]) return false;
    if ([key[field], expectedKey[field]].some((value) => value !== undefined && (typeof value !== 'string' || !value)))
      return false;
    delete key[field];
    delete expectedKey[field];
  }
  if (!isDeepStrictEqual(key, expectedKey)) return false;
  const visibleText = (value: Message['message']) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const message = value as Record<string, unknown>;
    if (
      typeof message.conversation !== 'string' ||
      Object.keys(message).some((field) => !['conversation', 'messageContextInfo'].includes(field))
    )
      return null;
    const context = message.messageContextInfo;
    if (
      context !== undefined &&
      (!context ||
        typeof context !== 'object' ||
        Array.isArray(context) ||
        Object.keys(context).some((field) => !['threadId', 'messageSecret'].includes(field)))
    )
      return null;
    return message.conversation;
  };
  const text = visibleText(row.message);
  return text !== null && text === visibleText(bound.message);
}

// A key can be reused in another chat or direction. Fully equivalent receives
// may share a binding; differing copies can only prefer one already bound text.
export function selectUniqueNativeKeyMessage(rows: Message[]): Message | null {
  if (!rows.length || rows.length > 32) return null;
  const first = rows[0];
  const key = first.key as { id?: unknown; remoteJid?: unknown; fromMe?: unknown };
  if (!key?.id || typeof key.remoteJid !== 'string' || !key.remoteJid || typeof key.fromMe !== 'boolean') return null;
  if (
    !rows.every((row) => {
      const current = row.key as typeof key;
      return (
        row.instanceId === first.instanceId &&
        current?.id === key.id &&
        current.remoteJid === key.remoteJid &&
        current.fromMe === key.fromMe
      );
    })
  )
    return null;
  const equivalent = rows.every(
    (row) =>
      row.messageType === first.messageType &&
      isDeepStrictEqual(row.key, first.key) &&
      isDeepStrictEqual(row.message, first.message),
  );
  if (!equivalent) {
    const bound = rows.filter(completePointers);
    if (bound.length !== 1 || !rows.every((row) => row === bound[0] || passiveTextCopy(row, bound[0]))) return null;
    // A contradictory non-null copy is not safe for a future event either.
    if (rows.some((row) => POINTERS.some((field) => row[field] !== null && row[field] !== bound[0][field])))
      return null;
    return bound[0];
  }
  if (POINTERS.some((field) => new Set(rows.map((row) => row[field]).filter((value) => value !== null)).size > 1))
    return null;
  return rows.reduce((best, row) =>
    POINTERS.filter((field) => row[field] !== null).length > POINTERS.filter((field) => best[field] !== null).length
      ? row
      : best,
  );
}

export async function findNativeMessageByKey(
  prisma: PrismaClient,
  instanceId: string,
  keyId: string,
  scope?: NativeMessageKeyScope,
): Promise<Message | null> {
  if (
    !instanceId ||
    typeof keyId !== 'string' ||
    !keyId.length ||
    keyId.length > 256 ||
    (scope?.remoteJid !== undefined && (typeof scope.remoteJid !== 'string' || !scope.remoteJid.length)) ||
    (scope?.fromMe !== undefined && typeof scope.fromMe !== 'boolean')
  )
    return null;
  const rows = await prisma.$queryRaw<Message[]>(Prisma.sql`
    SELECT * FROM "Message" WHERE "instanceId"=${instanceId} AND key->>'id'=${keyId}
      ${scope?.remoteJid !== undefined ? Prisma.sql`AND key->>'remoteJid'=${scope.remoteJid}` : Prisma.empty}
      ${scope?.fromMe !== undefined ? Prisma.sql`AND key->>'fromMe'=${String(scope.fromMe)}` : Prisma.empty}
      ORDER BY id LIMIT 33`);
  return selectUniqueNativeKeyMessage(rows);
}
