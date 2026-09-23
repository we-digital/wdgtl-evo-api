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

/** Extract Baileys message key id from Chatwoot source_id (`WAID:…`). */
export const whatsappIdFromSourceId = (sourceId: unknown): string | null => {
  if (typeof sourceId !== 'string') return null;
  const trimmed = sourceId.trim();
  if (!trimmed.startsWith('WAID:')) return null;
  const id = trimmed.slice('WAID:'.length).trim();
  return id || null;
};
