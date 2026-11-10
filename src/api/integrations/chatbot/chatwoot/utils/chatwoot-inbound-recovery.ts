import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import {
  inboundSourceCandidates,
  isInboundTransportOnly,
  resolveInboundNativeBody,
} from './chatwoot-inbound-native-source';
import { inboundDeliveryId, InboundLane, inboundPayloadHash } from './chatwoot-inbound-queue';

// Recovery for ledger rows that never reached Chatwoot. It only moves rows back
// into their own lane with an ordered nextAttemptAt; delivery itself stays the
// queue's job, so every requeued row is still delivered through the verified
// receiver read (no POST when Chatwoot already owns the source). The marker
// error class keeps the stage-3 idempotent fast path off for these rows.
export const RECOVERY_MARKER = 'InboundReceiverRecoveryRequeued';
export const RECOVERY_STATES = ['pending', 'history_pending', 'failed'] as const;
const unsupportedTypes = new Set([
  'lottieStickerMessage',
  'associatedChildMessage',
  'buttonsMessage',
  'templateMessage',
  'interactiveMessage',
  'listMessage',
]);

export type RecoveryPrediction =
  | 'deliver'
  | 'confirm_existing'
  | 'deliver_from_payload'
  | 'ignore_transport'
  | 'likely_unsupported'
  | 'blocked_ambiguous'
  | 'blocked_native_missing'
  | 'blocked_source_changed';
const requeuable = new Set<RecoveryPrediction>(['deliver', 'confirm_existing', 'deliver_from_payload']);

export interface RecoveryRow {
  id: string;
  instanceId: string;
  instanceName: string;
  peer: string;
  sourceId: string;
  fromMe: boolean;
  payload: Record<string, any>;
  payloadHash: string;
  state: string;
  attempts: number;
  lastErrorClass: string | null;
  result: any;
  createdAt: Date;
  nextAttemptAt: Date;
  leaseExpiresAt: Date | null;
}
export interface RecoveryNativeRow {
  id: string;
  key: any;
  messageType: string;
  message: any;
  messageTimestamp: number;
  contextInfo: any;
  participant: string | null;
  pushName: string | null;
  status: string | null;
  chatwootMessageId: number | null;
}
export interface RecoveryCandidate {
  row: RecoveryRow;
  lane: InboundLane;
  prediction: RecoveryPrediction;
  timestampMs: number;
}

function timestampMs(payload: Record<string, any>): number {
  const value = payload?.messageTimestamp;
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : value && typeof value === 'object' && Number.isFinite(value.low)
          ? (value.high || 0) * 4294967296 + (value.low >>> 0)
          : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

// Rows closed before the queue kept the lane: live rows are committed within
// seconds of their WhatsApp timestamp, history rows long after it.
export function recoveryLane(row: RecoveryRow): InboundLane {
  if (row.state === 'history_pending') return 'history';
  if (row.state === 'pending') return 'live';
  if (row.result?.lane === 'history' || row.result?.lane === 'live') return row.result.lane;
  const sent = timestampMs(row.payload);
  return sent && new Date(row.createdAt).getTime() - sent > 3_600_000 ? 'history' : 'live';
}

// Same decisions delivery will take, without any receiver call.
export function predictRecovery(
  row: RecoveryRow,
  lane: InboundLane,
  natives: RecoveryNativeRow[],
  sameIdRows: number,
): RecoveryPrediction {
  if (inboundDeliveryId(row.instanceId, row.payload) !== row.id || inboundPayloadHash(row.payload) !== row.payloadHash)
    return 'blocked_source_changed';
  if (isInboundTransportOnly(row.payload)) return 'ignore_transport';
  const candidates = inboundSourceCandidates(natives as any[], row.payload);
  if (!candidates.length)
    return lane === 'live' && sameIdRows === 0 ? 'deliver_from_payload' : 'blocked_native_missing';
  let resolved: Record<string, any>;
  try {
    resolved = resolveInboundNativeBody(candidates, row.payload);
  } catch {
    return 'blocked_ambiguous';
  }
  if (isInboundTransportOnly(resolved)) return 'ignore_transport';
  if (unsupportedTypes.has(resolved.messageType)) return 'likely_unsupported';
  if (candidates.some((native) => native.chatwootMessageId !== null)) return 'confirm_existing';
  return 'deliver';
}

export interface RecoveryFilter {
  states?: string[];
  instanceNames?: string[];
  errorClasses?: string[];
  excludeInstanceNames?: string[];
}

export interface RecoveryReader {
  rows(filter: RecoveryFilter): Promise<RecoveryRow[]>;
  natives(instanceId: string, keyIds: string[]): Promise<RecoveryNativeRow[]>;
}
export interface RecoveryWriter {
  requeue(row: RecoveryRow, state: 'pending' | 'history_pending', nextAttemptAt: Date, now: Date): Promise<boolean>;
}

export async function planRecovery(reader: RecoveryReader, filter: RecoveryFilter, now: Date) {
  const rows = (await reader.rows(filter)).filter(
    (row) => !row.leaseExpiresAt || new Date(row.leaseExpiresAt).getTime() < now.getTime(),
  );
  const byInstance = new Map<string, RecoveryRow[]>();
  for (const row of rows) byInstance.set(row.instanceId, [...(byInstance.get(row.instanceId) ?? []), row]);
  const candidates: RecoveryCandidate[] = [];
  for (const [instanceId, group] of byInstance) {
    const ids = [...new Set(group.map((row) => row.sourceId.slice(5)))];
    const natives: RecoveryNativeRow[] = [];
    for (let i = 0; i < ids.length; i += 500)
      natives.push(...(await reader.natives(instanceId, ids.slice(i, i + 500))));
    for (const row of group) {
      const keyId = row.sourceId.slice(5);
      const sameId = natives.filter((native) => native.key?.id === keyId);
      const exact = sameId.filter((native) => native.key?.remoteJid === row.peer && native.key?.fromMe === row.fromMe);
      const lane = recoveryLane(row);
      candidates.push({
        row,
        lane,
        prediction: exact.length >= 3 ? 'blocked_ambiguous' : predictRecovery(row, lane, exact, sameId.length),
        timestampMs: timestampMs(row.payload),
      });
    }
  }
  // Oldest WhatsApp message first: the queue delivers in nextAttemptAt order,
  // one in-flight delivery per chat, so each chat replays in original order.
  candidates.sort(
    (a, b) => a.timestampMs - b.timestampMs || a.row.peer.localeCompare(b.row.peer) || a.row.id.localeCompare(b.row.id),
  );
  const selected = candidates.filter((candidate) => requeuable.has(candidate.prediction));
  const planHash = createHash('sha256')
    .update(JSON.stringify(selected.map(({ row, lane }) => [row.id, row.state, row.attempts, lane])))
    .digest('hex');
  return { candidates, selected, planHash };
}

const mask = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);

