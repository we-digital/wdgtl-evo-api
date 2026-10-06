import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { Media, Message } from '@prisma/client';
import { downloadContentFromMessage } from 'baileys';

import { retainedHistoryMedia, retainedTemplate } from './chatwoot-retained-history-formats';

export const CACHED_MEDIA_BATCH_LIMIT = 16 * 1024 * 1024;
export const CACHED_MEDIA_FILE_LIMIT = 8 * 1024 * 1024;
const types = new Set(['documentMessage', 'imageMessage', 'audioMessage', 'videoMessage']);

export function nativeCachedMediaPayload(message: Message) {
  const { type, descriptor } = retainedHistoryMedia(message);
  if (!types.has(type) || !descriptor) throw new Error('cached_media_native_digest_unavailable');
  const rawLength = descriptor.fileLength;
  const size =
    typeof rawLength === 'number'
      ? rawLength
      : rawLength?.high === 0 && Number.isSafeInteger(rawLength.low)
        ? rawLength.low
        : NaN;
  const digest =
    typeof descriptor.fileSha256 === 'string'
      ? Buffer.from(descriptor.fileSha256, 'base64')
      : Buffer.from(descriptor.fileSha256?.data || Object.values(descriptor.fileSha256 || {}));
  if (!Number.isSafeInteger(size) || size < 1 || size > CACHED_MEDIA_FILE_LIMIT || digest.length !== 32) {
    throw new Error('cached_media_size_or_digest_unavailable');
  }
  return { size, digest };
}

export function cachedMediaDescriptor(message: Message, media: Media) {
  const key = message.key as { id?: unknown; remoteJid?: unknown; fromMe?: unknown };
  const { type, descriptor } = retainedHistoryMedia(message);
  if (
    !types.has(type) ||
    typeof key.fromMe !== 'boolean' ||
    typeof key.remoteJid !== 'string' ||
    !descriptor ||
    media.messageId !== message.id ||
    media.instanceId !== message.instanceId ||
    media.type !== type ||
    !(
      (media.fileName.startsWith(`${message.instanceId}/${key.remoteJid}/${media.type}/`) &&
        media.fileName.split('/').length === 4 &&
        /^[0-9]{13}_.+/.test(basename(media.fileName))) ||
      (media.fileName.startsWith(`${message.instanceId}/${key.remoteJid}/${key.id}/${media.type}/`) &&
        media.fileName.split('/').length === 5)
    ) ||
    media.fileName.split('/').some((part) => part === '..' || part === '.') ||
    typeof descriptor.mimetype !== 'string' ||
    descriptor.mimetype !== media.mimetype
  ) {
    throw new Error('cached_media_authority_unavailable');
  }
  const { size, digest } = nativeCachedMediaPayload(message);
  const filename = basename(descriptor.fileName || media.fileName);
  if (!filename || filename.length > 255 || [...filename].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('cached_media_filename_unavailable');
  }
  return { size, digest, filename, mimetype: media.mimetype, objectName: media.fileName };
}

function retainedDownloadDescriptor(message: Message) {
  const key = message.key as any;
  const { type, descriptor } = retainedHistoryMedia(message);
  const { size, digest } = nativeCachedMediaPayload(message);
  if (
    !(
      (message.messageType === 'imageMessage' && type === 'imageMessage' && descriptor.mimetype === 'image/jpeg') ||
      (['associatedChildMessage', 'templateMessage'].includes(message.messageType) &&
        type === 'videoMessage' &&
        descriptor.mimetype === 'video/mp4')
    ) ||
    typeof key?.id !== 'string' ||
    !key.id ||
    typeof key.remoteJid !== 'string' ||
    !key.remoteJid ||
    typeof key.fromMe !== 'boolean'
  )
    throw new Error('cached_media_authority_unavailable');
  const filename = basename(descriptor.fileName || `${key.id}.${type === 'imageMessage' ? 'jpg' : 'mp4'}`);
  if (!filename || filename.length > 255 || [...filename].some((c) => c.charCodeAt(0) < 32))
    throw new Error('cached_media_filename_unavailable');
  return { size, digest, filename, mimetype: descriptor.mimetype, objectName: '' };
}

