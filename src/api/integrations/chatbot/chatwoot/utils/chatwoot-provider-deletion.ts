export async function confirmProviderDeletionBeforeDroppingMapping<T>({
  softDelete,
  dropMapping,
}: {
  softDelete: () => Promise<T>;
  dropMapping: () => Promise<unknown>;
}): Promise<T> {
  const result = await softDelete();
  await dropMapping();
  return result;
}
