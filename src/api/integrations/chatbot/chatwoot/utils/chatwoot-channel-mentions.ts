/**
 * Native WhatsApp @mentions from Chatwoot markdown / content_attributes.
 *
 * Chatwoot stores: [@Name](mention://whatsapp/<urlencoded-jid>/<urlencoded-name>)
 * and content_attributes.channel_mentions: [{ provider, id, display }]
 */

const WHATSAPP_MENTION_MARKDOWN = /\[(@[^\]]+)\]\(mention:\/\/whatsapp\/([^/]+)\/([^)]+)\)/gi;

export type ChatwootChannelMention = {
  provider: string;
  id: string;
  display?: string;
};

export function extractWhatsappMentionJids(body: {
  content?: string | null;
  content_attributes?: Record<string, unknown> | null;
}): string[] {
  const fromAttrs = channelMentionsFromAttributes(body?.content_attributes)
    .filter((mention) => mention.provider === 'whatsapp' && mention.id)
    .map((mention) => normalizeWhatsappJid(mention.id));

  const fromContent: string[] = [];
  const content = typeof body?.content === 'string' ? body.content : '';
  content.replace(WHATSAPP_MENTION_MARKDOWN, (_full, _display, rawId: string) => {
    try {
      fromContent.push(normalizeWhatsappJid(decodeURIComponent(rawId)));
    } catch {
      fromContent.push(normalizeWhatsappJid(rawId));
    }
    return _full;
  });

  return [...new Set([...fromAttrs, ...fromContent].filter(Boolean))];
}

export function stripWhatsappMentionMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(WHATSAPP_MENTION_MARKDOWN, (_full, display: string) => display);
}

export function channelMentionsFromAttributes(
  contentAttributes: Record<string, unknown> | null | undefined,
): ChatwootChannelMention[] {
  const raw = contentAttributes?.channel_mentions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const provider = String((entry as any).provider || '');
    const id = String((entry as any).id || '');
    if (!provider || !id) return [];
    const mention: ChatwootChannelMention = {
      provider,
      id,
    };
    if ((entry as any).display) {
      mention.display = String((entry as any).display);
    }
    return [mention];
  });
}

export function normalizeWhatsappJid(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.includes('@')) {
    const [local, domain] = value.split('@', 2);
    return `${local.split(':', 1)[0]}@${domain}`;
  }
  const digits = value.replace(/\D/g, '');
  if (!digits) return value;
  return `${digits}@s.whatsapp.net`;
}

export type WhatsappGroupParticipantSnapshot = {
  id: string;
  name?: string;
  phone?: string;
};

export function formatIncomingWhatsappMentions(
  text: string | null | undefined,
  mentionedJids: string[],
  participants: WhatsappGroupParticipantSnapshot[],
): string {
  let formatted = text || '';
  const byId = new Map<string, WhatsappGroupParticipantSnapshot>();
  for (const participant of participants) {
    const participantId = normalizeWhatsappJid(participant.id);
    if (participantId) byId.set(participantId, participant);
    const phoneAlias = normalizeWhatsappJid(participant.phone || '');
    if (phoneAlias) byId.set(phoneAlias, participant);
  }

  for (const rawJid of mentionedJids) {
    const jid = normalizeWhatsappJid(rawJid);
    const participant = byId.get(jid);
    if (!participant) continue;

    const token = String(participant.phone || jid.split('@')[0] || '').replace(/\D/g, '');
    if (!token) continue;
    const nativeMention = `@${token}`;
    if (!formatted.includes(nativeMention)) continue;

    const name = participant.name?.trim() || token;
    const display = `@${name}`;
    const participantId = normalizeWhatsappJid(participant.id);
    const markup = `[${display}](mention://whatsapp/${encodeURIComponent(participantId)}/${encodeURIComponent(name)})`;
    formatted = formatted.replace(new RegExp(`${nativeMention}(?!\\d)`, 'g'), markup);
  }

  return formatted;
}

export function buildWhatsappGroupParticipantSnapshots(
  participants: Array<{ id?: string; name?: string | null; phoneNumber?: string | null; imgUrl?: string | null }>,
): WhatsappGroupParticipantSnapshot[] {
  return participants.flatMap((participant) => {
    const id = normalizeWhatsappJid(participant.id || '');
    if (!id) return [];
    const phone = participant.phoneNumber ? String(participant.phoneNumber).replace(/\D/g, '') : id.split('@')[0];
    const snapshot: WhatsappGroupParticipantSnapshot = {
      id,
      name: participant.name?.trim() || phone,
      phone,
    };
    return [snapshot];
  });
}
