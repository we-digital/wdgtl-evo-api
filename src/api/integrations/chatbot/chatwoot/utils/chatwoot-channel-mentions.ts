/**
 * Native WhatsApp @mentions from Chatwoot markdown / content_attributes.
 *
 * Chatwoot stores: [@Name](mention://whatsapp/<urlencoded-jid>/<urlencoded-name>)
 * and content_attributes.channel_mentions: [{ provider, id, display }]
 */

const WHATSAPP_MENTION_MARKDOWN =
  /\[(@[^\]]+)\]\(mention:\/\/whatsapp\/([^/]+)\/([^)]+)\)/gi;

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
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const provider = String((entry as any).provider || '');
      const id = String((entry as any).id || '');
      if (!provider || !id) return null;
      return {
        provider,
        id,
        display: (entry as any).display ? String((entry as any).display) : undefined,
      };
    })
    .filter((entry): entry is ChatwootChannelMention => Boolean(entry));
}

export function normalizeWhatsappJid(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.includes('@')) return value;
  const digits = value.replace(/\D/g, '');
  if (!digits) return value;
  return `${digits}@s.whatsapp.net`;
}

export type WhatsappGroupParticipantSnapshot = {
  id: string;
  name?: string;
  phone?: string;
};

export function buildWhatsappGroupParticipantSnapshots(
  participants: Array<{ id?: string; name?: string | null; phoneNumber?: string | null; imgUrl?: string | null }>,
): WhatsappGroupParticipantSnapshot[] {
  return participants
    .map((participant) => {
      const id = normalizeWhatsappJid(participant.id || '');
      if (!id) return null;
      const phone = participant.phoneNumber
        ? String(participant.phoneNumber).replace(/\D/g, '')
        : id.split('@')[0];
      return {
        id,
        name: participant.name?.trim() || phone,
        phone,
      };
    })
    .filter((entry): entry is WhatsappGroupParticipantSnapshot => Boolean(entry));
}
