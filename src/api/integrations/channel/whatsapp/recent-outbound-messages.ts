import { proto } from 'baileys';

/**
 * Messages this socket has just sent, keyed by WhatsApp message id.
 *
 * Baileys asks `getMessage` for the content of a message it must resend, for
 * example after a group ack carries a participant hash. That ack arrives a few
 * hundred milliseconds after the send, often before the row is written to the
 * database. Without this short-lived copy the resend had no content to use.
 */
export class RecentOutboundMessages {
  private readonly entries = new Map<string, { message: proto.IMessage; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  remember(sent: { key?: proto.IMessageKey | null; message?: proto.IMessage | null } | null | undefined): void {
    const id = sent?.key?.id;
    if (!id || !sent?.message) return;
    this.entries.delete(id);
    this.entries.set(id, { message: sent.message, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  get(id: string | null | undefined): proto.IMessage | undefined {
    if (!id) return undefined;
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.message;
  }
}
