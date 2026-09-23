/**
 * Resolve Baileys message key for outbound Chatwoot → WhatsApp reactions.
 */

export type WhatsappReactionKey = {
  id: string;
  remoteJid: string;
  fromMe?: boolean;
  participant?: string;
};

const stripWaid = (sourceId: unknown): string =>
  String(sourceId || '')
    .replace(/^WAID:/i, '')
    .trim();

const asJid = (value: unknown): string | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/^\+/, '').replace(/\D/g, '');
  if (digits.length < 8) return null;
  return `${digits}@s.whatsapp.net`;
};

export const resolveWhatsappReactionRemoteJid = (body: {
  conversation?: {
    contact_inbox?: { source_id?: string };
    meta?: { sender?: { identifier?: string; phone_number?: string } };
  };
}): string | null => {
  const contactSource = body?.conversation?.contact_inbox?.source_id;
  const fromContact = asJid(contactSource);
  if (fromContact) return fromContact;

  const identifier = body?.conversation?.meta?.sender?.identifier;
  const fromIdentifier = asJid(identifier);
  if (fromIdentifier) return fromIdentifier;

  const phone = body?.conversation?.meta?.sender?.phone_number;
  return asJid(phone);
};

export const resolveWhatsappReactionKey = (params: {
  storedKey?: WhatsappReactionKey | null;
  sourceId?: unknown;
  messageType?: unknown;
  body?: {
    conversation?: {
      contact_inbox?: { source_id?: string };
      meta?: { sender?: { identifier?: string; phone_number?: string } };
    };
  };
}): WhatsappReactionKey | null => {
  const stored = params.storedKey;
  if (stored?.id && stored?.remoteJid) {
    return {
      id: String(stored.id),
      remoteJid: String(stored.remoteJid),
      fromMe: Boolean(stored.fromMe),
      participant: stored.participant ? String(stored.participant) : undefined,
    };
  }

  const id = stripWaid(params.sourceId) || (stored?.id ? String(stored.id) : '');
  const remoteJid =
    (stored?.remoteJid ? String(stored.remoteJid) : null) ||
    resolveWhatsappReactionRemoteJid(params.body || {});

  if (!id || !remoteJid) return null;

  const messageType = String(params.messageType || '');
  return {
    id,
    remoteJid,
    fromMe: messageType === 'outgoing' || Boolean(stored?.fromMe),
    participant: stored?.participant ? String(stored.participant) : undefined,
  };
};
