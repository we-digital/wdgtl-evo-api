import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const LAST_WHATSAPP_PROVIDER_EDIT_TIMESTAMP = 'weDigitalLastProviderEditTimestamp';

type EditKey = { id: string; remoteJid: string; fromMe: boolean; participant?: string };
export type NativeWhatsappEdit = { key: EditKey; message: Record<string, any>; timestamp: number };

export function normalizedWhatsappEdit(key: unknown, message: unknown, timestamp: unknown): NativeWhatsappEdit {
  const target = key as EditKey;
  if (
    !target ||
    typeof target.id !== 'string' ||
    !target.id ||
    typeof target.remoteJid !== 'string' ||
    !target.remoteJid ||
    typeof target.fromMe !== 'boolean' ||
    !Number.isSafeInteger(timestamp) ||
    Number(timestamp) <= 0 ||
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message)
  )
    throw new Error('Native normalized edit identity or payload is unavailable');
  const body = message as Record<string, any>;
  const supported = [
    'conversation',
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'documentMessage',
    'messageContextInfo',
  ];
  if (Object.keys(body).some((field) => !supported.includes(field)))
    throw new Error('Native normalized edit content kind is unsupported');
  const values = [
    body.conversation,
    body.extendedTextMessage?.text,
    body.imageMessage?.caption,
    body.videoMessage?.caption,
    body.documentMessage?.caption,
  ].filter((value) => value !== undefined);
  if (values.length !== 1 || typeof values[0] !== 'string')
    throw new Error('Native normalized edit content is unavailable');
  if ((body.conversation !== undefined || body.extendedTextMessage !== undefined) && !values[0].length)
    throw new Error('Native normalized edit text is unavailable');
  return { key: target, message: body, timestamp: Number(timestamp) };
}

// Only aliases explicitly persisted on this native original can identify an edit.
function explicitPhoneLidAlias(primary: unknown, alternate: unknown, candidate: string): boolean {
  if (typeof primary !== 'string' || typeof alternate !== 'string') return false;
  const pair =
    (/^\d+@lid$/.test(primary) && /^\d+@s\.whatsapp\.net$/.test(alternate)) ||
    (/^\d+@s\.whatsapp\.net$/.test(primary) && /^\d+@lid$/.test(alternate));
  return pair && alternate === candidate;
}

export function qualifyNativeWhatsappEditKey(original: Record<string, any>, target: NativeWhatsappEdit['key']): void {
  if (
    !original ||
    original.id !== target.id ||
    original.fromMe !== target.fromMe ||
    (original.remoteJid !== target.remoteJid &&
      !explicitPhoneLidAlias(original.remoteJid, original.remoteJidAlt, target.remoteJid))
  )
    throw new Error('Native normalized edit source identity conflicts');
  if (
    target.participant &&
    original.participant !== target.participant &&
    !explicitPhoneLidAlias(original.participant, original.participantAlt, target.participant)
  )
    throw new Error('Native normalized edit author conflicts');
}

function binary(value: any): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return Buffer.from(value.data || Object.values(value)).toString('base64');
  return undefined;
}

function nativeLength(value: any): string | undefined {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (value && Number.isInteger(value.low) && Number.isInteger(value.high)) {
    let length = (BigInt(value.high >>> 0) << 32n) + BigInt(value.low >>> 0);
    if (!value.unsigned && value.high < 0) length -= 1n << 64n;
    return length >= 0n ? String(length) : undefined;
  }
  return undefined;
}

// An edit changes visible text, never the original native file, reply or identity.
export function projectNativeWhatsappEdit(
  original: Record<string, any>,
  edit: NativeWhatsappEdit,
): Record<string, any> {
  if (!original || typeof original !== 'object' || Array.isArray(original))
    throw new Error('Native normalized edit original payload is unavailable');
  const result = structuredClone(original);
  const text = edit.message.conversation ?? edit.message.extendedTextMessage?.text;
  if (typeof text === 'string') {
    if (typeof original.conversation === 'string') result.conversation = text;
    else if (typeof original.extendedTextMessage?.text === 'string') result.extendedTextMessage.text = text;
    else throw new Error('Native normalized edit original content kind conflicts');
    return result;
  }
  const type = ['imageMessage', 'videoMessage', 'documentMessage'].find((name) => edit.message[name]);
  if (!type || !original[type] || typeof original[type] !== 'object')
    throw new Error('Native normalized edit original media kind conflicts');
  const descriptor = edit.message[type];
  for (const field of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
    if (descriptor[field] !== undefined && binary(descriptor[field]) !== binary(original[type][field]))
      throw new Error('Native normalized edit file authority conflicts');
  }
  if (
    descriptor.fileLength !== undefined &&
    (!nativeLength(descriptor.fileLength) ||
      nativeLength(descriptor.fileLength) !== nativeLength(original[type].fileLength))
  )
    throw new Error('Native normalized edit file metadata conflicts');
  for (const field of ['mimetype', 'fileName']) {
    if (descriptor[field] !== undefined && !isDeepStrictEqual(descriptor[field], original[type][field]))
      throw new Error('Native normalized edit file metadata conflicts');
  }
  result[type].caption = descriptor.caption;
  return result;
}

export function nativeWhatsappEditIdentity(instanceId: string, edit: NativeWhatsappEdit): string {
  return JSON.stringify([instanceId, edit.key.id, edit.key.remoteJid, edit.key.fromMe]);
}

export function nativeWhatsappEditVersion(edit: NativeWhatsappEdit): string {
  const content =
    edit.message.conversation ??
    edit.message.extendedTextMessage?.text ??
    edit.message.imageMessage?.caption ??
    edit.message.videoMessage?.caption ??
    edit.message.documentMessage?.caption;
  return createHash('sha256')
    .update(JSON.stringify([edit.timestamp, content]))
    .digest('hex');
}

export class NativeWhatsappEditQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(identity: string, apply: () => Promise<T>): Promise<T> {
    if (!this.tails.has(identity) && this.tails.size >= 512) throw new Error('Native normalized edit queue is full');
    const previous = this.tails.get(identity);
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(apply);
    this.tails.set(identity, current);
    try {
      return await current;
    } finally {
      if (this.tails.get(identity) === current) this.tails.delete(identity);
    }
  }
}
