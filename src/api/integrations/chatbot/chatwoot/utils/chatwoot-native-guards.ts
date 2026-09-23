export const isAmbiguousNativeForwardError = (errorMessage: string): boolean =>
  /timeout|timed?\s*out|ECONNRESET|socket|abort|network/i.test(errorMessage);

export const isUsableArchiveMessageKey = (messageKeyId: string | null | undefined): boolean => {
  const id = String(messageKeyId || '');
  return Boolean(id) && !id.startsWith('archive-stub-');
};

export const shouldAttemptNativeForward = (forwardedFrom: Record<string, unknown> | null | undefined): boolean => {
  if (!forwardedFrom) return false;
  if (forwardedFrom.delivery_mode !== undefined) return forwardedFrom.delivery_mode === 'native_forward';

  return forwardedFrom.same_inbox !== false;
};

/**
 * Archive/unarchive must target the same JID as the stored last message.
 * Chatwoot often sends a phone PN while local history lives under `@lid` (or vice versa);
 * mismatching them makes WhatsApp reject or no-op the archive patch.
 */
export const resolveArchiveChatJid = (params: {
  chat?: string | null;
  lastMessageRemoteJid?: string | null;
}): string | null => {
  const fromMessage = typeof params.lastMessageRemoteJid === 'string' ? params.lastMessageRemoteJid.trim() : '';
  if (fromMessage) return fromMessage;
  const fromChat = typeof params.chat === 'string' ? params.chat.trim() : '';
  return fromChat || null;
};

/** Prefer contact_inbox source_id, then sender identifier / phone for native chat probes. */
export const resolveNativeChatProbeId = (body: any, fallback = ''): string => {
  const candidates = [
    body?.contact_inbox?.source_id,
    body?.meta?.sender?.identifier,
    typeof body?.meta?.sender?.phone_number === 'string'
      ? body.meta.sender.phone_number.replace(/^\+/, '')
      : null,
    body?.conversation?.contact_inbox?.source_id,
    body?.conversation?.meta?.sender?.identifier,
    typeof body?.conversation?.meta?.sender?.phone_number === 'string'
      ? body.conversation.meta.sender.phone_number.replace(/^\+/, '')
      : null,
    fallback,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() && value.trim() !== '123456') {
      return value.trim();
    }
  }
  return '';
};
