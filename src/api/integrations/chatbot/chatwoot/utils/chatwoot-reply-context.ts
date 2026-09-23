/**
 * Extract WhatsApp reply context (stanzaId) from Baileys message payloads
 * and normalize Chatwoot Evolution source ids (`WAID:<id>`).
 */

const WAID_PREFIX = 'WAID:';

type ContextInfoLike = {
  stanzaId?: unknown;
  stanzaid?: unknown;
};

const WRAPPER_KEYS = new Set([
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
]);

const readStanzaId = (contextInfo: unknown): string | null => {
  if (!contextInfo || typeof contextInfo !== 'object') return null;
  const info = contextInfo as ContextInfoLike;
  const raw = info.stanzaId ?? info.stanzaid;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
};

const extractFromMessageContent = (message: unknown, depth = 0): string | null => {
  if (!message || typeof message !== 'object' || depth > 4) return null;
  const content = message as Record<string, unknown>;

  const direct = readStanzaId(content.contextInfo);
  if (direct) return direct;

  for (const [key, value] of Object.entries(content)) {
    if (!value || typeof value !== 'object') continue;

    if (WRAPPER_KEYS.has(key)) {
      const nestedMessage = (value as { message?: unknown }).message;
      const fromWrapper = extractFromMessageContent(nestedMessage, depth + 1);
      if (fromWrapper) return fromWrapper;
      continue;
    }

    const nested = readStanzaId((value as { contextInfo?: unknown }).contextInfo);
    if (nested) return nested;
  }

  return null;
};

/**
 * Baileys nests contextInfo under each content key (extendedTextMessage,
 * imageMessage, …), under view-once / ephemeral wrappers, and sometimes on
 * the outer envelope after normalize.
 */
export const extractWhatsappReplyStanzaId = (msg: unknown): string | null => {
  if (!msg || typeof msg !== 'object') return null;
  const body = msg as Record<string, unknown>;

  const topLevel = readStanzaId(body.contextInfo);
  if (topLevel) return topLevel;

  return extractFromMessageContent(body.message);
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

/** Drop null reply ids so Chatwoot content_attributes stay clean. */
export const compactReplyToIds = (ids: {
  in_reply_to: string | number | null;
  in_reply_to_external_id: string | null;
}): Record<string, string | number> => {
  const out: Record<string, string | number> = {};
  if (ids.in_reply_to != null && ids.in_reply_to !== '') {
    out.in_reply_to = ids.in_reply_to;
  }
  if (ids.in_reply_to_external_id) {
    out.in_reply_to_external_id = ids.in_reply_to_external_id;
  }
  return out;
};
