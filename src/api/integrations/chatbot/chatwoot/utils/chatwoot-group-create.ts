/**
 * "Create group" from Chatwoot (contract v1, create-group-contract-20261115.md).
 *
 * Chatwoot sends `group_create_request` over the provider RPC (NATS
 * rpc.evo.<instance>.webhook, signed HTTP fallback) and polls
 * `group_create_status` when the reply is uncertain. This module holds the
 * WhatsApp flow behind injected dependencies, so tests drive it with a fake
 * Baileys socket:
 *
 *   onWhatsApp → groupCreate(subject, [first reachable]) → Chatwoot group
 *   conversation → add the others one at a time (~300 ms apart) → promote the
 *   colleagues → picture → invite code when anyone was skipped.
 *
 * Once groupCreate succeeded every later step only degrades its own field.
 * The reply is `ok` with the Chatwoot conversation; when that conversation
 * could not be resolved yet the request stays `in_progress` (HTTP 200) and the
 * next `group_create_status` finishes it. Before groupCreate an error means
 * nothing was created, except an uncertain groupCreate (timeout, dropped
 * socket), which stays `in_progress` so Chatwoot's status checks end in
 * `unknown` and staff look at the phone instead of a second group being made.
 */

export const GROUP_CREATE_MAX_INVITEES = 20;
export const GROUP_CREATE_MAX_SUBJECT = 100;
// 256 KB of JPEG as base64, plus a little slack for padding.
export const GROUP_CREATE_MAX_PICTURE_BASE64 = Math.ceil((256 * 1024 * 4) / 3) + 16;
export const GROUP_CREATE_TTL_SECONDS = 24 * 60 * 60;
export const GROUP_CREATE_ADD_PAUSE_MS = 300;

export type GroupCreateErrorCode =
  | 'group_create_disabled'
  | 'invalid_request'
  | 'not_connected'
  | 'allowlist_deployment'
  | 'in_progress'
  | 'no_reachable_invitees'
  | 'create_failed';

export type GroupCreateReason =
  | 'privacy'
  | 'not_on_whatsapp'
  | 'no_phone'
  | 'left_recently'
  | 'already_member'
  | 'blocked'
  | 'resolve_failed'
  | 'rate_limited'
  | 'failed';

export type GroupCreateInvitee = { key: string; jid: string | null; admin: boolean };

export type GroupCreateRequest = {
  requestId: string;
  accountId: number;
  inboxId: number;
  subject: string;
  picture: { mime: string; base64: string } | null;
  invitees: GroupCreateInvitee[];
};

export type GroupCreateInviteeOutcome = {
  key: string;
  outcome: 'added' | 'skipped';
  reason: GroupCreateReason | null;
  admin: 'promoted' | 'failed' | null;
};

export type GroupCreateOkReply = {
  status: 'ok';
  action: 'group_created_whatsapp';
  request_id: string;
  group_peer: string;
  conversation: { id: number; database_id: number } | null;
  invite_link: string | null;
  picture: 'set' | 'failed' | 'none';
  invitees: GroupCreateInviteeOutcome[];
};

export type GroupCreateErrorReply = { status: 'error'; code: GroupCreateErrorCode };
export type GroupCreateFinalReply = GroupCreateOkReply | GroupCreateErrorReply;
/** Answered with HTTP 200 / a normal bus reply: the outcome follows on group_create_status. */
export type GroupCreateInProgressReply = { status: 'in_progress' };
/** A created group whose Chatwoot conversation is still to be resolved. */
export type GroupCreatePending = { reply: GroupCreateOkReply; subject: string };
export type GroupCreateStored = GroupCreateFinalReply | { status: 'in_progress'; pending?: GroupCreatePending };

const HTTP_STATUS: Record<GroupCreateErrorCode, number> = {
  group_create_disabled: 403,
  allowlist_deployment: 403,
  invalid_request: 400,
  not_connected: 409,
  in_progress: 409,
  no_reachable_invitees: 422,
  create_failed: 422,
};

/**
 * A rejection the provider bus answers as a service error. The message is the
 * bare code so Chatwoot's "provider rpc <status>: <code>" parse finds it; the
 * HTTP path answers the same status.
 */
export class GroupCreateError extends Error {
  readonly status: number;
  readonly body: GroupCreateErrorReply;

  constructor(readonly code: GroupCreateErrorCode) {
    super(code);
    this.name = 'GroupCreateError';
    this.status = HTTP_STATUS[code];
    this.body = { status: 'error', code };
  }
}

