import { createHash } from 'node:crypto';

import { createHistorySyncSourceKey, normalizeHistorySyncOwnerJid } from './history-sync-source';

export const HISTORY_SYNC_INVENTORY_CONTRACT_VERSION = '2026-08-31' as const;

export interface HistorySyncInventoryRecord {
  id: string;
  name: string;
  connectionStatus: string;
  ownerJid: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  Chatwoot: {
    enabled: boolean | null;
    importMessages: boolean | null;
    accountId: string | null;
    url: string | null;
    nameInbox: string | null;
    updatedAt: Date;
  } | null;
}

export function toHistorySyncInventoryItem(instance: HistorySyncInventoryRecord) {
  return {
    instanceId: instance.id,
    instanceName: instance.name,
    connectionStatus: instance.connectionStatus,
    ownerFingerprint: createHash('sha256')
      .update(instance.ownerJid ?? '')
      .digest('hex'),
    sourceKey: createHistorySyncSourceKey({
      instanceId: instance.id,
      ownerJid: instance.ownerJid,
      chatwoot: instance.Chatwoot,
    }),
    sourceIdentityReady: normalizeHistorySyncOwnerJid(instance.ownerJid).length > 0,
    createdAt: instance.createdAt?.toISOString() ?? null,
    updatedAt: instance.updatedAt?.toISOString() ?? null,
    chatwoot: instance.Chatwoot
      ? {
          enabled: instance.Chatwoot.enabled === true,
          importMessages: instance.Chatwoot.importMessages === true,
          updatedAt: instance.Chatwoot.updatedAt.toISOString(),
        }
      : null,
  };
}
