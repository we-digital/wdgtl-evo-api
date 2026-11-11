import { createHash } from 'node:crypto';

import { classifyCachedHistoryRecord } from './chatwoot-cached-history-record';
import { ignoresHistoryPeer } from './chatwoot-history-ingress';
import { isBlankNativeCopy, isInboundTransportOnly, resolveInboundNativeBody } from './chatwoot-inbound-native-source';
import {
  INBOUND_UNSUPPORTED_SKIPPED,
  InboundDelivery,
  inboundDeliveryId,
  inboundPayloadHash,
  inboundProviderFingerprint,
} from './chatwoot-inbound-queue';
import { RECOVERY_MARKER, RECOVERY_UNSUPPORTED_TYPES } from './chatwoot-inbound-recovery';

// Native-store gaps: messages EVO stored that never got a ledger row, so the
// ledger recovery cannot see them (album photos dropped before #181, messages
// lost during restarts). The plan turns each into a history_pending ledger row.
// Delivery stays the history lane's job: the silent stored-history importer
// reads the Chatwoot owner first (no duplicate, it links an existing message),
// keeps the WhatsApp timestamp, and sends no notification or webhook.

export type NativeGapPrediction =
  | 'enqueue_history'
  | 'ignore_transport'
  | 'not_a_message'
  | 'ignored_peer'
  | 'chatwoot_outbound'
  | 'likely_unsupported'
  | 'blocked_ambiguous';

export interface NativeGapIndexRow {
  id: string;
  key: any;
  messageType: string;
  messageTimestamp: number;
  chatwootMessageId: number | null;
}
export interface NativeGapRow extends NativeGapIndexRow {
  message: any;
  contextInfo: any;
  participant: string | null;
  pushName: string | null;
  status: string | null;
}
export interface NativeGapRoute {
  instanceId: string;
  instanceName: string;
  groupsIgnore: boolean;
  provider: {
    id: string;
    instanceId: string;
    accountId: string | number;
    url: string;
    nameInbox: string | null;
    number: string | null;
    ignoreJids: unknown;
    enabled: boolean | null;
    importMessages: boolean | null;
  };
}
export interface NativeGapReader {
  routes(instanceNames?: string[], excludeInstanceNames?: string[]): Promise<NativeGapRoute[]>;
  // Light index of every native row in the window (no bodies).
  index(instanceId: string, sinceSeconds: number, untilSeconds: number): Promise<NativeGapIndexRow[]>;
  bodies(ids: string[]): Promise<NativeGapRow[]>;
  ledgerIds(ids: string[]): Promise<string[]>;
  chatwootOutboundIds(instanceId: string, whatsappIds: string[]): Promise<string[]>;
}
export interface NativeGapWriter {
  enqueue(items: InboundDelivery[]): Promise<number>;
}
export interface NativeGapCandidate {
  route: NativeGapRoute;
  identity: string;
  peer: string;
  fromMe: boolean;
  messageType: string;
  timestampMs: number;
  prediction: NativeGapPrediction;
  source?: NativeGapRow;
}
export interface NativeGapFilter {
  since: Date;
  until: Date;
  instanceNames?: string[];
  excludeInstanceNames?: string[];
  // Record likely_unsupported gaps as ignored ledger rows (terminal, never
  // delivered) so they stop showing up as gaps (owner decision 2026-11-11).
  skipUnsupported?: boolean;
}

const scopeIgnored = (jid: string) =>
  jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid.startsWith('status@');

function ledgerPayload(row: NativeGapRow): Record<string, any> {
  // Only the native source fields; the history lane re-reads the native row.
  return JSON.parse(
    JSON.stringify({
      key: row.key,
      pushName: row.pushName,
      participant: row.participant,
      messageType: row.messageType,
      message: row.message,
      contextInfo: row.contextInfo,
      messageTimestamp: row.messageTimestamp,
      ...(row.status === 'EDITED' ? { status: row.status } : {}),
    }),
  );
}