/** "" = off, "*" = every instance, otherwise instance names or ids. */
export function groupCreateInstanceEnabled(
  instance: { instanceName?: string; instanceId?: string },
  list = process.env.CHATWOOT_GROUP_CREATE_INSTANCES || '',
): boolean {
  const entries = list
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!entries.length) return false;
  return (
    entries.includes('*') ||
    (!!instance.instanceName && entries.includes(instance.instanceName)) ||
    (!!instance.instanceId && entries.includes(instance.instanceId))
  );
}

/** A canary / lab deployment restricted to listed peers cannot take a new group. */
export function groupCreatePeerAllowlistActive(allowlist = process.env.CHATWOOT_BUS_OUTBOUND_PEERS || ''): boolean {
  const peers = allowlist
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return peers.length > 0 && !peers.includes('*');
}

export const groupCreateStoreKey = (instanceId: string, requestId: string) => `group_create:${instanceId}:${requestId}`;

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;
const PHONE_JID = /^([1-9]\d{4,19})(?::\d+)?@s\.whatsapp\.net$/;

const positiveId = (value: unknown) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** Bare LID JID, device suffix dropped; anything else is null. */
export function bareWhatsappLid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{5,24})(?::\d+)?@lid$/.exec(value.trim());
  return match ? `${match[1]}@lid` : null;
}

/** Bare phone JID, device suffix dropped; anything else (LID, group, junk) is null. */
export function bareWhatsappPhoneJid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = PHONE_JID.exec(value.trim());
  return match ? `${match[1]}@s.whatsapp.net` : null;
}

export function parseGroupStatusRequest(body: any): { requestId: string } {
  const requestId = body?.request_id;
  if (body?.v !== 1 || typeof requestId !== 'string' || !REQUEST_ID.test(requestId))
    throw new GroupCreateError('invalid_request');
  return { requestId };
}

export function parseGroupCreateRequest(body: any): GroupCreateRequest {
  const { requestId } = parseGroupStatusRequest(body);
  const accountId = positiveId(body?.account?.id);
  const inboxId = positiveId(body?.inbox?.id);
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const subjectLength = [...subject].length;
  if (!accountId || !inboxId || subjectLength < 1 || subjectLength > GROUP_CREATE_MAX_SUBJECT)
    throw new GroupCreateError('invalid_request');

  let picture: GroupCreateRequest['picture'] = null;
  if (body.picture !== null && body.picture !== undefined) {
    const { mime, base64 } = body.picture ?? {};
    if (
      typeof mime !== 'string' ||
      !/^image\/(jpeg|png)$/.test(mime) ||
      typeof base64 !== 'string' ||
      !base64.length ||
      base64.length > GROUP_CREATE_MAX_PICTURE_BASE64 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    )
      throw new GroupCreateError('invalid_request');
    picture = { mime, base64 };
  }

  if (!Array.isArray(body.invitees) || body.invitees.length > GROUP_CREATE_MAX_INVITEES)
    throw new GroupCreateError('invalid_request');
  const keys = new Set<string>();
  const invitees = body.invitees.map((invitee: any) => {
    const key = invitee?.key;
    if (typeof key !== 'string' || !key.length || key.length > 64 || keys.has(key))
      throw new GroupCreateError('invalid_request');
    keys.add(key);
    if (invitee.jid !== null && invitee.jid !== undefined && typeof invitee.jid !== 'string')
      throw new GroupCreateError('invalid_request');
    return { key, jid: invitee.jid ?? null, admin: invitee.admin === true };
  });
  return { requestId, accountId, inboxId, subject, picture, invitees };
}

/** Per-participant status of a w:g2 add (whatsmeow / Baileys `error` attribute). */
export function groupAddOutcome(status: unknown): { outcome: 'added' | 'skipped'; reason: GroupCreateReason | null } {
  switch (String(status ?? '')) {
    case '200':
      return { outcome: 'added', reason: null };
    case '409':
      return { outcome: 'skipped', reason: 'already_member' };
    case '403':
      return { outcome: 'skipped', reason: 'privacy' };
    case '408':
      return { outcome: 'skipped', reason: 'left_recently' };
    case '401':
      return { outcome: 'skipped', reason: 'blocked' };
    case '404':
      return { outcome: 'skipped', reason: 'not_on_whatsapp' };
    case '429':
      return { outcome: 'skipped', reason: 'rate_limited' };
    default:
      return { outcome: 'skipped', reason: 'failed' };
  }
}

