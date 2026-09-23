/**
 * Resolve Baileys message key for outbound Chatwoot → WhatsApp reactions.
 */

export type WhatsappReactionKey = {
  id: string;
  remoteJid: string;
  fromMe?: boolean;
  participant?: string;
};

const whatsappIdFromSourceId = (sourceId: unknown): string | null => {
  if (typeof sourceId !== 'string') return null;
  const match = sourceId.trim().match(/^WAID:(\S+)$/i);
  return match?.[1] || null;
};

const asWhatsappJid = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const separator = raw.lastIndexOf('@');
  if (separator <= 0) return null;

  const user = raw.slice(0, separator);
  const domain = raw.slice(separator + 1).toLowerCase();
  const isUserIdentity = /^(?:\d+)(?::\d+)?$/.test(user);
  const isGroupIdentity = /^\d+(?:-\d+)?$/.test(user);

  if (['s.whatsapp.net', 'hosted', 'lid', 'hosted.lid'].includes(domain) && isUserIdentity) {
    return `${user}@${domain}`;
  }
  if (domain === 'g.us' && isGroupIdentity) return `${user}@${domain}`;
  return null;
};

const asPhoneJid = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || !/^\+?[\d\s().-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 20) return null;
  return `${digits}@s.whatsapp.net`;
};

const asProviderIdentity = (value: unknown): string | null => asWhatsappJid(value) || asPhoneJid(value);

const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us');

const asParticipantJid = (value: unknown): string | null => {
  const jid = asWhatsappJid(value);
  return jid && !isGroupJid(jid) ? jid : null;
};

export const resolveWhatsappReactionRemoteJid = (body: {
  conversation?: {
    contact_inbox?: { source_id?: string };
    meta?: { sender?: { identifier?: string; phone_number?: string } };
  };
}): string | null => {
  const contactSource = body?.conversation?.contact_inbox?.source_id;
  const fromContact = asProviderIdentity(contactSource);
  if (fromContact) return fromContact;

  const identifier = body?.conversation?.meta?.sender?.identifier;
  const fromIdentifier = asProviderIdentity(identifier);
  if (fromIdentifier) return fromIdentifier;

  const phone = body?.conversation?.meta?.sender?.phone_number;
  return asPhoneJid(phone);
};

export const resolveWhatsappReactionKey = (params: {
  storedKey?: Partial<WhatsappReactionKey> | null;
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
  const storedRemoteJid = asWhatsappJid(stored?.remoteJid);
  const storedParticipant = stored?.participant ? asParticipantJid(stored.participant) : null;
  if (stored?.id && storedRemoteJid) {
    const fromMe = Boolean(stored.fromMe);
    if (isGroupJid(storedRemoteJid) && !fromMe && !storedParticipant) return null;
    return {
      id: String(stored.id),
      remoteJid: storedRemoteJid,
      fromMe,
      participant: storedParticipant || undefined,
    };
  }

  const id = whatsappIdFromSourceId(params.sourceId);
  const remoteJid = storedRemoteJid || resolveWhatsappReactionRemoteJid(params.body || {});

  if (!id || !remoteJid) return null;

  const messageType = String(params.messageType || '');
  if (messageType !== 'incoming' && messageType !== 'outgoing') return null;

  const fromMe = messageType === 'outgoing';
  if (isGroupJid(remoteJid) && !fromMe) return null;

  return {
    id,
    remoteJid,
    fromMe,
    participant: undefined,
  };
};
