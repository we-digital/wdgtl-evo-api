export const isAmbiguousNativeForwardError = (errorMessage: string): boolean =>
  /timeout|timed?\s*out|ECONNRESET|socket|abort|network/i.test(errorMessage);

export const isUsableArchiveMessageKey = (messageKeyId: string | null | undefined): boolean => {
  const id = String(messageKeyId || '');
  return Boolean(id) && !id.startsWith('archive-stub-');
};