/** The subset of the Baileys socket the flow uses. */
export type GroupCreateSocket = {
  onWhatsApp(...jids: string[]): Promise<{ jid: string; exists: boolean | unknown; lid?: unknown }[] | undefined>;
  groupCreate(subject: string, participants: string[]): Promise<{ id: string; participants?: GroupParticipant[] }>;
  groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: 'add' | 'promote',
  ): Promise<{ status: string; jid?: string; content?: any }[]>;
  updateProfilePicture(jid: string, content: Buffer): Promise<unknown>;
  groupInviteCode(jid: string): Promise<string | undefined>;
};

export type GroupParticipant = { id?: string; jid?: string; phoneNumber?: string; lid?: string };

export type GroupCreateDeps = {
  socket: GroupCreateSocket;
  /** Signal LID → PN mapping (WhatsAppBaileysService.resolvePhoneJidForLid). */
  resolvePhoneJidForLid(lid: string): Promise<string | null>;
  /** The Chatwoot group contact and canonical conversation, without an inbound body. */
  ensureConversation(groupJid: string, subject: string): Promise<{ id: number; database_id: number }>;
  /** Best effort after the reply is built (participant roster sync). */
  afterCreate?(groupJid: string, conversationId: number | null): void;
  sleep(ms: number): Promise<void>;
  log(event: string, fields: Record<string, unknown>): void;
  pauseMs?: number;
  conversationAttempts?: number;
  /** The creating account (bare phone JID and LID): it owns the group and is never invited. */
  selfJids?: string[];
};

const errorStatus = (error: any): number | null => {
  const status = Number(error?.output?.statusCode ?? error?.data?.statusCode ?? error?.status);
  return Number.isFinite(status) && status > 0 ? status : null;
};

/**
 * True when the server definitely refused the IQ (an error stanza with a 4xx
 * code). A timeout (408 from Baileys' query wrapper), a closed socket (428) or
 * anything without a status leaves it open whether the group exists.
 */
function definiteRefusal(error: any): boolean {
  const status = errorStatus(error);
  if (status === null || status === 408 || status === 428) return false;
  return status >= 400 && status < 500;
}

/**
 * Whether a participant entry returned by WhatsApp (PN or LID addressed) is
 * the requested phone JID. LID entries match through their phoneNumber
 * attribute, else through the local Signal LID mapping.
 */
export async function participantMatches(
  requestedPhoneJid: string,
  participant: GroupParticipant | string | undefined,
  resolvePhoneJidForLid: (lid: string) => Promise<string | null>,
): Promise<boolean> {
  if (!participant) return false;
  const entry = typeof participant === 'string' ? { id: participant } : participant;
  const id = entry.id ?? entry.jid;
  if (bareWhatsappPhoneJid(id) === requestedPhoneJid) return true;
  if (bareWhatsappPhoneJid(entry.phoneNumber) === requestedPhoneJid) return true;
  if (typeof id === 'string' && /@lid$/.test(id)) {
    const phone = await resolvePhoneJidForLid(id.replace(/:\d+@/, '@')).catch(() => null);
    if (bareWhatsappPhoneJid(phone) === requestedPhoneJid) return true;
  }
  return false;
}

