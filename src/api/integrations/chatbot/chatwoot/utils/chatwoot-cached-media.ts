import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { Media, Message } from '@prisma/client';

export const CACHED_MEDIA_BATCH_LIMIT = 16 * 1024 * 1024;
export const CACHED_MEDIA_FILE_LIMIT = 8 * 1024 * 1024;
const types = new Set(['documentMessage', 'imageMessage', 'audioMessage', 'videoMessage']);

export function cachedMediaDescriptor(message: Message, media: Media) {
  const key = message.key as { id?: unknown; remoteJid?: unknown; fromMe?: unknown };
  const payload = message.message as Record<string, any>;
  const descriptor = payload?.[message.messageType];
  if (
    !types.has(message.messageType) ||
    typeof key.fromMe !== 'boolean' ||
    typeof key.remoteJid !== 'string' ||
    !descriptor ||
    media.messageId !== message.id ||
    media.instanceId !== message.instanceId ||
    media.type !== message.messageType ||
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
  const filename = basename(descriptor.fileName || media.fileName);
  if (!filename || filename.length > 255 || [...filename].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('cached_media_filename_unavailable');
  }
  return { size, digest, filename, mimetype: media.mimetype, objectName: media.fileName };
}

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
) {
  const result = new Map<
    string,
    { media: Media; descriptor: ReturnType<typeof cachedMediaDescriptor>; bytes: Buffer }
  >();
  let total = 0;
  for (const message of messages) {
    if (['conversation', 'extendedTextMessage'].includes(message.messageType)) continue;
    const media = await findMedia(message);
    if (!media) throw new Error('cached_media_authority_unavailable');
    const descriptor = cachedMediaDescriptor(message, media);
    total += descriptor.size;
    if (total > CACHED_MEDIA_BATCH_LIMIT) throw new Error('cached_media_batch_limit');
    const bytes = verifyCachedMediaBytes(
      await readObject(descriptor.objectName, descriptor.size, descriptor.mimetype),
      descriptor,
    );
    result.set(message.id, { media, descriptor, bytes });
  }
  return result;
}
