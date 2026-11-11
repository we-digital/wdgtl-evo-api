import { createHash } from 'node:crypto';

// Relink for `already_present` ledger rows: Chatwoot holds the message, but the
// delivery path could not prove byte-equal content (a later media-unavailable
// placeholder, a re-rendered caption, an older importer stamp), so the native
// rows never got their Chatwoot pointer. Quotes, edits and reactions on those
// messages then have nothing to target.
//
// Identity is proven from structure only: the one Chatwoot message in the
// row's inbox with this WhatsApp key (WAID:<id> or bare), public, same
// direction, in the conversation bound to the same WhatsApp peer, and either
//   - created within RELINK_TIME_TOLERANCE_S of the WhatsApp timestamp with an
//     attachment exactly when the native message carries media, or
//   - a media-unavailable placeholder: native media, no attachment, content
//     ending with the placeholder label, created after the WhatsApp message.
// Apply writes only the native pointers (CAS on rows still unlinked). No
// Chatwoot write, no message, no notification.

export const RELINK_TIME_TOLERANCE_S = 10;
const PLACEHOLDER_SUFFIX = 'file no longer available]';
const MEDIA_TYPES = new Set([
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'documentWithCaptionMessage',
  'stickerMessage',
  'ptvMessage',
  'associatedChildMessage',
]);
const NON_CONTENT = new Set(['reactionMessage', 'protocolMessage']);

export type RelinkPrediction =
  | 'relink'
  | 'relink_placeholder'
  | 'already_linked'
  | 'native_missing'
  | 'destination_missing'
  | 'destination_ambiguous'
  | 'destination_taken'
  | 'mismatch_private'
  | 'mismatch_direction'
  | 'mismatch_peer'
  | 'mismatch_time'
  | 'mismatch_attachment';

export interface RelinkLedgerRow {
  id: string;
  instanceId: string;
  instanceName: string;
  inboxId: number | null;
  accountId: number;
  peer: string;
  fromMe: boolean;
  sourceId: string;
  lastErrorClass: string | null;
}
export interface RelinkNativeRow {
  id: string;
  key: any;
  messageType: string;
  messageTimestamp: number;
  chatwootMessageId: number | null;
}
export interface RelinkDestination {
  id: number;
  messageType: number;
  private: boolean;
  createdAt: number;
  peer: string | null;
  displayId: number;
  contactInboxSourceId: string | null;
  attachments: number;
  placeholder: boolean;
}
export interface RelinkReader {
  rows(filter: RelinkFilter): Promise<RelinkLedgerRow[]>;
  natives(instanceId: string, keyId: string): Promise<RelinkNativeRow[]>;
  destinations(accountId: number, inboxId: number, keyId: string): Promise<RelinkDestination[]>;
  destinationTaken(instanceId: string, inboxId: number, messageId: number): Promise<boolean>;
}
export interface RelinkWriter {
  link(instanceId: string, nativeIds: string[], destination: RelinkDestination, inboxId: number): Promise<number>;
}
export interface RelinkFilter {
  instanceNames?: string[];
  excludeInstanceNames?: string[];
  errorClasses?: string[];
}
export interface RelinkCandidate {
  row: RelinkLedgerRow;
  prediction: RelinkPrediction;
  nativeIds: string[];
  destination?: RelinkDestination;
}

export function predictRelink(
  row: RelinkLedgerRow,
  natives: RelinkNativeRow[],
  destinations: RelinkDestination[],
  taken: boolean,
): RelinkPrediction {
  const exact = natives.filter((n) => n.key?.remoteJid === row.peer && n.key?.fromMe === row.fromMe);
  const content = exact.filter((n) => !NON_CONTENT.has(n.messageType));
  if (!content.length) return 'native_missing';
  if (exact.some((n) => n.chatwootMessageId !== null)) return 'already_linked';
  if (!destinations.length) return 'destination_missing';
  if (destinations.length > 1) return 'destination_ambiguous';
  const [d] = destinations;
  if (taken) return 'destination_taken';
  if (d.private) return 'mismatch_private';
  if (d.messageType !== (row.fromMe ? 1 : 0)) return 'mismatch_direction';
  const peers = new Set(content.flatMap((n) => [n.key?.remoteJid, n.key?.remoteJidAlt]).filter(Boolean));
  if (!d.peer || !peers.has(d.peer)) return 'mismatch_peer';
  const media = content.some((n) => MEDIA_TYPES.has(n.messageType));
  const sent = Math.min(...content.map((n) => Number(n.messageTimestamp)));
  if (media && d.attachments === 0 && d.placeholder && d.createdAt >= sent - RELINK_TIME_TOLERANCE_S)
    return 'relink_placeholder';
  if (Math.abs(d.createdAt - sent) > RELINK_TIME_TOLERANCE_S) return 'mismatch_time';
  if (media ? d.attachments < 1 : d.attachments !== 0) return 'mismatch_attachment';
  return 'relink';
}

const linkable = new Set<RelinkPrediction>(['relink', 'relink_placeholder']);

export async function planRelink(reader: RelinkReader, filter: RelinkFilter) {
  const candidates: RelinkCandidate[] = [];
  for (const row of await reader.rows(filter)) {
    const keyId = row.sourceId.slice(5);
    const natives = await reader.natives(row.instanceId, keyId);
    const exact = natives.filter((n) => n.key?.remoteJid === row.peer && n.key?.fromMe === row.fromMe);
    if (!row.inboxId) {
      candidates.push({ row, prediction: 'destination_missing', nativeIds: [] });
      continue;
    }
    const destinations = await reader.destinations(row.accountId, row.inboxId, keyId);
    const taken =
      destinations.length === 1 && (await reader.destinationTaken(row.instanceId, row.inboxId, destinations[0].id));
    const prediction = predictRelink(row, natives, destinations, taken);
    candidates.push({
      row,
      prediction,
      nativeIds: exact.map((n) => n.id).sort(),
      destination: linkable.has(prediction) ? destinations[0] : undefined,
    });
  }
  const selected = candidates.filter((c) => linkable.has(c.prediction));
  const planHash = createHash('sha256')
    .update(JSON.stringify(selected.map((c) => [c.row.id, c.nativeIds, c.destination!.id, c.destination!.displayId])))
    .digest('hex');
  return { candidates, selected, planHash };
}