// The copy the history lane delivers when a key has several: a copy with real
// content before a blank stub, then the fullest body (an album child before the
// same photo stored plain), then the earliest. The resolver still has to prove
// every other copy is the same message.
export function nativeGapSource<T extends NativeGapRow>(rows: T[]): T | undefined {
  const real = rows.filter((row) => row.messageType !== 'reactionMessage' && !isInboundTransportOnly(row));
  const size = (row: T) => JSON.stringify(row.message ?? null).length;
  return [...real].sort(
    (a, b) =>
      Number(isBlankNativeCopy(a)) - Number(isBlankNativeCopy(b)) ||
      size(b) - size(a) ||
      a.messageTimestamp - b.messageTimestamp ||
      a.id.localeCompare(b.id),
  )[0];
}

export function predictNativeGap(rows: NativeGapRow[], route: NativeGapRoute): NativeGapPrediction {
  const key = rows[0].key;
  if (ignoresHistoryPeer(route.provider, rows[0], route.groupsIgnore) || scopeIgnored(key.remoteJid))
    return 'ignored_peer';
  const content = rows.filter((row) => row.messageType !== 'reactionMessage');
  if (!content.length) return 'not_a_message';
  const real = content.filter((row) => !isInboundTransportOnly(row));
  if (!real.length) return 'ignore_transport';
  const payload = nativeGapSource(real)!;
  // Before the importer classifier, which refuses most of these shapes outright.
  if (RECOVERY_UNSUPPORTED_TYPES.has(payload.messageType)) return 'likely_unsupported';
  let ordinary = false;
  try {
    ordinary = classifyCachedHistoryRecord(payload, payload.status === 'EDITED') === 'ordinary';
  } catch {
    ordinary = false;
  }
  if (!ordinary) return 'not_a_message';
  try {
    resolveInboundNativeBody(content, payload);
  } catch {
    return 'blocked_ambiguous';
  }
  return 'enqueue_history';
}

const BATCH = 500;

export async function planNativeGaps(reader: NativeGapReader, filter: NativeGapFilter) {
  const since = Math.floor(filter.since.getTime() / 1000);
  const until = Math.floor(filter.until.getTime() / 1000);
  const candidates: NativeGapCandidate[] = [];
  let alreadyInLedger = 0;
  const routes = (await reader.routes(filter.instanceNames, filter.excludeInstanceNames)).filter(
    (route) => route.provider.enabled && route.provider.importMessages,
  );
  for (const route of routes) {
    // Group by WhatsApp identity; any linked row means Chatwoot already owns it.
    const groups = new Map<string, NativeGapIndexRow[]>();
    for (const row of await reader.index(route.instanceId, since, until)) {
      if (typeof row.key?.id !== 'string' || typeof row.key?.remoteJid !== 'string') continue;
      if (typeof row.key?.fromMe !== 'boolean') continue;
      const identity = inboundDeliveryId(route.instanceId, row);
      groups.set(identity, [...(groups.get(identity) ?? []), row]);
    }
    const open = [...groups.entries()].filter(
      ([, rows]) =>
        rows.every((row) => row.chatwootMessageId === null) &&
        rows.some((row) => row.messageType !== 'reactionMessage'),
    );
    for (let i = 0; i < open.length; i += BATCH) {
      const slice = open.slice(i, i + BATCH);
      const known = new Set(await reader.ledgerIds(slice.map(([identity]) => identity)));
      const fresh = slice.filter(([identity]) => !known.has(identity));
      alreadyInLedger += slice.length - fresh.length;
      const outbound = new Set(
        await reader.chatwootOutboundIds(route.instanceId, [
          ...new Set(fresh.filter(([, rows]) => rows[0].key.fromMe).map(([, rows]) => rows[0].key.id as string)),
        ]),
      );
      const bodies = new Map(
        (await reader.bodies(fresh.flatMap(([, rows]) => rows.map((row) => row.id)))).map((row) => [row.id, row]),
      );
      for (const [identity, index] of fresh) {
        const rows = index.map((row) => bodies.get(row.id)).filter((row): row is NativeGapRow => !!row);
        if (rows.length !== index.length) continue; // changed since the index read; the next run sees it
        const key = rows[0].key;
        const prediction = outbound.has(key.id) ? 'chatwoot_outbound' : predictNativeGap(rows, route);
        const source =
          prediction === 'enqueue_history' || prediction === 'likely_unsupported' ? nativeGapSource(rows) : undefined;
        candidates.push({
          route,
          identity,
          peer: key.remoteJid,
          fromMe: key.fromMe,
          messageType: (source ?? rows.find((row) => row.messageType !== 'reactionMessage') ?? rows[0]).messageType,
          timestampMs: Math.min(...rows.map((row) => row.messageTimestamp)) * 1000,
          prediction,
          source,
        });
      }
    }
  }
  // Oldest WhatsApp message first: the history lane replays each chat in order.
  candidates.sort(
    (a, b) => a.timestampMs - b.timestampMs || a.peer.localeCompare(b.peer) || a.identity.localeCompare(b.identity),
  );
  const selected = candidates.filter((candidate) => candidate.prediction === 'enqueue_history');
  const skip = filter.skipUnsupported
    ? candidates.filter((candidate) => candidate.prediction === 'likely_unsupported' && candidate.source)
    : [];
  const planHash = createHash('sha256')
    .update(
      JSON.stringify([
        ...selected.map(({ identity, source }) => [identity, source.id, inboundPayloadHash(ledgerPayload(source))]),
        ...skip.map(({ identity, source }) => [identity, source.id, 'skip']),
      ]),
    )
    .digest('hex');
  return { candidates, selected, skip, alreadyInLedger, planHash };
}

