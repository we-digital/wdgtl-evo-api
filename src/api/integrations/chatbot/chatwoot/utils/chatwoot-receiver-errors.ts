// Receiver proof classes that, for an owner already present before this
// attempt, mean "present but unverifiable" rather than "retry".
export const inboundPresentUnverifiedClasses = new Set([
  'InboundReceiverContentChanged',
  'InboundReceiverPayloadUnconfirmed',
  'InboundReceiverMediaUnconfirmed',
  'InboundHistorySourceUnconfirmed',
  'InboundHistorySourceChanged',
  'InboundHistoryBytesInvalid',
  'InboundHistoryLocatorInvalid',
  'InboundHistoryIdentityUnconfirmed',
]);

// Status and Chatwoot error code only; response bodies can carry personal data.
export function chatwootErrorFields(error: any): Record<string, unknown> {
  const status = Number(error?.response?.status);
  const code = error?.response?.data?.error;
  return {
    errorClass: error?.name || 'Error',
    ...(Number.isSafeInteger(status) && status > 0 ? { status } : {}),
    ...(typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? { code } : {}),
    ...(typeof error?.code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(error.code) ? { networkCode: error.code } : {}),
  };
}

// An HTTP outcome of the receiver POST as a ledger error class.
export function inboundReceiverHttpError(error: any): Error | null {
  if (!error?.isAxiosError && error?.name !== 'AxiosError') return null;
  const status = Number(error?.response?.status);
  const code = error?.response?.data?.error;
  if (status === 409 && code === 'whatsapp_source_conflict') return new Error('InboundReceiverSourceConflict');
  if (status === 409) return new Error('InboundReceiverConflict');
  if (status === 422) return new Error('InboundReceiverRejected');
  if (status === 401 || status === 403 || status === 404) return new Error('InboundReceiverRefused');
  if (status >= 500) return new Error('InboundReceiverUnavailable');
  if (status === 429) return new Error('InboundReceiverThrottled');
  return new Error('InboundReceiverUnreachable');
}