// A necessary source download is one GET of the authenticated native descriptor.
// No socket reupload request, fallback, retry, cache mutation or provider send is allowed.
export async function readRetainedRecoveryMedia(
  message: Message,
  download = downloadContentFromMessage,
): Promise<Buffer> {
  const expected = retainedDownloadDescriptor(message);
  const { descriptor } = retainedHistoryMedia(message);
  const key =
    typeof descriptor.mediaKey === 'string'
      ? Buffer.from(descriptor.mediaKey, 'base64')
      : Buffer.from(descriptor.mediaKey?.data || Object.values(descriptor.mediaKey || {}));
  if (key.length !== 32 || typeof descriptor.url !== 'string')
    throw new Error('cached_media_provider_descriptor_unavailable');
  const url = new URL(descriptor.url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mmg.whatsapp.net' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('cached_media_provider_descriptor_unavailable');
  const controller = new AbortController();
  let stream: Awaited<ReturnType<typeof download>> | undefined;
  const abort = () => {
    controller.abort();
    stream?.destroy(new Error('cached_media_provider_read_deadline'));
  };
  const timer = setTimeout(abort, 5000);
  try {
    stream = await download(
      { mediaKey: key, url: url.toString() },
      retainedHistoryMedia(message).type === 'imageMessage' ? 'image' : 'video',
      {
        options: { signal: controller.signal, redirect: 'error' },
      },
    );
    if (controller.signal.aborted) {
      stream.destroy();
      throw new Error('cached_media_provider_read_deadline');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > expected.size) throw new Error('cached_media_bytes_mismatch');
      chunks.push(bytes);
    }
    return verifyCachedMediaBytes(Buffer.concat(chunks), expected);
  } finally {
    clearTimeout(timer);
    controller.abort();
    stream?.destroy();
  }
}

// Retained video callers keep the same bounded transport and descriptor checks.
export const readRetainedRecoveryVideo = readRetainedRecoveryMedia;

export function verifyCachedMediaBytes(bytes: Buffer, descriptor: ReturnType<typeof cachedMediaDescriptor>): Buffer {
  if (bytes.length !== descriptor.size || !createHash('sha256').update(bytes).digest().equals(descriptor.digest)) {
    throw new Error('cached_media_bytes_mismatch');
  }
  return bytes;
}

// Fetch ALL missing media before edits, source-guard writes, or imports. A later
// unsupported record must not leave an earlier attachment partially imported.
export async function prepareCachedRecoveryMedia(
  messages: Message[],
  findMedia: (message: Message) => Promise<Media | null>,
  readObject: (name: string, limit: number, mime: string) => Promise<Buffer>,
  readMissingMedia?: (message: Message) => Promise<Buffer>,
) {
  const result = new Map<
    string,
    { media: Media | null; descriptor: ReturnType<typeof cachedMediaDescriptor>; bytes: Buffer }
  >();
  let total = 0;
  for (const message of messages) {
    if (['conversation', 'extendedTextMessage', 'contactMessage'].includes(message.messageType)) continue;
    if (message.messageType === 'templateMessage' && !retainedTemplate(message.message).video) continue;
    const media = await findMedia(message);
    if (!media && !readMissingMedia) throw new Error('cached_media_authority_unavailable');
    const descriptor = media ? cachedMediaDescriptor(message, media) : retainedDownloadDescriptor(message);
    total += descriptor.size;
    if (total > CACHED_MEDIA_BATCH_LIMIT) throw new Error('cached_media_batch_limit');
    const bytes = verifyCachedMediaBytes(
      media
        ? await readObject(descriptor.objectName, descriptor.size, descriptor.mimetype)
        : await readMissingMedia!(message),
      descriptor,
    );
    result.set(message.id, { media, descriptor, bytes });
  }
  return result;
}
