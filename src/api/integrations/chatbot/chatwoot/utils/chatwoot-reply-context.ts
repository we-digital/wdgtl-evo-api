/**
 * Extract WhatsApp reply context (stanzaId) from Baileys message payloads
 * and normalize Chatwoot Evolution source ids (`WAID:<id>`).
 */

const WAID_PREFIX = 'WAID:';

type ContextInfoLike = {
  stanzaId?: unknown;
  stanzaid?: unknown;
  quotedMessage?: unknown;
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

const quotedMessageFromContext = (contextInfo: unknown): unknown | null => {
  if (!contextInfo || typeof contextInfo !== 'object') return null;
  return (contextInfo as ContextInfoLike).quotedMessage ?? null;
};

const extractQuotedMessageFromContent = (message: unknown, depth = 0): unknown | null => {
  if (!message || typeof message !== 'object' || depth > 4) return null;
  const content = message as Record<string, unknown>;

  const direct = quotedMessageFromContext(content.contextInfo);
  if (direct) return direct;

  for (const [key, value] of Object.entries(content)) {
    if (!value || typeof value !== 'object') continue;
    if (WRAPPER_KEYS.has(key)) {
      const nested = extractQuotedMessageFromContent((value as { message?: unknown }).message, depth + 1);
      if (nested) return nested;
      continue;
    }

    const quoted = quotedMessageFromContext((value as { contextInfo?: unknown }).contextInfo);
    if (quoted) return quoted;
  }

  return null;
};

export const extractWhatsappReplyQuotedMessage = (msg: unknown): unknown | null => {
  if (!msg || typeof msg !== 'object') return null;
  const body = msg as Record<string, unknown>;
  return quotedMessageFromContext(body.contextInfo) || extractQuotedMessageFromContent(body.message);
};

export const whatsappMessageText = (message: unknown, depth = 0): string | null => {
  if (!message || typeof message !== 'object' || depth > 4) return null;
  const content = message as Record<string, unknown>;
  if (typeof content.conversation === 'string' && content.conversation) return content.conversation;

  for (const [key, value] of Object.entries(content)) {
    if (!value || typeof value !== 'object') continue;
    if (WRAPPER_KEYS.has(key)) {
      const nested = whatsappMessageText((value as { message?: unknown }).message, depth + 1);
      if (nested) return nested;
      continue;
    }

    const textContent = value as { text?: unknown; caption?: unknown };
    if (typeof textContent.text === 'string' && textContent.text) return textContent.text;
    if (typeof textContent.caption === 'string' && textContent.caption) return textContent.caption;
  }

  return null;
};

/**
 * Preserve WhatsApp's provider quote snapshot when it differs from the parent
 * currently stored by EVO. Equality proves an ordinary whole-parent reply.
 * A difference can mean either a selected fragment or that the parent is
 * missing/edited, so callers must not claim selection more strongly than the
 * provider payload proves.
 */
export const whatsappReplyQuoteSnapshotText = (reply: unknown, parentMessage: unknown): string | null => {
  const quotedText = whatsappMessageText(extractWhatsappReplyQuotedMessage(reply));
  if (!quotedText) return null;

  const parentText = whatsappMessageText(parentMessage);
  return quotedText !== parentText ? quotedText : null;
};

export const whatsappQuotedMessageContent = (message: unknown, quoteText?: string): unknown =>
  quoteText ? { conversation: quoteText } : message;

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

export const chatwootReplyReferences = (
  contentAttributes: Record<string, unknown> | null | undefined,
): { chatwootMessageId?: number; whatsappMessageId?: string; quoteText?: string } => {
  const rawChatwootId = Number(contentAttributes?.in_reply_to);
  const chatwootMessageId = Number.isSafeInteger(rawChatwootId) && rawChatwootId > 0 ? rawChatwootId : undefined;
  const whatsappMessageId = stripChatwootWhatsappSourceId(
    typeof contentAttributes?.in_reply_to_external_id === 'string'
      ? contentAttributes.in_reply_to_external_id
      : undefined,
  );
  const quoteText =
    typeof contentAttributes?.quote_text === 'string' && contentAttributes.quote_text
      ? contentAttributes.quote_text
      : undefined;

  return {
    ...(chatwootMessageId ? { chatwootMessageId } : {}),
    ...(whatsappMessageId ? { whatsappMessageId } : {}),
    ...(quoteText ? { quoteText } : {}),
  };
};

/** Drop null reply ids so Chatwoot content_attributes stay clean. */
export const compactReplyToIds = (ids: {
  in_reply_to: string | number | null;
  in_reply_to_external_id: string | null;
  quote_text?: string | null;
}): Record<string, string | number> => {
  const out: Record<string, string | number> = {};
  if (ids.in_reply_to != null && ids.in_reply_to !== '') {
    out.in_reply_to = ids.in_reply_to;
  }
  if (ids.in_reply_to_external_id) {
    out.in_reply_to_external_id = ids.in_reply_to_external_id;
  }
  if (ids.quote_text) {
    out.quote_text = ids.quote_text;
  }
  return out;
};
