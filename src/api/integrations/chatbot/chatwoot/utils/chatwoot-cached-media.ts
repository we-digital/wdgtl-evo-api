import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';

import { Media, Message } from '@prisma/client';
import { downloadContentFromMessage, getMediaKeys } from 'baileys';
import { Agent, fetch as fetchMedia } from 'undici';

import { retainedHistoryMedia, retainedTemplate } from './chatwoot-retained-history-formats';

export const CACHED_MEDIA_BATCH_LIMIT = 64 * 1024 * 1024;
export const CACHED_MEDIA_FILE_LIMIT = 64 * 1024 * 1024;
const types = new Set(['documentMessage', 'imageMessage', 'audioMessage', 'videoMessage', 'stickerMessage']);
// A native document's MIME describes the authenticated bytes; it does not select crypto keys.
const nativeDocumentMIME = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 100 &&
  /^(application|text|image|audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value);

// Stickers retain their native source type; Chatwoot stores authenticated WebP bytes as images.
export function cachedHistoryMediaType(message: Message): string {
  const { type } = retainedHistoryMedia(message);
  return type === 'stickerMessage' ? 'image' : type.replace(/Message$/, '');
}

// Storage sniffing canonicalizes only these exact, observed native MIME aliases.
export function cachedMediaMIMEsEqual(type: string, native: string, stored: string): boolean {
  if (native === stored) return true;
  // A retained native Word envelope may use the generic Word MIME while
  // storage identifies its OOXML bytes. Native SHA and size proof is still required.
  if (
    type === 'documentMessage' &&
    native === 'application/msword' &&
    stored === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return true;
  const aliases =
    type === 'documentMessage'
      ? [
          ['application/zip', 'application/x-zip-compressed'],
          ['application/rar', 'application/vnd.rar'],
        ]
      : type === 'audioMessage'
        ? [['audio/ogg', 'audio/ogg; codecs=opus', 'audio/opus']]
        : [];
  return aliases.some((pair) => pair.includes(native) && pair.includes(stored));
}

export function nativeCachedMediaPayload(message: Message) {
  const { type, descriptor } = retainedHistoryMedia(message);
  if (!types.has(type) || !descriptor || (type === 'stickerMessage' && descriptor.mimetype !== 'image/webp'))
    throw new Error('cached_media_native_digest_unavailable');
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
    !cachedMediaMIMEsEqual(type, descriptor.mimetype, media.mimetype)
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
      (['imageMessage', 'templateMessage', 'associatedChildMessage'].includes(message.messageType) &&
        type === 'imageMessage' &&
        descriptor.mimetype === 'image/jpeg') ||
      (message.messageType === 'stickerMessage' && type === 'stickerMessage' && descriptor.mimetype === 'image/webp') ||
      (message.messageType === 'lottieStickerMessage' &&
        type === 'documentMessage' &&
        descriptor.mimetype === 'application/was') ||
      (['documentMessage', 'ephemeralMessage'].includes(message.messageType) &&
        type === 'documentMessage' &&
        nativeDocumentMIME(descriptor.mimetype)) ||
      (message.messageType === 'audioMessage' &&
        type === 'audioMessage' &&
        ['audio/ogg', 'audio/ogg; codecs=opus'].includes(descriptor.mimetype)) ||
      (message.messageType === 'videoMessage' && type === 'videoMessage' && descriptor.mimetype === 'video/mp4') ||
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
  const filename = basename(
    descriptor.fileName ||
      `${key.id}.${message.messageType === 'lottieStickerMessage' ? 'was' : type === 'stickerMessage' ? 'webp' : type === 'imageMessage' ? 'jpg' : type === 'documentMessage' ? 'bin' : type === 'audioMessage' ? 'ogg' : 'mp4'}`,
  );
  if (!filename || filename.length > 255 || [...filename].some((c) => c.charCodeAt(0) < 32))
    throw new Error('cached_media_filename_unavailable');
  return { size, digest, filename, mimetype: descriptor.mimetype, objectName: '' };
}

// A necessary source download is one GET of the authenticated native descriptor.
// No socket reupload request, fallback, retry, cache mutation or provider send is allowed.
export async function readRetainedRecoveryMedia(
  message: Message,
  download = downloadContentFromMessage,
  fetchEncrypted = fetchMedia,
): Promise<Buffer> {
  const expected = retainedDownloadDescriptor(message);
  const { descriptor } = retainedHistoryMedia(message);
  const key =
    typeof descriptor.mediaKey === 'string'
      ? Buffer.from(descriptor.mediaKey, 'base64')
      : Buffer.from(descriptor.mediaKey?.data || Object.values(descriptor.mediaKey || {}));
  if (key.length !== 32) throw new Error('cached_media_provider_descriptor_unavailable');
  // Select the current native pointer once; never retry a rejected stored URL.
  const direct = descriptor.directPath;
  if (
    direct !== undefined &&
    (typeof direct !== 'string' || !direct.startsWith('/') || direct.startsWith('//') || /[\\\s]/.test(direct))
  )
    throw new Error('cached_media_provider_descriptor_unavailable');
  const pointer = direct === undefined ? descriptor.url : `https://mmg.whatsapp.net${direct}`;
  if (typeof pointer !== 'string') throw new Error('cached_media_provider_descriptor_unavailable');
  const url = new URL(pointer);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mmg.whatsapp.net' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.toString() !== pointer
  )
    throw new Error('cached_media_provider_descriptor_unavailable');
  const controller = new AbortController();
  let stream: Awaited<ReturnType<typeof download>> | undefined;
  let agent: Agent | undefined;
  let destroyPromise: Promise<void> | undefined;
  const closeAgent = () => {
    if (agent && !destroyPromise) destroyPromise = agent.destroy();
    return destroyPromise;
  };
  const abort = () => {
    controller.abort();
    void closeAgent()?.catch(() => {});
    stream?.destroy(new Error('cached_media_provider_read_deadline'));
  };
  const timer = setTimeout(abort, 5000);
  try {
    let dispatcher: any;
    let decryptType: 'image' | 'video' | 'document' | 'sticker' | 'audio' = [
      'lottieStickerMessage',
      'stickerMessage',
    ].includes(message.messageType)
      ? 'sticker'
      : retainedHistoryMedia(message).type === 'imageMessage'
        ? 'image'
        : retainedHistoryMedia(message).type === 'documentMessage'
          ? 'document'
          : retainedHistoryMedia(message).type === 'audioMessage'
            ? 'audio'
            : 'video';
    if (download === downloadContentFromMessage) {
      // Installed Baileys forwards dispatcher, but drops signal and redirect.
      // Read one bounded ciphertext first, then retain its original decryption.
      agent = new Agent({
        connections: 1,
        pipelining: 0,
        connect: { rejectUnauthorized: true, timeout: 5000 },
        headersTimeout: 5000,
        bodyTimeout: 5000,
      });
      const response = await fetchEncrypted(url.toString(), {
        method: 'GET',
        headers: { Origin: 'https://web.whatsapp.com' },
        signal: controller.signal,
        redirect: 'error',
        dispatcher: agent,
      });
      if (!response.ok || !response.body) throw new Error('cached_media_provider_read_refused');
      const encrypted: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > expected.size + 1024) throw new Error('cached_media_bytes_mismatch');
        encrypted.push(bytes);
      }
      const ciphertext = Buffer.concat(encrypted);
      if (decryptType === 'image') {
        const body = ciphertext.subarray(0, -10);
        const mac = ciphertext.subarray(-10);
        const authenticates = async (type: 'image' | 'document') => {
          const keys = await getMediaKeys(key, type);
          const expectedMAC = createHmac('sha256', keys.macKey)
            .update(Buffer.concat([keys.iv, body]))
            .digest()
            .subarray(0, 10);
          return mac.length === 10 && timingSafeEqual(mac, expectedMAC);
        };
        if (!(await authenticates('image'))) {
          const encryptedDigest =
            typeof descriptor.fileEncSha256 === 'string'
              ? Buffer.from(descriptor.fileEncSha256, 'base64')
              : Buffer.from(descriptor.fileEncSha256?.data || Object.values(descriptor.fileEncSha256 || {}));
          if (
            ciphertext.length <= 10 ||
            body.length % 16 !== 0 ||
            encryptedDigest.length !== 32 ||
            !createHash('sha256').update(ciphertext).digest().equals(encryptedDigest) ||
            !(await authenticates('document'))
          )
            throw new Error('cached_media_crypto_family_unavailable');
          // Authentication selects only decryption keys; the native image envelope is unchanged.
          decryptType = 'document';
        }
      }
      if (
        ['documentMessage', 'audioMessage', 'videoMessage'].includes(retainedHistoryMedia(message).type) ||
        message.messageType === 'stickerMessage'
      ) {
        const body = ciphertext.subarray(0, -10);
        const mac = ciphertext.subarray(-10);
        const encryptedDigest =
          typeof descriptor.fileEncSha256 === 'string'
            ? Buffer.from(descriptor.fileEncSha256, 'base64')
            : Buffer.from(descriptor.fileEncSha256?.data || Object.values(descriptor.fileEncSha256 || {}));
        const keys = await getMediaKeys(key, decryptType);
        const expectedMAC = createHmac('sha256', keys.macKey)
          .update(Buffer.concat([keys.iv, body]))
          .digest()
          .subarray(0, 10);
        if (
          ciphertext.length <= 10 ||
          body.length % 16 !== 0 ||
          encryptedDigest.length !== 32 ||
          !createHash('sha256').update(ciphertext).digest().equals(encryptedDigest) ||
          mac.length !== 10
        )
          throw new Error('cached_media_crypto_family_unavailable');
        if (!timingSafeEqual(mac, expectedMAC)) {
          if (
            message.messageType !== 'documentMessage' ||
            descriptor.mimetype !== 'image/jpeg' ||
            decryptType !== 'document'
          )
            throw new Error('cached_media_crypto_family_unavailable');
          const imageKeys = await getMediaKeys(key, 'image');
          const imageMAC = createHmac('sha256', imageKeys.macKey)
            .update(Buffer.concat([imageKeys.iv, body]))
            .digest()
            .subarray(0, 10);
          if (!timingSafeEqual(mac, imageMAC)) throw new Error('cached_media_crypto_family_unavailable');
          // Authenticate key selection only; the native document envelope and MIME are unchanged.
          decryptType = 'image';
        }
      }
      let delivered = false;
      dispatcher = {
        dispatch(options: any, handler: any) {
          if (delivered || options.method !== 'GET' || `${options.origin}${options.path}` !== url.toString())
            throw new Error('cached_media_provider_descriptor_unavailable');
          delivered = true;
          if (typeof handler.onRequestStart === 'function') {
            // Node26 fetch uses the public controller/response handler interface.
            // This serves the already authenticated in-memory ciphertext once; no network is opened.
            const responseController = {
              paused: false,
              aborted: false,
              reason: null as unknown,
              pause() {
                this.paused = true;
              },
              resume() {
                this.paused = false;
              },
              abort(reason: unknown) {
                if (this.aborted) return;
                this.aborted = true;
                this.reason = reason;
                handler.onResponseError?.(this, reason);
              },
            };
            handler.onRequestStart(responseController, null);
            if (!responseController.aborted) {
              handler.onResponseStart(responseController, 200, { 'content-type': 'application/octet-stream' }, 'OK');
              handler.onResponseData(responseController, ciphertext);
              handler.onResponseEnd(responseController, {});
            }
          } else {
            handler.onConnect(() => {});
            handler.onHeaders(200, ['content-type', 'application/octet-stream'], () => {}, 'OK');
            handler.onData(ciphertext);
            handler.onComplete([]);
          }
          return true;
        },
      };
    }
    stream = await download({ mediaKey: key, url: url.toString() }, decryptType, {
      options: { signal: controller.signal, redirect: 'error', dispatcher } as any,
    });
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
    await closeAgent();
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
    if (['conversation', 'extendedTextMessage', 'contactMessage', 'buttonsMessage'].includes(message.messageType))
      continue;
    if (
      message.messageType === 'templateMessage' &&
      !retainedTemplate(message.message).video &&
      !retainedTemplate(message.message).image
    )
      continue;
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
