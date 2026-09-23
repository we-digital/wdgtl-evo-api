/**
 * Extract WhatsApp reply context (stanzaId) from Baileys message payloads
 * and normalize Chatwoot Evolution source ids (`WAID:<id>`).
 */

const WAID_PREFIX = 'WAID:';

type ContextInfoLike = {
  stanzaId?: unknown;
  stanzaid?: unknown;
};

const readStanzaId = (contextInfo: unknown): string | null => {
  if (!contextInfo || typeof contextInfo !== 'object') return null;
  const info = contextInfo as ContextInfoLike;
  const raw = info.stanzaId ?? info.stanzaid;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
};

/**
 * Baileys nests contextInfo under each content key (extendedTextMessage,
 * imageMessage, …) and sometimes on the outer envelope after normalize.
 */
export const extractWhatsappReplyStanzaId = (msg: unknown): string | null => {
  if (!msg || typeof msg !== 'object') return null;
  const body = msg as Record<string, unknown>;

  const topLevel = readStanzaId(body.contextInfo);
  if (topLevel) return topLevel;

  const message = body.message;
  if (!message || typeof message !== 'object') return null;
  const content = message as Record<string, unknown>;

  const direct = readStanzaId(content.contextInfo);
  if (direct) return direct;

  for (const value of Object.values(content)) {
    if (!value || typeof value !== 'object') continue;
    const nested = readStanzaId((value as { contextInfo?: unknown }).contextInfo);
    if (nested) return nested;
  }

  return null;
};

/** Chatwoot Evolution inbox stores WA message source_id as `WAID:<stanzaId>`. */
export const toChatwootWhatsappSourceId = (stanzaId: string | null | undefined): string | null => {
  if (!stanzaId || typeof stanzaId !== 'string') return null;
  const trimmed = stanzaId.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(WAID_PREFIX)) return trimmed;
  return `${WAID_PREFIX}${trimmed}`;
};

export const stripChatwootWhatsappSourceId = (sourceId: string | null | undefined): string | null => {
  if (!sourceId || typeof sourceId !== 'string') return null;
  const trimmed = sourceId.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(WAID_PREFIX) ? trimmed.slice(WAID_PREFIX.length) : trimmed;
};
