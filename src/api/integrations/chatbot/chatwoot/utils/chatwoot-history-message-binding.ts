import { withCanonicalChatwootMessageBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-canonical-message-binding';
import { toCanonicalHistoryJid } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import { Message, Prisma, PrismaClient } from '@prisma/client';
import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'util';

export function historyBindingPeers(message: Message): string[] {
  const key = message.key as { id?: string; remoteJid?: string; remoteJidAlt?: string; fromMe?: boolean };
  if (
    !key.id ||
    typeof key.fromMe !== 'boolean' ||
    !/^[0-9:-]+@(g\.us|s\.whatsapp\.net|lid)$/.test(key.remoteJid || '')
  )
    throw new Error('History mapping native key is not qualified');
  // The native alternative is authoritative only for a LID source. Never infer a phone from a LID.
  return key.remoteJid.endsWith('@lid') && /^[0-9]+(?::[0-9]+)?@s\.whatsapp\.net$/.test(key.remoteJidAlt || '')
    ? [toCanonicalHistoryJid(key.remoteJid), toCanonicalHistoryJid(key.remoteJidAlt)]
    : [toCanonicalHistoryJid(key.remoteJid)];
}

export function historyBindingSourceMatches(current: Message, expected: Message): boolean {
  return (
    current.instanceId === expected.instanceId &&
    current.messageTimestamp === expected.messageTimestamp &&
    current.messageType === expected.messageType &&
    isDeepStrictEqual(current.key, expected.key) &&
    isDeepStrictEqual(current.message, expected.message)
  );
}

// No Chatwoot writes, provider requests or processing markers: only native pointers.
export async function reconcileHistoryMessageBinding(
  pool: Pool,
  prisma: PrismaClient,
  source: Message,
  accountId: number,
  inboxId: number,
  dryRun: boolean,
): Promise<{
  sourceId: string;
  status: 'bound' | 'existing' | 'would_bind';
  messageId: number;
  conversationId: number;
  nativeRows: number;
  boundRows: number;
}> {
  const peers = historyBindingPeers(source);
  const key = source.key as { id: string; fromMe: boolean };
  const aliases = await pool.query(
    'SELECT id FROM messages WHERE account_id=$1 AND inbox_id=$2 AND source_id=ANY($3::text[])',
    [accountId, inboxId, [key.id, `WAID:${key.id}`]],
  );
  if (aliases.rows.length !== 1) throw new Error('History mapping destination source is missing or ambiguous');
  const messageId = Number(aliases.rows[0].id);
  return withCanonicalChatwootMessageBinding(
    pool,
    {
      accountId,
      inboxId,
      messageId,
      whatsappMessageId: key.id,
      history: { peers, direction: key.fromMe ? 'outgoing' : 'incoming' },
    },
    async (binding) =>
      prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Message[]>(Prisma.sql`
        SELECT * FROM "Message" WHERE "instanceId"=${source.instanceId} AND key->>'id'=${key.id} ORDER BY id LIMIT 33 FOR UPDATE`);
          if (
            rows.length < 1 ||
            rows.length > 32 ||
            !rows.some((row) => row.id === source.id) ||
            !rows.every((row) => historyBindingSourceMatches(row, source))
          )
            throw new Error('History mapping native source version or uniqueness changed');
          const pointers = {
            chatwootMessageId: messageId,
            chatwootInboxId: binding.inboxId,
            chatwootConversationId: binding.conversationId,
            chatwootContactInboxSourceId: binding.contactInboxSourceId,
          };
          if (
            rows.some((row) =>
              Object.entries(pointers).some(([field, value]) => row[field] !== null && row[field] !== value),
            )
          )
            throw new Error('History mapping refuses conflicting native pointers');
          const unbound = rows.filter(
            (row) => !Object.entries(pointers).every(([field, value]) => row[field] === value),
          );
          const existing = unbound.length === 0;
          if (!existing && !dryRun) {
            const updated = await tx.message.updateMany({
              where: { id: { in: unbound.map((row) => row.id) }, instanceId: source.instanceId },
              data: pointers,
            });
            if (updated.count !== unbound.length)
              throw new Error('History mapping native pointer update cardinality changed');
          }
          return {
            sourceId: `WAID:${key.id}`,
            status: existing ? 'existing' : dryRun ? 'would_bind' : 'bound',
            messageId,
            conversationId: binding.conversationId,
            nativeRows: rows.length,
            boundRows: !dryRun ? unbound.length : 0,
          };
        },
        { maxWait: 2000, timeout: 5000 },
      ),
  );
}
