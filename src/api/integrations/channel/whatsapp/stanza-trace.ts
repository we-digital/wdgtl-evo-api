import { createHash } from 'node:crypto';

/**
 * Diagnostic trace for the 50-minute `<stream:error><ack class="status"/>` reconnects
 * (2026-11-20). Logging only: it never sends, acks, delays or changes a stanza.
 *
 * - Inbound: stanza heads (tag, type, class, id, hashed JIDs, offline flag, child tags),
 *   never content.
 * - Outbound: the acks and receipts Baileys reports through its own debug log lines
 *   ("sent ack", "sending receipt for messages"), seen through a logger proxy that keeps
 *   the configured level, so no trace/debug branch inside Baileys changes behaviour.
 * - On a stream error that names an ack id, the history of that id is logged.
 *
 * Bounded memory: at most MAX_IDS ids per instance, oldest evicted first.
 */
export type StanzaTraceEntry = {
  at: number;
  dir: 'in' | 'ack' | 'receipt';
  tag?: string;
  type?: string;
  cls?: string;
  error?: string;
  from?: string;
  participant?: string;
  recipient?: string;
  offline?: boolean;
  children?: string;
};

const MAX_IDS = 20_000;
const MAX_ENTRIES_PER_ID = 8;
// High-volume stanzas that cannot be the subject of a status ack.
const SKIP_TAGS = new Set(['iq', 'ib', 'presence', 'chatstate', 'xmlstreamend']);

export function hashJid(jid: unknown): string | undefined {
  if (typeof jid !== 'string' || !jid) return undefined;
  const at = jid.indexOf('@');
  // Server addresses (s.whatsapp.net, g.us without a user) and status@broadcast are not personal.
  if (at < 0 || jid === 'status@broadcast') return jid;
  const user = jid.slice(0, at);
  return createHash('sha256').update(user).digest('hex').slice(0, 10) + jid.slice(at);
}

function childTags(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const tags = content
    .slice(0, 6)
    .map((child: any) =>
      child && typeof child.tag === 'string' ? child.tag + (child.attrs?.type ? ':' + child.attrs.type : '') : null,
    )
    .filter(Boolean);
  return tags.length ? tags.join(',') : undefined;
}

export class StanzaTrace {
  private readonly ids = new Map<string, StanzaTraceEntry[]>();
  private readonly counts = new Map<string, number>();
  private windowStartedAt = Date.now();

  constructor(
    private readonly instanceName: string,
    private readonly emit: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private record(id: unknown, entry: StanzaTraceEntry) {
    if (typeof id !== 'string' || !id || id.length > 128) return;
    let list = this.ids.get(id);
    if (!list) {
      if (this.ids.size >= MAX_IDS) this.ids.delete(this.ids.keys().next().value);
      list = [];
      this.ids.set(id, list);
    }
    if (list.length < MAX_ENTRIES_PER_ID) list.push(entry);
  }

  private count(key: string) {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** ws 'frame' listener: every inbound stanza, before Baileys' own handlers. */
  inbound(frame: any) {
    try {
      if (!frame || typeof frame.tag !== 'string' || SKIP_TAGS.has(frame.tag)) return;
      const attrs = frame.attrs ?? {};
      const statusRelated = attrs.from === 'status@broadcast' || attrs.class === 'status' || frame.tag === 'status';
      this.count(`${frame.tag}${attrs.type ? ':' + attrs.type : ''}${statusRelated ? ':status' : ''}`);
      this.record(attrs.id, {
        at: this.now(),
        dir: 'in',
        tag: frame.tag,
        type: attrs.type,
        cls: attrs.class,
        from: hashJid(attrs.from),
        participant: hashJid(attrs.participant),
        recipient: hashJid(attrs.recipient),
        offline: attrs.offline !== undefined ? true : undefined,
        children: childTags(frame.content),
      });
    } catch {
      // diagnostics never break the socket
    }
  }

  /** Baileys debug log arguments, seen through the logger proxy. */
  baileysDebug(args: unknown[]) {
    try {
      const [obj, msg] = args as [any, any];
      if (msg === 'sent ack' && obj?.sent) {
        const sent = obj.sent;
        this.record(sent.id, {
          at: this.now(),
          dir: 'ack',
          tag: obj.recv?.tag,
          type: sent.type,
          cls: sent.class,
          error: sent.error,
          from: hashJid(sent.to),
          participant: hashJid(sent.participant),
        });
      } else if (msg === 'sending receipt for messages' && obj?.attrs) {
        const attrs = obj.attrs;
        for (const id of Array.isArray(obj.messageIds) ? obj.messageIds.slice(0, 20) : [attrs.id])
          this.record(id, {
            at: this.now(),
            dir: 'receipt',
            type: attrs.type ?? 'delivery',
            from: hashJid(attrs.to),
            participant: hashJid(attrs.participant),
            recipient: hashJid(attrs.recipient),
          });
      }
    } catch {
      // diagnostics never break the socket
    }
  }

  /** ws 'CB:stream:error' listener. */
  streamError(node: any) {
    try {
      const children = Array.isArray(node?.content) ? node.content : [];
      for (const child of children) {
        const attrs = child?.attrs ?? {};
        const id = attrs.id;
        const history = (typeof id === 'string' && this.ids.get(id)) || [];
        const first = history[0]?.at;
        this.emit(
          JSON.stringify({
            event: 'stanza_trace_stream_error',
            instance: this.instanceName,
            reason: { tag: child?.tag, cls: attrs.class, type: attrs.type, id },
            seenBeforeMs: first ? this.now() - first : null,
            history: history.map((entry) => ({ ...entry, at: undefined, agoMs: this.now() - entry.at })),
          }),
        );
      }
    } catch {
      // diagnostics never break the socket
    }
  }

  /** 10-minute counts of inbound stanza kinds; status-related ones are tagged ':status'. */
  report() {
    const counts = Object.fromEntries([...this.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30));
    this.emit(
      JSON.stringify({
        event: 'stanza_trace_counts',
        instance: this.instanceName,
        windowMs: this.now() - this.windowStartedAt,
        trackedIds: this.ids.size,
        counts,
      }),
    );
    this.counts.clear();
    this.windowStartedAt = this.now();
  }
}

/**
 * Logger proxy for Baileys: every call reaches the real logger unchanged (same level,
 * same output); debug calls are also shown to `onDebug`. `child()` stays proxied.
 */
export function traceBaileysLogger<T extends object>(logger: T, onDebug: (args: unknown[]) => void): T {
  return new Proxy(logger, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'debug' && typeof value === 'function')
        return (...args: unknown[]) => {
          onDebug(args);
          return value.apply(target, args);
        };
      if (property === 'child' && typeof value === 'function')
        return (...args: unknown[]) => traceBaileysLogger(value.apply(target, args), onDebug);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
