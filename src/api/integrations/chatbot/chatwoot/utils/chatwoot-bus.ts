// Provider event bus (NATS JetStream) between EVO and Chatwoot.
//
// EVO's durable ledger stays the source of truth. A bus-enabled instance hands
// a ledger row to the bus as one envelope instead of five HTTP calls; Chatwoot
// applies it in-process and reports the outcome on cw.evt.*, which confirms
// (or fails) the ledger row. Unconfirmed rows are republished by the normal
// ledger poller; JetStream drops a republish inside its duplicate window and
// Chatwoot treats a later one as already present (idempotent by source id).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { AckPolicy, DeliverPolicy, jetstream, JetStreamClient, jetstreamManager } from '@nats-io/jetstream';
import { credsAuthenticator, NatsConnection, NoRespondersError } from '@nats-io/nats-core';
import { ObjectStore, Objm } from '@nats-io/obj';
import { Svcm } from '@nats-io/services';
import { connect } from '@nats-io/transport-node';

export const BUS_ENVELOPE_VERSION = 1;
export const BUS_PARTITIONS = 16;
export const BUS_MEDIA_BUCKET = 'media';
export const BUS_FEEDBACK_CONSUMER = 'evo-feedback';
export const BUS_OUTBOUND_CONSUMER = 'evo-outbound';
// Sentinel returned by a delivery that was handed to the bus.
export const INBOUND_BUS_PUBLISHED = Symbol('InboundBusPublished');
// A published row waits this long for Chatwoot's outcome before the ledger
// poller republishes it (JetStream already stores it durably).
export const BUS_REPUBLISH_AFTER_MS = 10 * 60_000;
// A bus send this young, on its first attempt, skips the pre-send Chatwoot read.
export const BUS_FRESH_SEND_MAX_AGE_MS = 5_000;
export const busFreshSendEnabled = (value = process.env.CHATWOOT_BUS_FRESH_SEND): boolean => value !== 'false';

export type BusEnvelope = {
  v: number;
  event_id: string;
  provider: 'evo_whatsapp';
  kind: string;
  occurred_at: number;
  route: Record<string, unknown>;
  payload: Record<string, unknown>;
};

export type BusOutcome = {
  v: number;
  event_id: string;
  kind: string;
  outcome: 'created' | 'already_present' | 'updated' | 'ignored' | 'failed';
  error_code?: string;
  message_id?: number;
  inbox_id?: number;
  conversation_id?: number;
  contact_inbox_source_id?: string | null;
  attachments?: number;
};

export type BusMediaRef = {
  bucket: string;
  object: string;
  file_name: string;
  content_type: string;
  size: number;
  sha256: string;
};

// FNV-1a 32-bit, identical to Chatwoot's ProviderBus.partition_for.
export function busPartition(key: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % BUS_PARTITIONS;
}

export function busSubject(instanceId: string, peer: string): string {
  return `wa.in.p${String(busPartition(`${instanceId}|${peer}`)).padStart(2, '0')}.${instanceId}`;
}

// NATS creds for the bus: a file path (CHATWOOT_BUS_CREDS) or the creds content
// as base64 (CHATWOOT_BUS_CREDS_B64, how the deploy passes secrets).
export function busCreds(env = process.env): Uint8Array | null {
  if (env.CHATWOOT_BUS_CREDS) return readFileSync(env.CHATWOOT_BUS_CREDS);
  const encoded = env.CHATWOOT_BUS_CREDS_B64?.trim();
  return encoded ? new Uint8Array(Buffer.from(encoded, 'base64')) : null;
}

// Optional peer allowlist for outbound sends over the bus (canary / lab guard).
export function busOutboundPeerAllowed(
  peer: string | null | undefined,
  allowlist = process.env.CHATWOOT_BUS_OUTBOUND_PEERS || '',
) {
  const peers = allowlist
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return !peers.length || peers.includes('*') || (!!peer && peers.includes(peer));
}

export function busInstanceEnabled(
  instanceName: string,
  allowlist = process.env.CHATWOOT_BUS_INSTANCES || '',
): boolean {
  if (!process.env.CHATWOOT_BUS_URL) return false;
  const names = allowlist
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.includes('*') || names.includes(instanceName);
}

export class ChatwootBus {
  private connection: Promise<NatsConnection> | null = null;
  private js: JetStreamClient | null = null;
  private media: Promise<ObjectStore> | null = null;
  private stopped = false;

  constructor(
    private readonly url = process.env.CHATWOOT_BUS_URL || '',
    private readonly observe: (event: string, fields: Record<string, unknown>) => void = () => {},
  ) {}

  private async nc(): Promise<NatsConnection> {
    this.connection ??= connect({
      servers: this.url,
      name: 'evo',
      maxReconnectAttempts: -1,
      reconnectTimeWait: 250,
      waitOnFirstConnect: true,
      ...(busCreds() ? { authenticator: credsAuthenticator(busCreds()!) } : {}),
    }).then((nc) => {
      this.js = jetstream(nc);
      void (async () => {
        for await (const status of nc.status()) this.observe('chatwoot_bus_status', { type: status.type });
      })();
      return nc;
    });
    return this.connection;
  }