export async function runGroupCreate(request: GroupCreateRequest, deps: GroupCreateDeps): Promise<GroupCreateOkReply> {
  const { socket } = deps;
  const pauseMs = deps.pauseMs ?? GROUP_CREATE_ADD_PAUSE_MS;
  const outcomes = new Map<string, GroupCreateInviteeOutcome>();
  const skip = (key: string, reason: GroupCreateReason) =>
    outcomes.set(key, { key, outcome: 'skipped', reason, admin: null });

  const ownKeys = new Set<string>();
  const self = new Set(
    (deps.selfJids ?? [])
      .map((jid) => bareWhatsappPhoneJid(jid) ?? bareWhatsappLid(jid))
      .filter((jid): jid is string => !!jid),
  );
  // One entry per distinct phone JID; repeated JIDs copy the first outcome.
  const byJid = new Map<string, GroupCreateInvitee[]>();
  for (const invitee of request.invitees) {
    let jid = bareWhatsappPhoneJid(invitee.jid);
    const lid = jid ? null : bareWhatsappLid(invitee.jid);
    if (lid && self.has(lid)) jid = lid;
    else if (lid) {
      // A contact stored by LID: invite its phone JID from the Signal mapping.
      jid = bareWhatsappPhoneJid(await deps.resolvePhoneJidForLid(lid).catch(() => null));
      if (!jid) {
        skip(invitee.key, 'resolve_failed');
        continue;
      }
    }
    if (!jid) {
      skip(invitee.key, 'no_phone');
      continue;
    }
    // The creating account owns the group: never invited, and left out of invitees[].
    if (self.has(jid)) {
      ownKeys.add(invitee.key);
      continue;
    }
    byJid.set(jid, [...(byJid.get(jid) ?? []), invitee]);
  }

  const reachable: string[] = [];
  if (byJid.size) {
    let found: Awaited<ReturnType<GroupCreateSocket['onWhatsApp']>>;
    try {
      found = await socket.onWhatsApp(...byJid.keys());
    } catch {
      throw new GroupCreateError('not_connected');
    }
    const existing = new Set(
      (found ?? []).filter((entry) => entry?.exists === true).map((entry) => bareWhatsappPhoneJid(entry.jid)),
    );
    for (const [jid, invitees] of byJid) {
      if (existing.has(jid)) reachable.push(jid);
      else invitees.forEach((invitee) => skip(invitee.key, 'not_on_whatsapp'));
    }
  }
  if (!reachable.length) throw new GroupCreateError('no_reachable_invitees');

  // The create IQ is the only step that can leave a group behind.
  let created: Awaited<ReturnType<GroupCreateSocket['groupCreate']>>;
  try {
    created = await socket.groupCreate(request.subject, reachable.slice(0, 1));
  } catch (error) {
    deps.log('chatwoot_group_create_create_failed', {
      requestId: request.requestId,
      status: errorStatus(error),
      definite: definiteRefusal(error),
    });
    throw new GroupCreateError(definiteRefusal(error) ? 'create_failed' : 'in_progress');
  }
  const groupJid = created?.id;
  if (typeof groupJid !== 'string' || !groupJid.endsWith('@g.us')) throw new GroupCreateError('in_progress');
  deps.log('chatwoot_group_create_created', { requestId: request.requestId, groupJid });

  // The conversation first: anyone added from here on can already write.
  let conversation: GroupCreateOkReply['conversation'] = null;
  const attempts = Math.max(1, deps.conversationAttempts ?? 3);
  for (let attempt = 1; attempt <= attempts && !conversation; attempt++) {
    try {
      conversation = await deps.ensureConversation(groupJid, request.subject);
    } catch (error) {
      deps.log('chatwoot_group_create_conversation_failed', {
        requestId: request.requestId,
        attempt,
        errorClass: (error as Error)?.name || 'Error',
      });
      if (attempt < attempts) await deps.sleep(1_000 * attempt);
    }
  }

  // The create response drops per-participant errors; a first invitee who is
  // missing from it goes through the add below, which reports why.
  const added = new Set<string>();
  const first = reachable[0];
  if (first) {
    const members = created.participants ?? [];
    for (const member of members) {
      if (await participantMatches(first, member, deps.resolvePhoneJidForLid)) {
        added.add(first);
        break;
      }
    }
  }

  const statuses = new Map<string, { outcome: 'added' | 'skipped'; reason: GroupCreateReason | null }>();
  if (first && added.has(first)) statuses.set(first, { outcome: 'added', reason: null });
  let rateLimited = false;
  let calls = 0;
  for (const jid of reachable) {
    if (statuses.has(jid)) continue;
    if (rateLimited) {
      statuses.set(jid, { outcome: 'skipped', reason: 'rate_limited' });
      continue;
    }
    if (calls++ > 0 || added.size) await deps.sleep(pauseMs);
    try {
      const result = await socket.groupParticipantsUpdate(groupJid, [jid], 'add');
      const entry = result?.[0];
      const status = groupAddOutcome(entry?.status);
      statuses.set(jid, status);
      if (status.outcome === 'added') added.add(jid);
      if (status.reason === 'rate_limited') rateLimited = true;
    } catch (error) {
      const limited = errorStatus(error) === 429;
      statuses.set(jid, { outcome: 'skipped', reason: limited ? 'rate_limited' : 'failed' });
      if (limited) rateLimited = true;
    }
  }

  // Colleagues become admins; clients stay members. One IQ for all of them.
  const promote = reachable.filter((jid) => added.has(jid) && byJid.get(jid)?.some((invitee) => invitee.admin));
  const promoted = new Set<string>();
  if (promote.length) {
    try {
      const result = (await socket.groupParticipantsUpdate(groupJid, promote, 'promote')) ?? [];
      for (const jid of promote) {
        for (const entry of result) {
          if (String(entry?.status) !== '200') continue;
          if (await participantMatches(jid, entry.jid, deps.resolvePhoneJidForLid)) {
            promoted.add(jid);
            break;
          }
        }
      }
      // A one-jid answer cannot be misattributed even when it is LID-only and unmapped.
      if (promote.length === 1 && result.length === 1 && String(result[0]?.status) === '200') promoted.add(promote[0]);
    } catch (error) {
      deps.log('chatwoot_group_create_promote_failed', {
        requestId: request.requestId,
        status: errorStatus(error),
      });
    }
  }

  for (const [jid, invitees] of byJid) {
    const status = statuses.get(jid);
    if (!status) continue;
    for (const invitee of invitees)
      outcomes.set(invitee.key, {
        key: invitee.key,
        ...status,
        admin: status.outcome === 'added' && invitee.admin ? (promoted.has(jid) ? 'promoted' : 'failed') : null,
      });
  }

  let picture: GroupCreateOkReply['picture'] = 'none';
  if (request.picture) {
    try {
      await socket.updateProfilePicture(groupJid, Buffer.from(request.picture.base64, 'base64'));
      picture = 'set';
    } catch (error) {
      picture = 'failed';
      deps.log('chatwoot_group_create_picture_failed', {
        requestId: request.requestId,
        status: errorStatus(error),
      });
    }
  }

  const invitees = request.invitees
    .filter((invitee) => !ownKeys.has(invitee.key))
    .map(
      (invitee): GroupCreateInviteeOutcome =>
        outcomes.get(invitee.key) ?? { key: invitee.key, outcome: 'skipped', reason: 'failed', admin: null },
    );
  let inviteLink: string | null = null;
  if (invitees.some((invitee) => invitee.outcome === 'skipped')) {
    try {
      const code = await socket.groupInviteCode(groupJid);
      if (typeof code === 'string' && /^[A-Za-z0-9]+$/.test(code)) inviteLink = `https://chat.whatsapp.com/${code}`;
    } catch (error) {
      deps.log('chatwoot_group_create_invite_failed', {
        requestId: request.requestId,
        status: errorStatus(error),
      });
    }
  }

  deps.afterCreate?.(groupJid, conversation?.id ?? null);
  return {
    status: 'ok',
    action: 'group_created_whatsapp',
    request_id: request.requestId,
    group_peer: groupJid,
    conversation,
    invite_link: inviteLink,
    picture,
    invitees,
  };
}

