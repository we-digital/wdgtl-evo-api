import { createHash } from 'node:crypto';

export interface HistorySyncSourceIdentity {
  instanceId: string;
  ownerJid: string | null | undefined;
  chatwoot: {
    accountId: string | null | undefined;
    url: string | null | undefined;
    nameInbox: string | null | undefined;
  } | null;
}

function normalizeOwnerJid(ownerJid: string | null | undefined): string {
  return (ownerJid ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+(?=@)/, '');
}

function normalizeUrl(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

export function createHistorySyncSourceKey(source: HistorySyncSourceIdentity): string {
  const canonical = JSON.stringify({
    instanceId: source.instanceId.trim(),
    ownerJid: normalizeOwnerJid(source.ownerJid),
    chatwootAccountId: (source.chatwoot?.accountId ?? '').trim(),
    chatwootUrl: normalizeUrl(source.chatwoot?.url),
  });

  return createHash('sha256').update(canonical).digest('hex');
}

export function createHistorySyncAcquisitionKey(instanceId: string, ownerJid: string | null | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify({ instanceId: instanceId.trim(), ownerJid: normalizeOwnerJid(ownerJid) }))
    .digest('hex');
}

export function normalizeHistorySyncOwnerJid(ownerJid: string | null | undefined): string {
  return normalizeOwnerJid(ownerJid);
}
