import { withCanonicalChatwootMessageBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-canonical-message-binding';
import {
  acknowledgedMultipartSourceIds,
  ChatwootProviderDeliveryPart,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';
import {
  buildStoredLidMap,
  toCanonicalHistoryJid,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
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

export function historyBindingSourceMatches(current: Message, expected: Message, checkTimestamp = true): boolean {
  return (
    current.instanceId === expected.instanceId &&
    (!checkTimestamp || current.messageTimestamp === expected.messageTimestamp) &&
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
  unselectedNativeRows: number;
  boundRows: number;
}> {
  const peers = historyBindingPeers(source);
  const key = source.key as { id: string; fromMe: boolean; remoteJid: string };
  // An absent alternative may be recovered only from exact same-instance native
  // key pairs. Keep the source key untouched and fence the evidence under lock.
  const readAliasEvidence = (reader: PrismaClient | Prisma.TransactionClient, locked: boolean) =>
    reader.$queryRaw<Array<Pick<Message, 'id' | 'instanceId' | 'key' | 'messageTimestamp'>>>(Prisma.sql`
      SELECT id,"instanceId",key,"messageTimestamp" FROM "Message"
      WHERE "instanceId"=${source.instanceId} AND key->>'remoteJid'=${key.remoteJid}
        AND key->>'remoteJidAlt' ~ '^[0-9]+(:[0-9]+)?@s[.]whatsapp[.]net$'
      ORDER BY id LIMIT 65 ${locked ? Prisma.sql`FOR SHARE` : Prisma.empty}`);
  let aliasEvidence: Array<Pick<Message, 'id' | 'instanceId' | 'key' | 'messageTimestamp'>> | undefined;
  if (key.remoteJid.endsWith('@lid') && peers.length === 1 && typeof prisma.$queryRaw === 'function') {
    const evidence = await readAliasEvidence(prisma, false);
    if (
      evidence.some(
        (row) =>
          row.instanceId !== source.instanceId ||
          (row.key as any).remoteJid !== key.remoteJid ||
          !(row.key as any).id ||
          typeof (row.key as any).fromMe !== 'boolean',
      )
    )
      throw new Error('History mapping native peer evidence is invalid');
    const phones = new Set(evidence.map((row) => toCanonicalHistoryJid((row.key as any).remoteJidAlt)));
    if (evidence.length > 64 || phones.size > 1) throw new Error('History mapping native peer evidence is ambiguous');
    if (evidence.length) {
      const phone = buildStoredLidMap(evidence).get(key.remoteJid);
      if (!phone || !phones.has(toCanonicalHistoryJid(phone)))
        throw new Error('History mapping native peer evidence is missing');
      peers.push(toCanonicalHistoryJid(phone));
      aliasEvidence = evidence;
    }
  }
  const aliases = await pool.query(
    'SELECT id FROM messages WHERE account_id=$1 AND inbox_id=$2 AND source_id=ANY($3::text[])',
    [accountId, inboxId, [key.id, `WAID:${key.id}`]],
  );
  let messageId = Number(aliases.rows[0]?.id);
  let acknowledgedParts: ChatwootProviderDeliveryPart[] | undefined;
  // A multipart operator send owns one Chatwoot message. Its second provider
  // ID is an acknowledgement alias, not a second Chatwoot source_id.
  if (
    aliases.rows.length === 0 &&
    key.fromMe &&
    Number.isSafeInteger(source.chatwootMessageId) &&
    source.chatwootMessageId > 0
  ) {
    const result = await pool.query(
      'SELECT source_id,additional_attributes,private,message_type FROM messages WHERE id=$1 AND account_id=$2 AND inbox_id=$3',
      [source.chatwootMessageId, accountId, inboxId],
    );
    const target = result.rows[0];
    const sources = acknowledgedMultipartSourceIds(target?.additional_attributes, target?.source_id);
    if (
      result.rows.length === 1 &&
      target.private === false &&
      target.message_type === 1 &&
      sources?.has(`WAID:${key.id}`)
    ) {
      const attributes =
        typeof target.additional_attributes === 'string'
          ? JSON.parse(target.additional_attributes)
          : target.additional_attributes;
      const delivery = attributes.we_digital_api_inbox_status.provider_delivery;
      acknowledgedParts = Object.entries(delivery.acknowledgements)
        .map(([partKey, part]: [string, any]) => ({
          partKey,
          partIndex: part.part_index,
          partCount: delivery.part_count,
          sourceId: part.source_id,
        }))
        .sort((a, b) => a.partIndex - b.partIndex);
      messageId = source.chatwootMessageId;
    }
  }
  if (aliases.rows.length !== 1 && !acknowledgedParts)
    throw new Error('History mapping destination source is missing or ambiguous');
  return withCanonicalChatwootMessageBinding(
    pool,
    {
      accountId,
      inboxId,
      messageId,
      whatsappMessageId: key.id,
      acknowledgedParts,
      history: {
        peers,
        direction: key.fromMe ? 'outgoing' : 'incoming',
        ...(aliasEvidence && source.chatwootContactInboxSourceId
          ? { danglingContactInboxSourceId: source.chatwootContactInboxSourceId }
          : {}),
      },
    },
    async (binding) =>
      prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Message[]>(Prisma.sql`
        SELECT * FROM "Message" WHERE "instanceId"=${source.instanceId} AND key->>'id'=${key.id}
          AND key->>'remoteJid'=${key.remoteJid} AND key->>'fromMe'=${String(key.fromMe)}
          ORDER BY id LIMIT 33 FOR UPDATE`);
          if (
            rows.length < 1 ||
            rows.length > 32 ||
            !rows.some((row) => row.id === source.id && historyBindingSourceMatches(row, source))
          )
            throw new Error('History mapping native source version or uniqueness changed');
          // Lock all same-key copies, but qualify writes only for the admitted critical
          // source and fully equivalent receives. Other envelopes remain untouched.
          const matched = rows.filter((row) => historyBindingSourceMatches(row, source, false));
          const pointers = {
            chatwootMessageId: messageId,
            chatwootInboxId: binding.inboxId,
            chatwootConversationId: binding.conversationId,
            chatwootContactInboxSourceId: binding.contactInboxSourceId,
          };
          if (aliasEvidence) {
            const currentEvidence = await readAliasEvidence(tx, true);
            if (!isDeepStrictEqual(currentEvidence, aliasEvidence))
              throw new Error('History mapping native peer evidence changed');
            const critical = matched.find((row) => row.id === source.id);
            if (!critical || Object.keys(pointers).some((field) => critical[field] !== source[field]))
              throw new Error('History mapping native pointer preimage changed');
          }
          const canRepairDangling = (row: Message, field: string) =>
            field === 'chatwootContactInboxSourceId' &&
            aliasEvidence &&
            binding.danglingContactInboxSourceId === row.chatwootContactInboxSourceId &&
            row.chatwootContactInboxSourceId === source.chatwootContactInboxSourceId &&
            row.chatwootMessageId === pointers.chatwootMessageId &&
            row.chatwootInboxId === pointers.chatwootInboxId &&
            row.chatwootConversationId === pointers.chatwootConversationId;
          if (
            matched.some((row) =>
              Object.entries(pointers).some(
                ([field, value]) => row[field] !== null && row[field] !== value && !canRepairDangling(row, field),
              ),
            )
          )
            throw new Error('History mapping refuses conflicting native pointers');
          const unbound = matched.filter(
            (row) => !Object.entries(pointers).every(([field, value]) => row[field] === value),
          );
          const existing = unbound.length === 0;
          if (!existing && !dryRun) {
            const updated = await tx.message.updateMany({
              where: {
                id: { in: unbound.map((row) => row.id) },
                instanceId: source.instanceId,
                ...(binding.danglingContactInboxSourceId
                  ? {
                      OR: unbound.map((row) => ({
                        id: row.id,
                        chatwootMessageId: row.chatwootMessageId,
                        chatwootInboxId: row.chatwootInboxId,
                        chatwootConversationId: row.chatwootConversationId,
                        chatwootContactInboxSourceId: row.chatwootContactInboxSourceId,
                      })),
                    }
                  : {}),
              },
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
            nativeRows: matched.length,
            unselectedNativeRows: rows.length - matched.length,
            boundRows: !dryRun ? unbound.length : 0,
          };
        },
        { maxWait: 2000, timeout: 5000 },
      ),
  );
}