  async publish(subject: string, envelope: BusEnvelope): Promise<{ seq: number; duplicate: boolean }> {
    await this.nc();
    const ack = await this.js!.publish(subject, JSON.stringify(envelope), {
      msgID: envelope.event_id,
      timeout: 5_000,
    });
    return { seq: ack.seq, duplicate: ack.duplicate };
  }

  private async mediaStore(): Promise<ObjectStore> {
    this.media ??= this.nc().then((nc) => new Objm(nc).open(BUS_MEDIA_BUCKET));
    return this.media;
  }

  // Stores media bytes for Chatwoot to read; the object name is stable per
  // source, so a republish overwrites the same object.
  async putMedia(name: string, bytes: Buffer, fileName: string, contentType: string): Promise<BusMediaRef> {
    const store = await this.mediaStore();
    await store.putBlob({ name, description: fileName }, new Uint8Array(bytes));
    return {
      bucket: BUS_MEDIA_BUCKET,
      object: name,
      file_name: fileName,
      content_type: contentType,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  // Durable pull consumer processed strictly one message at a time in stream
  // order (per-chat order is preserved end to end). A handler error naks the
  // message for redelivery after 5 s.
  async consume(
    stream: string,
    durable: string,
    filterSubjects: string[],
    handle: (subject: string, body: any, headers: { get(key: string): string } | undefined) => Promise<void>,
  ) {
    const nc = await this.nc();
    const jsm = await jetstreamManager(nc);
    try {
      await jsm.consumers.info(stream, durable);
    } catch {
      await jsm.consumers.add(stream, {
        durable_name: durable,
        filter_subjects: filterSubjects,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        ack_wait: 60_000_000_000,
        max_ack_pending: 256,
      });
    }
    const consumer = await this.js!.consumers.get(stream, durable);
    while (!this.stopped) {
      const messages = await consumer.consume({ max_messages: 64 });
      for await (const msg of messages) {
        if (this.stopped) break;
        try {
          await handle(msg.subject, msg.json(), msg.headers as any);
          msg.ack();
        } catch (error) {
          msg.nak(5_000);
          this.observe('chatwoot_bus_consume_failed', {
            stream,
            errorClass: (error as Error)?.name || 'Error',
            detail: String((error as Error)?.message || '').slice(0, 200),
          });
        }
      }
    }
  }

  // Chatwoot's outcomes for EVO-published events.
  consumeOutcomes(handle: (status: 'ingested' | 'failed', outcome: BusOutcome) => Promise<void>) {
    return this.consume(
      'CW_EVT',
      BUS_FEEDBACK_CONSUMER,
      ['cw.evt.ingested.evo_whatsapp', 'cw.evt.failed.evo_whatsapp'],
      (subject, body) => handle(subject.split('.')[2] as 'ingested' | 'failed', body as BusOutcome),
    );
  }

  // Request/reply (NATS Services conventions): resolves the decoded reply, or
  // null when nobody serves the subject so the caller can keep its HTTP path.
  // A service error reply becomes { status, data } like an HTTP error.
  async request(subject: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: any } | null> {
    const nc = await this.nc();
    try {
      const msg = await nc.request(subject, JSON.stringify(body), { timeout: timeoutMs });
      const code = msg.headers?.get('Nats-Service-Error-Code');
      const text = msg.string();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: code ? Number(code) : 200, data };
    } catch (error) {
      const cause = (error as any)?.cause;
      if (error instanceof NoRespondersError || cause instanceof NoRespondersError) return null;
      throw error;
    }
  }

  // A NATS Services (micro) endpoint in a queue group: every EVO process can
  // answer, each request is handled once. Handler errors carrying status/body
  // are answered as service errors with the same code and JSON body.
  async serve(
    service: { name: string; version: string; description: string; queue: string },
    endpoint: string,
    subject: string,
    handle: (subject: string, body: any, headers: { get(key: string): string } | undefined) => Promise<unknown>,
  ) {
    const nc = await this.nc();
    const svc = await new Svcm(nc).add(service);
    svc.addEndpoint(endpoint, {
      subject,
      handler: (err, msg) => {
        if (err) return;
        void (async () => {
          try {
            const result = await handle(msg.subject, msg.json(), msg.headers as any);
            msg.respond(JSON.stringify(result ?? {}));
          } catch (error) {
            const e = error as any;
            const status = Number(e?.status ?? e?.response?.status) || 500;
            const data = e?.body ?? e?.response?.data ?? { error: e?.name || 'Error' };
            msg.respondError(status, String(e?.message || 'error').slice(0, 200), JSON.stringify(data));
          }
        })();
      },
    });
    return svc;
  }

  async stop() {
    this.stopped = true;
    const nc = await this.connection?.catch(() => null);
    await nc?.drain().catch(() => undefined);
  }
}