const mask = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);

// Aggregates only: no message text, phone numbers, names or ids leave the host.
export function nativeGapReport(plan: Awaited<ReturnType<typeof planNativeGaps>>, now: Date) {
  const count = (list: NativeGapCandidate[], key: (candidate: NativeGapCandidate) => string) => {
    const counts: Record<string, number> = {};
    for (const candidate of list) counts[key(candidate)] = (counts[key(candidate)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
  };
  const scope = (candidate: NativeGapCandidate) => (candidate.peer.endsWith('@g.us') ? 'group' : 'direct');
  const direction = (candidate: NativeGapCandidate) => (candidate.fromMe ? 'fromMe' : 'incoming');
  return {
    generatedAt: now.toISOString(),
    gaps: plan.candidates.length,
    alreadyInLedger: plan.alreadyInLedger,
    toEnqueue: plan.selected.length,
    chatsToEnqueue: new Set(plan.selected.map((candidate) => candidate.route.instanceId + '|' + candidate.peer)).size,
    oldestToEnqueue: plan.selected[0] ? new Date(plan.selected[0].timestampMs).toISOString() : null,
    toSkipUnsupported: plan.skip.length,
    byPrediction: count(plan.candidates, (candidate) => candidate.prediction),
    byPredictionAndType: count(plan.candidates, (candidate) => `${candidate.prediction}|${candidate.messageType}`),
    toEnqueueByScopeDirection: count(plan.selected, (candidate) => `${scope(candidate)}|${direction(candidate)}`),
    toEnqueueByInstance: count(plan.selected, (candidate) => mask(candidate.route.instanceName)),
    planHash: plan.planHash,
  };
}

export async function applyNativeGaps(
  plan: Awaited<ReturnType<typeof planNativeGaps>>,
  writer: NativeGapWriter,
  now: Date,
  spacingMs = 10,
) {
  const row = (
    { route, identity, source }: NativeGapCandidate,
    state: 'history_pending' | 'ignored',
    lastErrorClass: string,
    nextAttemptAt: Date,
  ): InboundDelivery => {
    const payload = ledgerPayload(source);
    if (inboundDeliveryId(route.instanceId, payload) !== identity) throw new Error('NativeGapIdentityChanged');
    return {
      id: identity,
      instanceId: route.instanceId,
      instanceName: route.instanceName,
      providerId: route.provider.id,
      providerFingerprint: inboundProviderFingerprint(route.provider),
      accountId: Number(route.provider.accountId),
      inboxId: null,
      peer: source.key.remoteJid,
      sourceId: 'WAID:' + source.key.id,
      fromMe: source.key.fromMe,
      payload,
      payloadHash: inboundPayloadHash(payload),
      state,
      attempts: 0,
      nextAttemptAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      result: null,
      lastErrorClass,
    };
  };
  const items = plan.selected.map((candidate, index) =>
    row(candidate, 'history_pending', RECOVERY_MARKER, new Date(now.getTime() + index * spacingMs)),
  );
  const ignored = plan.skip.map((candidate) => row(candidate, 'ignored', INBOUND_UNSUPPORTED_SKIPPED, now));
  let enqueued = 0;
  for (let i = 0; i < items.length; i += BATCH) enqueued += await writer.enqueue(items.slice(i, i + BATCH));
  let skippedUnsupported = 0;
  for (let i = 0; i < ignored.length; i += BATCH)
    skippedUnsupported += await writer.enqueue(ignored.slice(i, i + BATCH));
  return { enqueued, skipped: items.length - enqueued, skippedUnsupported };
}

export function prismaNativeGapReader(prisma: any): NativeGapReader {
  return {
    async routes(instanceNames, excludeInstanceNames) {
      const instances = await prisma.instance.findMany({
        where: {
          name: {
            ...(instanceNames?.length ? { in: instanceNames } : {}),
            ...(excludeInstanceNames?.length ? { notIn: excludeInstanceNames } : {}),
          },
        },
        select: { id: true, name: true, Chatwoot: true, Setting: { select: { groupsIgnore: true } } },
        orderBy: { name: 'asc' },
      });
      return instances
        .filter((instance: any) => instance.Chatwoot)
        .map((instance: any) => ({
          instanceId: instance.id,
          instanceName: instance.name,
          groupsIgnore: Boolean(instance.Setting?.groupsIgnore),
          provider: instance.Chatwoot,
        }));
    },
    index: (instanceId, since, until) =>
      prisma.$queryRawUnsafe(
        `SELECT id, key, "messageType", "messageTimestamp", "chatwootMessageId"
           FROM "Message" WHERE "instanceId" = $1 AND "messageTimestamp" >= $2 AND "messageTimestamp" < $3`,
        instanceId,
        since,
        until,
      ),
    bodies: (ids) =>
      ids.length
        ? prisma.$queryRawUnsafe(
            `SELECT id, key, "messageType", message, "messageTimestamp", "contextInfo", participant, "pushName", status,
                    "chatwootMessageId"
               FROM "Message" WHERE id = ANY($1::text[])`,
            ids,
          )
        : Promise.resolve([]),
    ledgerIds: async (ids) =>
      ids.length
        ? (await prisma.chatwootInboundDelivery.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
            (row: any) => row.id,
          )
        : [],
    chatwootOutboundIds: async (instanceId, whatsappIds) => {
      if (!whatsappIds.length) return [];
      const rows = await prisma.chatwootOutboundOperation.findMany({
        where: {
          instanceId,
          OR: [{ plannedWhatsappMessageId: { in: whatsappIds } }, { whatsappMessageId: { in: whatsappIds } }],
        },
        select: { plannedWhatsappMessageId: true, whatsappMessageId: true },
      });
      return rows.flatMap((row: any) => [row.plannedWhatsappMessageId, row.whatsappMessageId]).filter(Boolean);
    },
  };
}

export function prismaNativeGapWriter(prisma: any): NativeGapWriter {
  return {
    // Deterministic ids: a row that appeared since the plan (live or history
    // ingress won the race) is kept as it is, never overwritten.
    enqueue: async (items) =>
      (await prisma.chatwootInboundDelivery.createMany({ data: items, skipDuplicates: true })).count,
  };
}
