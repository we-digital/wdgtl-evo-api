/**
 * we:Digital (owner, 2026-11-16): who sent a fromMe WhatsApp message.
 *
 *   api     sent through this API outside Chatwoot (automation, scripts, the support orchestrator);
 *   native  sent from the phone, WhatsApp Web or another linked device.
 *
 * Chatwoot's own sends are known to Chatwoot by source id and are never asked here.
 * The id is planned and recorded BEFORE transport, so an echo or a history sync that
 * arrives first still finds it; ids live in the database, so restarts do not matter.
 */
export type FromMeOrigin = 'api' | 'native';

export interface ApiSentMessageRepository {
  apiSentMessage: {
    createMany(args: {
      data: Array<{ instanceId: string; messageId: string }>;
      skipDuplicates: true;
    }): Promise<unknown>;
    findUnique(args: {
      where: { instanceId_messageId: { instanceId: string; messageId: string } };
      select: { messageId: true };
    }): Promise<{ messageId: string } | null>;
  };
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 100 && !/\s/.test(value);

export async function recordApiSentMessage(
  repository: ApiSentMessageRepository,
  instanceId: unknown,
  messageId: unknown,
): Promise<void> {
  if (!validId(instanceId) || !validId(messageId) || !repository?.apiSentMessage) return;
  await repository.apiSentMessage.createMany({ data: [{ instanceId, messageId }], skipDuplicates: true });
}

/** Origin of a fromMe message by its WhatsApp key id; null when the id cannot be judged. */
export async function fromMeOrigin(
  repository: ApiSentMessageRepository,
  instanceId: unknown,
  messageId: unknown,
): Promise<FromMeOrigin | null> {
  if (!validId(instanceId) || !validId(messageId)) return null;
  const row = await repository.apiSentMessage.findUnique({
    where: { instanceId_messageId: { instanceId, messageId } },
    select: { messageId: true },
  });
  return row ? 'api' : 'native';
}