// Aggregates only: no message text, phone numbers, names or ids leave the host.
export function recoveryReport(plan: Awaited<ReturnType<typeof planRecovery>>, now: Date) {
  const count = (key: (candidate: RecoveryCandidate) => string) => {
    const counts: Record<string, number> = {};
    for (const candidate of plan.candidates) counts[key(candidate)] = (counts[key(candidate)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
  };
  const scope = (candidate: RecoveryCandidate) => (candidate.row.peer.endsWith('@g.us') ? 'group' : 'direct');
  const oldest = plan.selected[0]?.timestampMs;
  return {
    generatedAt: now.toISOString(),
    rows: plan.candidates.length,
    toRequeue: plan.selected.length,
    toRequeueByLane: {
      live: plan.selected.filter((candidate) => candidate.lane === 'live').length,
      history: plan.selected.filter((candidate) => candidate.lane === 'history').length,
    },
    groupsToRequeue: plan.selected.filter((candidate) => scope(candidate) === 'group').length,
    chatsToRequeue: new Set(plan.selected.map(({ row }) => row.instanceId + '|' + row.peer)).size,
    oldestToRequeue: oldest ? new Date(oldest).toISOString() : null,
    byPrediction: count((candidate) => candidate.prediction),
    byStateAndPrediction: count(
      (candidate) => `${candidate.row.state}|${candidate.row.lastErrorClass ?? '-'}|${candidate.prediction}`,
    ),
    byLaneScopeDirection: count(
      (candidate) => `${candidate.lane}|${scope(candidate)}|${candidate.row.fromMe ? 'fromMe' : 'incoming'}`,
    ),
    byInstance: count((candidate) => `${mask(candidate.row.instanceName)}|${candidate.prediction}`),
    planHash: plan.planHash,
  };
}

export async function applyRecovery(
  plan: Awaited<ReturnType<typeof planRecovery>>,
  writer: RecoveryWriter,
  now: Date,
  spacingMs = 10,
) {
  let requeued = 0,
    skipped = 0;
  for (const [index, { row, lane }] of plan.selected.entries()) {
    const ok = await writer.requeue(
      row,
      lane === 'history' ? 'history_pending' : 'pending',
      new Date(now.getTime() + index * spacingMs),
      now,
    );
    if (ok) requeued++;
    else skipped++;
  }
  return { requeued, skipped };
}

export function prismaRecoveryReader(prisma: any): RecoveryReader {
  return {
    rows: (filter) =>
      prisma.chatwootInboundDelivery.findMany({
        where: {
          state: { in: filter.states?.length ? filter.states : [...RECOVERY_STATES] },
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
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 50_000,
      }),
    natives: (instanceId, keyIds) =>
      prisma.$queryRawUnsafe(
        `SELECT id, key, "messageType", message, "messageTimestamp", "contextInfo", participant, "pushName", status,
                "chatwootMessageId"
           FROM "Message" WHERE "instanceId" = $1 AND key->>'id' = ANY($2::text[])`,
        instanceId,
        keyIds,
      ),
  };
}

export function prismaRecoveryWriter(prisma: any): RecoveryWriter {
  return {
    async requeue(row, state, nextAttemptAt, now) {
      // CAS on the exact row version the plan saw; a leased or changed row is skipped.
      const updated = await prisma.chatwootInboundDelivery.updateMany({
        where: {
          id: row.id,
          state: row.state,
          attempts: row.attempts,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: {
          state,
          nextAttemptAt,
          lastErrorClass: RECOVERY_MARKER,
          leaseOwner: null,
          leaseExpiresAt: null,
          ...(row.state === 'failed' ? { result: Prisma.DbNull } : {}),
        },
      });
      return updated.count === 1;
    },
  };
}