/** request_id → final reply (24 h) with an atomic in_progress claim. */
export type GroupCreateStore = {
  /** true when this caller now owns the request id. */
  claim(key: string): Promise<boolean>;
  get(key: string): Promise<GroupCreateStored | null>;
  put(key: string, value: GroupCreateStored): Promise<void>;
  /** Drops a claim whose run created nothing, so the same request id may run again. */
  release(key: string): Promise<void>;
};

/** Process-local fallback when Redis is off; shared by every ChatwootService. */
export class LocalGroupCreateStore implements GroupCreateStore {
  private readonly entries = new Map<string, { at: number; value: any }>();

  constructor(
    private readonly ttlMs = GROUP_CREATE_TTL_SECONDS * 1000,
    private readonly now = () => Date.now(),
  ) {}

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.at >= this.ttlMs) this.entries.delete(key);
    return this.entries.get(key) ?? null;
  }

  async claim(key: string) {
    if (this.live(key)) return false;
    this.entries.set(key, { at: this.now(), value: { status: 'in_progress' } });
    return true;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async put(key: string, value: GroupCreateStored) {
    this.entries.set(key, { at: this.now(), value });
  }

  async release(key: string) {
    if (this.entries.get(key)?.value?.status === 'in_progress') this.entries.delete(key);
  }
}

