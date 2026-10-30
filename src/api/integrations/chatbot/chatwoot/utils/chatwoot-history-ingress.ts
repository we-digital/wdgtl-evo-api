import { InboundDelivery, inboundDeliveryId } from './chatwoot-inbound-queue';

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
      const stored = await tx.message.findMany({
        where: {
          instanceId,
          OR: batch.map(({ key }) => ({
            AND: [
              { key: { path: ['id'], equals: key.id } },
              { key: { path: ['remoteJid'], equals: key.remoteJid } },
              { key: { path: ['fromMe'], equals: key.fromMe } },
            ],
          })),
        },
        select: { key: true },
        take: HISTORY_INGRESS_BATCH_SIZE * 3 + 1,
      });
      if (stored.length > HISTORY_INGRESS_BATCH_SIZE * 3) throw new Error('InboundNativeSourceAmbiguous');
      const known = new Set(stored.map((message) => inboundDeliveryId(instanceId, message)));
      const fresh = batch.filter((message) => {
        const identity = inboundDeliveryId(instanceId, message);
        if (known.has(identity)) return false;
        known.add(identity);
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

export function ignoresHistoryPeer(provider: { ignoreJids?: unknown }, message: any, groupsIgnore = false): boolean {
  const peers = [message.key?.remoteJid, message.key?.remoteJidAlt].filter(
    (peer): peer is string => typeof peer === 'string',
  );
  const ignored = Array.isArray(provider.ignoreJids) ? provider.ignoreJids : [];
  return peers.some(
    (peer) =>
      peer === '0@s.whatsapp.net' ||
      peer.endsWith('@broadcast') ||
      (groupsIgnore && peer.endsWith('@g.us')) ||
      ignored.some((jid) => peer === jid || ((jid === '@g.us' || jid === '@s.whatsapp.net') && peer.endsWith(jid))),
  );
}
