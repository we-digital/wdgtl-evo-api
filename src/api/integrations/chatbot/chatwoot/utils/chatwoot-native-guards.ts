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