type RedisLike = {
  set(key: string, value: string, options: { NX?: boolean; EX: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
};

export class RedisGroupCreateStore implements GroupCreateStore {
  constructor(
    private readonly client: () => RedisLike,
    private readonly prefix = '',
  ) {}

  async claim(key: string) {
    const ok = await this.client().set(this.prefix + key, JSON.stringify({ status: 'in_progress' }), {
      NX: true,
      EX: GROUP_CREATE_TTL_SECONDS,
    });
    return ok === 'OK';
  }

  async get(key: string) {
    const raw = await this.client().get(this.prefix + key);
    return raw ? JSON.parse(raw) : null;
  }

  async put(key: string, value: GroupCreateStored) {
    await this.client().set(this.prefix + key, JSON.stringify(value), { EX: GROUP_CREATE_TTL_SECONDS });
  }

  async release(key: string) {
    await this.client().del(this.prefix + key);
  }
}

/**
 * Idempotent create: the same request id never runs twice. Concurrent calls in
 * one process share the running promise; another process (or a later retry)
 * sees the store's in_progress claim or the stored reply.
 *
 * - A definite rejection (nothing created: gate, not connected, nobody
 *   reachable, create refused) releases the claim, so a retry may run.
 * - Anything uncertain keeps the claim as in_progress for 24 h: never risk a
 *   second group.
 * - A created group without its Chatwoot conversation is stored as pending;
 *   group_create_status completes it (it never creates a group).
 * - In progress and duplicate claims answer `{status:'in_progress'}` as a
 *   normal reply (HTTP 200), never an error.
 */
export class GroupCreateCoordinator {
  private readonly running = new Map<string, Promise<GroupCreateFinalReply | GroupCreateInProgressReply>>();
  private readonly completing = new Map<string, Promise<GroupCreateOkReply | GroupCreateInProgressReply>>();

  constructor(private readonly store: () => GroupCreateStore) {}

  async create(
    key: string,
    run: () => Promise<GroupCreateOkReply>,
    subject = '',
  ): Promise<GroupCreateOkReply | GroupCreateInProgressReply> {
    const existing = this.running.get(key);
    if (existing) return this.unwrap(await existing);
    const task = this.claimAndRun(key, run, subject);
    this.running.set(key, task);
    try {
      return this.unwrap(await task);
    } finally {
      if (this.running.get(key) === task) this.running.delete(key);
    }
  }

  async status(
    key: string,
    complete?: (pending: GroupCreatePending) => Promise<GroupCreateOkReply['conversation']>,
  ): Promise<GroupCreateFinalReply | GroupCreateInProgressReply | { status: 'unknown' }> {
    if (this.running.has(key)) return { status: 'in_progress' };
    let stored: GroupCreateStored | null;
    try {
      stored = await this.store().get(key);
    } catch {
      // A store blip says nothing about the create: uncertain, never a definite answer.
      return { status: 'in_progress' };
    }
    if (!stored) return { status: 'unknown' };
    if (stored.status !== 'in_progress') return stored;
    if (!('pending' in stored) || !stored.pending || !complete) return { status: 'in_progress' };
    const running = this.completing.get(key);
    if (running) return running;
    const pending = stored.pending;
    const task = (async (): Promise<GroupCreateOkReply | GroupCreateInProgressReply> => {
      const conversation = await complete(pending).catch(() => null);
      if (!conversation) return { status: 'in_progress' };
      const reply: GroupCreateOkReply = { ...pending.reply, conversation };
      await this.store()
        .put(key, reply)
        .catch(() => undefined);
      return reply;
    })().finally(() => this.completing.delete(key));
    this.completing.set(key, task);
    return task;
  }

  private unwrap(reply: GroupCreateFinalReply | GroupCreateInProgressReply) {
    if (reply.status === 'error') throw new GroupCreateError(reply.code);
    return reply;
  }

  private async claimAndRun(
    key: string,
    run: () => Promise<GroupCreateOkReply>,
    subject: string,
  ): Promise<GroupCreateFinalReply | GroupCreateInProgressReply> {
    const store = this.store();
    let claimed: boolean;
    try {
      claimed = await store.claim(key);
    } catch {
      // Without the store there is no idempotency: refuse before creating anything.
      return { status: 'error', code: 'not_connected' };
    }
    if (!claimed) {
      const stored = await store.get(key).catch(() => null);
      if (stored && stored.status !== 'in_progress') return stored;
      return { status: 'in_progress' };
    }
    let reply: GroupCreateOkReply;
    try {
      reply = await run();
    } catch (error) {
      if (error instanceof GroupCreateError && error.code !== 'in_progress') {
        await store.release(key).catch(() => undefined);
        return error.body;
      }
      return { status: 'in_progress' };
    }
    if (!reply.conversation) {
      // The group exists but Chatwoot has no conversation for it yet.
      await store.put(key, { status: 'in_progress', pending: { reply, subject } }).catch(() => undefined);
      return { status: 'in_progress' };
    }
    // The group exists: answer it even when the store write fails (the claim then keeps in_progress).
    await store.put(key, reply).catch(() => undefined);
    return reply;
  }
}
