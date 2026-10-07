import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Message } from '@prisma/client';
import { proto, WAMessage } from 'baileys';

const MEDIA_TYPES = new Set(['imageMessage', 'documentMessage', 'videoMessage', 'audioMessage', 'stickerMessage']);
export const NATIVE_MEDIA_REFRESH_MAX_BYTES = 64 * 1024 * 1024;
type ScopedMediaMessage = proto.IWebMessageInfo & Pick<WAMessage, 'key'>;

export function expiredNativeMediaStatus(error: unknown): number | undefined {
  const value = error as { status?: unknown; output?: { statusCode?: unknown } };
  const status = value?.status ?? value?.output?.statusCode;
  return status === 403 || status === 410 ? status : undefined;
}

function descriptorSnapshot(descriptor: Record<string, any>) {
  const copy = structuredClone(descriptor);
  delete copy.url;
  delete copy.directPath;
  for (const name of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
    const value = descriptor[name];
    const bytes =
      typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value?.data || Object.values(value || {}));
    if (bytes.length !== 32 || (typeof value === 'string' && bytes.toString('base64') !== value)) {
      throw new Error('native_media_refresh_crypto_unqualified');
    }
    copy[name] = bytes.toString('base64');
  }
  return copy;
}

function stableSource(source: Message, type: string) {
  const message = structuredClone(source.message) as Record<string, any>;
  message[type] = descriptorSnapshot(message[type]);
  return {
    id: source.id,
    instanceId: source.instanceId,
    key: source.key,
    messageType: source.messageType,
    messageTimestamp: source.messageTimestamp,
    message,
  };
}

function stableMessage(message: proto.IMessage, type: string) {
  const copy = structuredClone(message) as Record<string, any>;
  copy[type] = descriptorSnapshot(copy[type]);
  return copy;
}

/** A single own-device media receipt; never an ordinary message or a cached-apply retry. */
export async function refreshExpiredNativeMedia(input: {
  error: unknown;
  instanceId: string;
  original: proto.IWebMessageInfo;
  requestedKey: proto.IMessageKey;
  message: ScopedMediaMessage;
  type: string;
  readSource: () => Promise<Message[]>;
  refresh: (message: ScopedMediaMessage) => Promise<ScopedMediaMessage>;
  download: (message: ScopedMediaMessage, byteLimit: number) => Promise<Buffer>;
  persistPointers: (source: Message, pointers: { url: string; directPath: string }) => Promise<void>;
  deadlineMs?: number;
}): Promise<Buffer> {
  const startedAt = Date.now();
  const deadline = input.deadlineMs ?? 45000;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 45000) {
    throw new Error('native_media_refresh_deadline_unqualified');
  }
  if (!expiredNativeMediaStatus(input.error) || !MEDIA_TYPES.has(input.type)) throw input.error;
  const key = input.original.key;
  if (
    !input.instanceId ||
    typeof key?.id !== 'string' ||
    !key.id ||
    typeof key.remoteJid !== 'string' ||
    !key.remoteJid ||
    typeof key.fromMe !== 'boolean' ||
    input.requestedKey?.id !== key.id ||
    input.requestedKey.remoteJid !== key.remoteJid ||
    input.requestedKey.fromMe !== key.fromMe ||
    !isDeepStrictEqual(input.message.key, key)
  ) {
    throw new Error('native_media_refresh_identity_unqualified');
  }
  let sourceTimer: ReturnType<typeof setTimeout>;
  let sources: Message[];
  try {
    sources = await Promise.race([
      input.readSource(),
      new Promise<never>((_, reject) => {
        sourceTimer = setTimeout(() => reject(new Error('native_media_refresh_deadline_unknown_no_retry')), deadline);
      }),
    ]);
  } finally {
    clearTimeout(sourceTimer);
  }
  if (sources.length !== 1) throw new Error('native_media_refresh_source_nonunique');
  const source = sources[0];
  if (
    source.instanceId !== input.instanceId ||
    !isDeepStrictEqual(source.key, key) ||
    source.messageType !== input.type ||
    !Number.isSafeInteger(source.messageTimestamp) ||
    source.messageTimestamp < 1 ||
    source.messageTimestamp !== input.original.messageTimestamp ||
    !isDeepStrictEqual(source.message, input.original.message)
  ) {
    throw new Error('native_media_refresh_source_changed');
  }
  const descriptor = (source.message as Record<string, any>)[input.type];
  const native = descriptorSnapshot(descriptor);
  const size =
    typeof descriptor.fileLength === 'number'
      ? descriptor.fileLength
      : descriptor.fileLength?.high === 0
        ? descriptor.fileLength.low
        : NaN;
  if (!Number.isSafeInteger(size) || size < 1 || size > NATIVE_MEDIA_REFRESH_MAX_BYTES || !descriptor.mimetype) {
    throw new Error('native_media_refresh_bytes_unqualified');
  }
  const snapshot = stableSource(source, input.type);
  const messageSnapshot = stableMessage(input.message.message, input.type);
  let timer: ReturnType<typeof setTimeout>;
  let expired = false;
  const remaining = deadline - (Date.now() - startedAt);
  if (remaining < 1) throw new Error('native_media_refresh_deadline_unknown_no_retry');
  try {
    return await Promise.race([
      (async () => {
        const refreshed = await input.refresh(input.message);
        if (expired) throw new Error('native_media_refresh_deadline_unknown_no_retry');
        if (
          !isDeepStrictEqual(refreshed.key, key) ||
          !isDeepStrictEqual(stableMessage(refreshed.message, input.type), messageSnapshot)
        ) {
          throw new Error('native_media_refresh_metadata_changed');
        }
        const pointer = refreshed.message[input.type];
        const url = new URL(pointer.url);
        if (
          url.protocol !== 'https:' ||
          url.hostname !== 'mmg.whatsapp.net' ||
          url.username ||
          url.password ||
          typeof pointer.directPath !== 'string' ||
          !pointer.directPath.startsWith('/') ||
          pointer.directPath.startsWith('//') ||
          new URL(pointer.directPath, 'https://mmg.whatsapp.net').hostname !== url.hostname
        ) {
          throw new Error('native_media_refresh_pointer_unqualified');
        }
        const bytes = await input.download(refreshed, size);
        if (expired) throw new Error('native_media_refresh_deadline_unknown_no_retry');
        if (bytes.length !== size || createHash('sha256').update(bytes).digest('base64') !== native.fileSha256) {
          throw new Error('native_media_refresh_bytes_mismatch');
        }
        const after = await input.readSource();
        if (after.length !== 1 || !isDeepStrictEqual(stableSource(after[0], input.type), snapshot)) {
          throw new Error('native_media_refresh_source_rotated');
        }
        if (expired) throw new Error('native_media_refresh_deadline_unknown_no_retry');
        await input.persistPointers(after[0], { url: pointer.url, directPath: pointer.directPath });
        const saved = await input.readSource();
        if (
          saved.length !== 1 ||
          !isDeepStrictEqual(stableSource(saved[0], input.type), snapshot) ||
          (saved[0].message as any)[input.type].url !== pointer.url ||
          (saved[0].message as any)[input.type].directPath !== pointer.directPath
        ) {
          throw new Error('native_media_refresh_persistence_unproved');
        }
        return bytes;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('native_media_refresh_deadline_unknown_no_retry'));
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
