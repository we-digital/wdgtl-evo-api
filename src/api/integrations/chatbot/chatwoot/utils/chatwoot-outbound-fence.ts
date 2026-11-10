import {
  ChatwootEvoRouteBinding,
  chatwootEvoRouteBindingsEqual,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';

/**
 * How old (measured from the start of its Chatwoot request) the preparation
 * snapshot may be when the transport fence reuses it instead of reading the
 * exact message again. A fresh fence read is itself 0.3–0.7 s old when the
 * relay starts, so a snapshot started at most this long ago proves the same
 * state within the same claim. 0 disables reuse (always a fresh read).
 */
export const DEFAULT_OUTBOUND_FENCE_SNAPSHOT_MAX_AGE_MS = 1_500;
export const MAX_OUTBOUND_FENCE_SNAPSHOT_MAX_AGE_MS = 5_000;

export const outboundFenceSnapshotMaxAgeMs = (value: string | undefined): number => {
  if (value === undefined || value.trim() === '') return DEFAULT_OUTBOUND_FENCE_SNAPSHOT_MAX_AGE_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_OUTBOUND_FENCE_SNAPSHOT_MAX_AGE_MS;
  return Math.max(0, Math.min(MAX_OUTBOUND_FENCE_SNAPSHOT_MAX_AGE_MS, parsed));
};

/** Local (DB + in-process) binding state the exact-message snapshot was validated against. */
export interface ChatwootOutboundFenceBinding {
  instanceId: string;
  instanceName: string;
  ownerJid: string | null;
  number: string | null;
  providerId: string;
  providerUpdatedAt: number | null;
  providerEnabled: boolean;
  providerUrl: string;
  providerToken: string;
  providerAccountId: string;
  providerNameInbox: string;
  route: ChatwootEvoRouteBinding | null;
  waInstance: unknown;
}

export interface ChatwootOutboundPreparedSnapshot {
  snapshotStartedAt: number;
  authoritativelyDeleted: boolean;
  fenceBinding: ChatwootOutboundFenceBinding;
}

const sameBinding = (a: ChatwootOutboundFenceBinding, b: ChatwootOutboundFenceBinding) =>
  a.instanceId === b.instanceId &&
  a.instanceName === b.instanceName &&
  (a.ownerJid ?? null) === (b.ownerJid ?? null) &&
  (a.number ?? null) === (b.number ?? null) &&
  a.providerId === b.providerId &&
  a.providerUpdatedAt === b.providerUpdatedAt &&
  a.providerEnabled === b.providerEnabled &&
  a.providerUrl === b.providerUrl &&
  a.providerToken === b.providerToken &&
  a.providerAccountId === b.providerAccountId &&
  a.providerNameInbox === b.providerNameInbox &&
  a.route !== null &&
  b.route !== null &&
  chatwootEvoRouteBindingsEqual(a.route, b.route) &&
  a.waInstance === b.waInstance;

/**
 * The transport fence may reuse the preparation snapshot of the same claim only
 * when it is fresh, was a live (not deleted) match, and nothing local that the
 * snapshot was validated against changed: instance row, Chatwoot provider row
 * (including its updatedAt), derived route binding and the exact in-process
 * WhatsApp socket object. Anything else falls back to the fresh exact read.
 */
export function canReusePreparedOutboundSnapshot(params: {
  prepared: ChatwootOutboundPreparedSnapshot | null | undefined;
  current: ChatwootOutboundFenceBinding | null;
  now: number;
  maxAgeMs: number;
}): boolean {
  const { prepared, current, now, maxAgeMs } = params;
  if (!prepared || !current || maxAgeMs <= 0) return false;
  if (prepared.authoritativelyDeleted) return false;
  if (!Number.isFinite(prepared.snapshotStartedAt)) return false;
  const age = now - prepared.snapshotStartedAt;
  if (age < 0 || age > maxAgeMs) return false;
  return sameBinding(prepared.fenceBinding, current);
}
