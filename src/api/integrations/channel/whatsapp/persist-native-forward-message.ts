type NativeForwardMessageRepository = {
  message: {
    findFirst: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<unknown>;
  };
};

export const persistNativeForwardMessage = async ({
  repository,
  instanceId,
  messageRaw,
}: {
  repository: NativeForwardMessageRepository;
  instanceId: string;
  messageRaw: any;
}): Promise<unknown> => {
  const keyId = String(messageRaw?.key?.id || '').trim();
  if (!keyId) throw new Error('Native forward returned empty message key');

  const where = {
    instanceId,
    key: { path: ['id'], equals: keyId },
  };
  const existing = await repository.message.findFirst({ where });
  if (existing) return existing;

  try {
    return await repository.message.create({ data: messageRaw });
  } catch (error) {
    const concurrent = await repository.message.findFirst({ where });
    if (concurrent) return concurrent;
    throw error;
  }
};
