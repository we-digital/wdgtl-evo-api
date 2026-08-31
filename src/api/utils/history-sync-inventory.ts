import { createHash } from 'node:crypto';

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
    updatedAt: Date;
  } | null;
}

export function toHistorySyncInventoryItem(instance: HistorySyncInventoryRecord) {
  return {
    instanceId: instance.id,
    instanceName: instance.name,
    connectionStatus: instance.connectionStatus,
    ownerPresent: Boolean(instance.ownerJid),
    ownerFingerprint: createHash('sha256')
      .update(instance.ownerJid ?? '')
      .digest('hex'),
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
