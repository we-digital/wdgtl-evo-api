const DEFAULT_SUCCESS_TTL_MS = 30_000;

export const chatwootIngressDeliveryKey = (params: {
  event: unknown;
  instanceId: unknown;
  whatsappMessageId: unknown;
}): string | null => {
  if (params.event !== 'messages.upsert' && params.event !== 'send.message') return null;
  if (typeof params.instanceId !== 'string' || params.instanceId.trim().length === 0) return null;
  if (typeof params.whatsappMessageId !== 'string' || params.whatsappMessageId.trim().length === 0) return null;

  return `${params.instanceId.trim()}:${params.whatsappMessageId.trim()}`;
};

export class ChatwootIngressDeliveryFence {
  private readonly deliveries = new Map<string, Promise<unknown>>();

  constructor(private readonly successTtlMs = DEFAULT_SUCCESS_TTL_MS) {}

  run<T>(key: string, deliver: () => Promise<T>): Promise<T> {
    const existing = this.deliveries.get(key);
    if (existing) return existing as Promise<T>;

    const delivery = Promise.resolve()
      .then(deliver)
      .then((result) => {
        const timer = setTimeout(() => {
          if (this.deliveries.get(key) === delivery) this.deliveries.delete(key);
        }, this.successTtlMs);
        timer.unref?.();
        return result;
      })
      .catch((error) => {
        if (this.deliveries.get(key) === delivery) this.deliveries.delete(key);
        throw error;
      });

    this.deliveries.set(key, delivery);
    return delivery;
  }
}
