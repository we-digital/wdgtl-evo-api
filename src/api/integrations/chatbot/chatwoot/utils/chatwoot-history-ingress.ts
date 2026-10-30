import { InboundDelivery } from './chatwoot-inbound-queue';
import { findStoredHistoryIds } from './history-memory-budget';

export const HISTORY_INGRESS_BATCH_SIZE = 50;

// Source and delivery intent commit together. Only the received IDs are queried;
// retries reuse the native source and the live queue's exact identity fence.
export async function persistHistoryIngress(
  repository: any,
  instanceId: string,
  messages: any[],
  delivery: (message: any) => InboundDelivery | null,
): Promise<any[]> {
  const created: any[] = [];
  for (let offset = 0; offset < messages.length; offset += HISTORY_INGRESS_BATCH_SIZE) {
    const batch = messages.slice(offset, offset + HISTORY_INGRESS_BATCH_SIZE);
    const saved = await repository.$transaction(async (tx: any) => {
      const known = await findStoredHistoryIds(
        tx.message,
        instanceId,
        batch.map((message) => message.key?.id),
      );
      const fresh = batch.filter((message) => {
        if (known.has(message.key.id)) return false;
        known.add(message.key.id);
        return true;
      });
      if (fresh.length) await tx.message.createMany({ data: fresh, skipDuplicates: true });
      const intents = batch.map(delivery).filter((item): item is InboundDelivery => item !== null);
      if (intents.length) await tx.chatwootInboundDelivery.createMany({ data: intents, skipDuplicates: true });
      return fresh;
    });
    created.push(...saved);
  }
  return created;
}
