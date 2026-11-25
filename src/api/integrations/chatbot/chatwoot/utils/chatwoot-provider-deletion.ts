/**
 * A WhatsApp delete (revoke) marks the Chatwoot message deleted first; only
 * after Chatwoot confirms is EVO's own row marked. A Chatwoot failure leaves
 * the row untouched so the next revoke delivery can retry.
 */
export async function confirmProviderDeletionBeforeMarkingLocal<T>({
  softDelete,
  markLocal,
}: {
  softDelete: () => Promise<T>;
  markLocal: () => Promise<unknown>;
}): Promise<T> {
  const result = await softDelete();
  await markLocal();
  return result;
}

/** The stored key with `deleted: true`; everything else (id, chat, direction) kept. */
export function markWhatsappKeyDeleted(key: unknown): Record<string, unknown> {
  const base = key && typeof key === 'object' && !Array.isArray(key) ? (key as Record<string, unknown>) : {};
  return { ...base, deleted: true };
}
