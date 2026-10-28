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
  if (/mention:\/\/(user|team|telegram)\//i.test(text)) {
    throw new Error('Only WhatsApp group participants can be mentioned in a WhatsApp reply');
  }
  return text.replace(WHATSAPP_MENTION_MARKDOWN, (_full, _display: string, rawId: string) => {
    const jid = normalizeWhatsappJid(decodeURIComponent(rawId));
    if (!/^\d+@(s\.whatsapp\.net|lid|hosted\.lid)$/.test(jid)) throw new Error('Invalid WhatsApp mention identity');
    return `@${jid.split('@')[0]}`;
  });
}

export function assertWhatsappMentionParticipants(
  jids: string[],
  participants: Array<{ id: string; phoneNumber?: string; lid?: string }>,
): void {
  const allowed = new Set(
    participants.flatMap((p) => [p.id, p.phoneNumber, p.lid].filter(Boolean).map(normalizeWhatsappJid)),
  );
  if (jids.some((jid) => !/^\d+@(s\.whatsapp\.net|lid|hosted\.lid)$/.test(jid) || !allowed.has(jid))) {
    throw new Error('WhatsApp mention is not a current group participant');
  }
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
  const formatted = text || '';
  const replacements = new Map<string, string>();
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

    const tokens = [
      ...new Set(
        [jid.split('@')[0], participant.id.split('@')[0], participant.phone].filter((v) => /^\d+$/.test(v || '')),
      ),
    ];
    const name = participant.name?.trim() || participant.phone || 'WhatsApp participant';
    const display = `@${name}`;
    const participantId = normalizeWhatsappJid(participant.id);
    const markup = `[${display}](mention://whatsapp/${encodeURIComponent(participantId)}/${encodeURIComponent(name)})`;
    for (const token of tokens) replacements.set(token, markup);
  }

  if (!replacements.size) return formatted;
  return formatted.replace(
    new RegExp(`@(${[...replacements.keys()].join('|')})(?![\\d@])`, 'g'),
    (_match, token) => replacements.get(token)!,
  );
}

export function buildWhatsappGroupParticipantSnapshots(
  participants: Array<{ id?: string; name?: string | null; phoneNumber?: string | null; imgUrl?: string | null }>,
): WhatsappGroupParticipantSnapshot[] {
  return participants.flatMap((participant) => {
    const id = normalizeWhatsappJid(participant.id || '');
    if (!id) return [];
    const phone = participant.phoneNumber
      ? normalizeWhatsappJid(participant.phoneNumber).split('@')[0]
      : id.endsWith('@s.whatsapp.net')
        ? id.split('@')[0]
        : undefined;
    const snapshot: WhatsappGroupParticipantSnapshot = {
      id,
      name: participant.name?.trim() || phone || 'WhatsApp participant',
      ...(phone ? { phone } : {}),
    };
    return [snapshot];
  });
}
