import { createHash, randomUUID } from 'node:crypto';

export type InboundPayload = Record<string, any>;
export type InboundAck = { id: number; inbox_id: number; conversation_id: number };
export interface InboundDelivery {
  id: string;
  instanceId: string;
  instanceName: string;
  providerId: string;
  providerFingerprint: string;
  accountId: number;
  inboxId: number | null;
  peer: string;
  sourceId: string;
  fromMe: boolean;
  payload: InboundPayload;
  payloadHash: string;
  state: string;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  result: InboundAck | null;
}
export interface InboundStore {
  enqueue(item: InboundDelivery): Promise<InboundDelivery>;
  due(now: Date, limit: number): Promise<InboundDelivery[]>;
  claim(id: string, owner: string, now: Date, until: Date): Promise<boolean>;
  renew(id: string, owner: string, until: Date): Promise<boolean>;
  finish(id: string, owner: string, ack: InboundAck): Promise<boolean>;
  defer(id: string, owner: string, errorClass: string, until: Date): Promise<void>;
}

// Hash only native source fields; CW back-pointers and delivery receipts are not source content.
export function inboundPayloadHash(body: InboundPayload): string {
  const source = Object.fromEntries(
    ['key', 'message', 'messageType', 'messageTimestamp', 'contextInfo', 'participant', 'pushName'].map((k) => [
      k,
      body[k] ?? null,
    ]),
  );
  const stable = (v: any): any =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(source)))
    .digest('hex');
}
export function inboundDeliveryId(instanceId: string, body: InboundPayload): string {
  const { id, remoteJid, fromMe } = body.key ?? {};
  if (
    !instanceId ||
    typeof id !== 'string' ||
    !id ||
    id.length > 100 ||
    typeof remoteJid !== 'string' ||
    remoteJid.length > 100 ||
    typeof fromMe !== 'boolean'
  )
    throw new Error('InboundIdentityUnavailable');
  return createHash('sha256')
    .update(JSON.stringify([instanceId, remoteJid, id, fromMe]))
    .digest('hex');
}

export class ChatwootInboundQueue {
  private readonly owner = randomUUID();
  private readonly active = new Map<string, Promise<InboundAck | undefined>>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private polling = false;
  constructor(
    private readonly store: InboundStore,
    private readonly deliver: (item: InboundDelivery) => Promise<InboundAck>,
    private readonly observe: (event: string, fields: Record<string, unknown>) => void = () => {},
    private readonly retryMs = 20_000,
    private readonly leaseMs = 120_000,
    private readonly now = () => new Date(),
  ) {}

  async submit(item: InboundDelivery): Promise<InboundAck | undefined> {
    // The database commit precedes all receiver reads/writes; no in-memory retry receipt substitutes for it.
    const stored = await this.store.enqueue(item);
    if (stored.state === 'confirmed') return stored.result ?? undefined;
    return this.attempt(stored);
  }
  start() {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(
      () =>
        void this.poll().catch((e) => this.observe('chatwoot_inbound_poll_failed', { errorClass: e?.name || 'Error' })),
      1_000,
    );
    this.timer.unref?.();
    void this.poll().catch((e) => this.observe('chatwoot_inbound_poll_failed', { errorClass: e?.name || 'Error' }));
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.active.values()]);
  }
  async poll() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const items = await this.store.due(this.now(), 8);
      // Two receiver writers globally, with the existing exact-source fence inside each delivery.
      for (let i = 0; i < items.length && !this.stopped; i += 2)
        await Promise.all(items.slice(i, i + 2).map((item) => this.attempt(item)));
    } finally {
      this.polling = false;
    }
  }
  private attempt(item: InboundDelivery): Promise<InboundAck | undefined> {
    const known = this.active.get(item.id);
    if (known) return known;
    const work = this.perform(item).finally(() => this.active.delete(item.id));
    this.active.set(item.id, work);
    return work;
  }
  private async perform(item: InboundDelivery): Promise<InboundAck | undefined> {
    const now = this.now();
    if (this.stopped || !(await this.store.claim(item.id, this.owner, now, new Date(now.getTime() + this.leaseMs))))
      return;
    let lost = false;
    let renewing = false;
    const heartbeat = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        void this.store
          .renew(item.id, this.owner, new Date(this.now().getTime() + this.leaseMs))
          .then((ok) => {
            if (!ok) lost = true;
          })
          .catch(() => {
            lost = true;
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(10, Math.floor(this.leaseMs / 4)),
    );
    heartbeat.unref?.();
    try {
      const ack = await this.deliver({ ...item, leaseOwner: this.owner });
      if (
        lost ||
        !Number.isSafeInteger(ack?.id) ||
        ack.id <= 0 ||
        !Number.isSafeInteger(ack.inbox_id) ||
        ack.inbox_id <= 0 ||
        !Number.isSafeInteger(ack.conversation_id) ||
        ack.conversation_id <= 0
      )
        throw new Error('InboundReceiverOutcomeUnconfirmed');
      if (!(await this.store.finish(item.id, this.owner, ack))) throw new Error('InboundReceiptLeaseLost');
      this.observe('chatwoot_inbound_confirmed', {
        instanceId: item.instanceId,
        inboxId: ack.inbox_id,
        destinationId: ack.id,
      });
      return ack;
    } catch (error) {
      // Unknown HTTP outcomes remain pending. The next attempt MUST read exact receiver owners before POST.
      await this.store.defer(
        item.id,
        this.owner,
        error instanceof Error && /^Inbound[A-Za-z]+$/.test(error.message)
          ? error.message
          : error instanceof Error
            ? error.name
            : 'Error',
        new Date(this.now().getTime() + this.retryMs),
      );
      this.observe('chatwoot_inbound_pending', {
        instanceId: item.instanceId,
        errorClass: error instanceof Error ? error.name : 'Error',
      });
      return;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