const mask = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);

// Aggregates only: no ids, peers, names or text.
export function relinkReport(plan: Awaited<ReturnType<typeof planRelink>>, now: Date) {
  const count = (key: (c: RelinkCandidate) => string) => {
    const counts: Record<string, number> = {};
    for (const c of plan.candidates) counts[key(c)] = (counts[key(c)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
  };
  return {
    generatedAt: now.toISOString(),
    rows: plan.candidates.length,
    toRelink: plan.selected.length,
    byPrediction: count((c) => c.prediction),
    byErrorAndPrediction: count((c) => `${c.row.lastErrorClass ?? '-'}|${c.prediction}`),
    byInstance: count((c) => `${mask(c.row.instanceName)}|${c.prediction}`),
    planHash: plan.planHash,
  };
}

export async function applyRelink(plan: Awaited<ReturnType<typeof planRelink>>, writer: RelinkWriter) {
  let linked = 0,
    skipped = 0;
  for (const c of plan.selected) {
    try {
      const n = await writer.link(c.row.instanceId, c.nativeIds, c.destination!, c.row.inboxId!);
      if (n === c.nativeIds.length) linked++;
      else skipped++;
    } catch {
      skipped++; // a copy changed or got linked since the plan; the next dry run shows it
    }
  }
  return { linked, skipped };
}

export function prismaRelinkReader(prisma: any, chatwoot: { query: (sql: string, args: any[]) => Promise<any> }) {
  const reader: RelinkReader = {
    rows: (filter) =>
      prisma.chatwootInboundDelivery.findMany({
        where: {
          state: 'already_present',
          ...(filter.instanceNames?.length || filter.excludeInstanceNames?.length
            ? {
                instanceName: {
                  ...(filter.instanceNames?.length ? { in: filter.instanceNames } : {}),
                  ...(filter.excludeInstanceNames?.length ? { notIn: filter.excludeInstanceNames } : {}),
                },
              }
            : {}),
          ...(filter.errorClasses?.length ? { lastErrorClass: { in: filter.errorClasses } } : {}),
        },
        select: {
          id: true,
          instanceId: true,
          instanceName: true,
          inboxId: true,
          accountId: true,
          peer: true,
          fromMe: true,
          sourceId: true,
          lastErrorClass: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 50_000,
      }),
    natives: (instanceId, keyId) =>
      prisma.$queryRawUnsafe(
        `SELECT id, key, "messageType", "messageTimestamp", "chatwootMessageId"
           FROM "Message" WHERE "instanceId" = $1 AND key->>'id' = $2 LIMIT 6`,
        instanceId,
        keyId,
      ),
    destinations: async (accountId, inboxId, keyId) =>
      (
        await chatwoot.query(
          `SELECT m.id, m.message_type, m.private, extract(epoch from m.created_at)::bigint AS created_at,
                  pc.peer, c.display_id, ci.source_id AS contact_inbox_source_id,
                  (SELECT count(*) FROM attachments a WHERE a.message_id = m.id)::int AS attachments,
                  right(coalesce(m.content, ''), $4) = $5 AS placeholder
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id AND c.account_id = m.account_id AND c.inbox_id = m.inbox_id
             LEFT JOIN provider_conversation_bindings pc
               ON pc.conversation_id = c.id AND pc.account_id = c.account_id AND pc.inbox_id = c.inbox_id AND pc.provider = 'whatsapp'
             LEFT JOIN contact_inboxes ci ON ci.id = c.contact_inbox_id
            WHERE m.account_id = $1 AND m.inbox_id = $2 AND m.source_id = ANY($3::text[])
            LIMIT 3`,
          [accountId, inboxId, ['WAID:' + keyId, keyId], PLACEHOLDER_SUFFIX.length, PLACEHOLDER_SUFFIX],
        )
      ).rows.map((r: any) => ({
        id: Number(r.id),
        messageType: Number(r.message_type),
        private: r.private === true,
        createdAt: Number(r.created_at),
        peer: r.peer ?? null,
        displayId: Number(r.display_id),
        contactInboxSourceId: r.contact_inbox_source_id ?? null,
        attachments: Number(r.attachments),
        placeholder: r.placeholder === true,
      })),
    destinationTaken: async (instanceId, inboxId, messageId) =>
      (await prisma.message.count({ where: { instanceId, chatwootInboxId: inboxId, chatwootMessageId: messageId } })) >
      0,
  };
  return reader;
}

export function prismaRelinkWriter(prisma: any): RelinkWriter {
  return {
    // One transaction per key; every copy must still be unlinked, or nothing is written.
    link: (instanceId, nativeIds, destination, inboxId) =>
      prisma.$transaction(async (tx: any) => {
        const updated = await tx.message.updateMany({
          where: { id: { in: nativeIds }, instanceId, chatwootMessageId: null, chatwootInboxId: null },
          data: {
            chatwootMessageId: destination.id,
            chatwootInboxId: inboxId,
            chatwootConversationId: destination.displayId,
            chatwootContactInboxSourceId: destination.contactInboxSourceId,
          },
        });
        if (updated.count !== nativeIds.length) throw new Error('RelinkNativeChanged');
        return updated.count;
      }),
  };
}
