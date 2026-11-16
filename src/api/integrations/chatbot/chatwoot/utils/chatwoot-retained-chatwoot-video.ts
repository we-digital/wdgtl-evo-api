import { Message } from '@prisma/client';

import { cachedMediaMIMEsEqual, nativeCachedMediaPayload, verifyCachedMediaBytes } from './chatwoot-cached-media';
import { retainedHistoryMedia } from './chatwoot-retained-history-formats';

export interface RetainedChatwootVideo {
  id: number;
  account_id: number;
  inbox_id: number;
  display_id: number;
  source_id: string;
  message_type: number;
  private: boolean;
  created_at_epoch: number;
  peer: string;
  instance_id: string;
  attachment_id: number;
  blob_id: string;
  byte_size: string;
  content_type: string;
}

// SQL ownership and native snapshots are supplied and re-read by the caller.
// Legacy live messages may have a receive timestamp; only the native timestamp
// identifies the original. Neither captions nor direction are copied.
export async function readRetainedChatwootGroupVideo(
  target: Message,
  natives: Message[],
  copies: RetainedChatwootVideo[],
  accountId: number,
  readAttachment: (copy: RetainedChatwootVideo, limit: number) => Promise<Buffer>,
): Promise<Buffer | null> {
  if (natives.length > 25 || copies.length > 25) throw new Error('retained_cw_video_candidate_bound');
  const key = target.key as { id?: unknown; remoteJid?: unknown; fromMe?: unknown };
  if (
    ![
      'videoMessage',
      'documentMessage',
      'imageMessage',
      'audioMessage',
      'stickerMessage',
      'associatedChildMessage',
    ].includes(target.messageType) ||
    typeof key.id !== 'string' ||
    !key.id ||
    typeof key.remoteJid !== 'string' ||
    !/^(?:\d+|\d+-\d+)@g\.us$/.test(key.remoteJid) ||
    typeof key.fromMe !== 'boolean' ||
    !Number.isSafeInteger(target.messageTimestamp) ||
    target.messageTimestamp < 1
  )
    return null;
  const media = retainedHistoryMedia(target);
  const canonicalDigest = (descriptor: any) =>
    typeof descriptor.fileSha256 === 'string' &&
    Buffer.from(descriptor.fileSha256, 'base64').length === 32 &&
    Buffer.from(descriptor.fileSha256, 'base64').toString('base64') === descriptor.fileSha256;
  if (
    !['videoMessage', 'documentMessage', 'imageMessage', 'audioMessage', 'stickerMessage'].includes(media.type) ||
    typeof media.descriptor.mimetype !== 'string' ||
    !/^(application|text|image|audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; codecs=opus)?$/i.test(
      media.descriptor.mimetype,
    ) ||
    !canonicalDigest(media.descriptor)
  )
    throw new Error('retained_cw_video_native_authority');
  const expected = nativeCachedMediaPayload(target);
  for (const copy of copies) {
    const matches = natives.filter((candidate) => candidate.instanceId === copy.instance_id);
    if (!matches.length) throw new Error('retained_cw_video_native_unavailable');
    if (
      copy.account_id !== accountId ||
      copy.private !== false ||
      copy.peer !== key.remoteJid ||
      ![key.id, `WAID:${key.id}`].includes(copy.source_id) ||
      ![copy.id, copy.inbox_id, copy.display_id, copy.attachment_id].every((id) => Number.isSafeInteger(id) && id > 0)
    )
      throw new Error('retained_cw_video_copy_authority');
    // Receive timestamps and duplicate row IDs are not byte identities. Validate
    // every retained native row, while preserving its own full source snapshot.
    for (const native of matches) {
      const nativeKey = native.key as { id?: unknown; remoteJid?: unknown; fromMe?: unknown };
      if (
        native.messageType !== target.messageType ||
        !Number.isSafeInteger(native.messageTimestamp) ||
        native.messageTimestamp < 1 ||
        nativeKey.id !== key.id ||
        nativeKey.remoteJid !== key.remoteJid ||
        typeof nativeKey.fromMe !== 'boolean' ||
        copy.message_type !== (nativeKey.fromMe ? 1 : 0)
      )
        throw new Error('retained_cw_video_copy_authority');
      const nativeExpected = nativeCachedMediaPayload(native);
      const nativeMedia = retainedHistoryMedia(native);
      if (
        nativeMedia.type !== media.type ||
        !canonicalDigest(nativeMedia.descriptor) ||
        nativeMedia.descriptor.mimetype !== media.descriptor.mimetype ||
        !cachedMediaMIMEsEqual(media.type, media.descriptor.mimetype, copy.content_type) ||
        Number(copy.byte_size) !== expected.size ||
        nativeExpected.size !== expected.size ||
        !nativeExpected.digest.equals(expected.digest)
      )
        throw new Error('retained_cw_video_digest_authority');
    }
  }
  return copies.length
    ? verifyCachedMediaBytes(await readAttachment(copies[0], expected.size), {
        ...expected,
        filename: '',
        mimetype: media.descriptor.mimetype,
        objectName: '',
      })
    : null;
}

// `fileType` overrides the type derived from the content type: a WhatsApp
// document is stored by Chatwoot as `file` even when it is a JPEG or MP4.
export function retainedVideoProxyUrl(
  copy: RetainedChatwootVideo,
  payload: any,
  trustedOrigin: string,
  options: { fileType?: 'image' | 'audio' | 'video' | 'file' } = {},
): string {
  if (!Array.isArray(payload) || payload.length > 17) throw new Error('retained_cw_video_api_unconfirmed');
  const matches = payload.filter((row) => row.id === copy.id);
  const row = matches[0];
  if (
    matches.length !== 1 ||
    row.inbox_id !== copy.inbox_id ||
    row.conversation_id !== copy.display_id ||
    row.source_id !== copy.source_id ||
    row.message_type !== copy.message_type ||
    row.private !== false ||
    row.created_at !== Math.floor(copy.created_at_epoch) ||
    row.attachments?.length !== 1
  )
    throw new Error('retained_cw_video_api_unconfirmed');
  const attachment = row.attachments[0];
  if (
    attachment.id !== copy.attachment_id ||
    attachment.message_id !== copy.id ||
    attachment.account_id !== copy.account_id ||
    attachment.file_type !==
      (options.fileType ??
        (copy.content_type.startsWith('image/')
          ? 'image'
          : copy.content_type.startsWith('audio/')
            ? 'audio'
            : copy.content_type.startsWith('video/')
              ? 'video'
              : 'file')) ||
    attachment.content_type !== copy.content_type ||
    attachment.file_size !== Number(copy.byte_size) ||
    typeof attachment.download_url !== 'string'
  )
    throw new Error('retained_cw_video_api_unconfirmed');
  const url = new URL(attachment.download_url);
  if (
    url.origin !== trustedOrigin ||
    url.username ||
    url.password ||
    url.hash ||
    !(
      url.pathname.startsWith('/rails/active_storage/blobs/proxy/') ||
      url.pathname.startsWith('/rails/active_storage/blobs/redirect/')
    )
  )
    throw new Error('retained_cw_video_proxy_untrusted');
  return url.toString();
}

// Chatwoot serves downloads straight from the bucket since 2026-11-15: download_url is the ActiveStorage redirect,
// which answers 302 to a presigned URL in the media bucket. Exactly one hop is followed, and only into the bucket
// named by CHATWOOT_MEDIA_BUCKET_URL (for example https://sgp1.digitaloceanspaces.com/bbc-chatwoot-storage/). The
// legacy proxy path is read directly. Without the setting a redirect is refused, as before.
// `hop` is true only for the redirect request, which may answer 3xx; every other read must answer 2xx.
export type RetainedMediaGet = (
  url: string,
  hop: boolean,
) => Promise<{ status: number; headers: Record<string, any>; data: any }>;

export function retainedMediaBucketPrefix(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = env.CHATWOOT_MEDIA_BUCKET_URL?.trim();
  if (!raw) return null;
  const prefix = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  if (prefix.protocol !== 'https:' || prefix.username || prefix.password || prefix.search || prefix.hash) return null;
  return prefix;
}

export function isRetainedMediaBucketUrl(location: string, prefix: URL | null): boolean {
  if (!prefix) return false;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.origin === prefix.origin &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.pathname.startsWith(prefix.pathname) &&
    !url.pathname.slice(prefix.pathname.length).split('/').includes('..')
  );
}

export async function readRetainedChatwootMedia(
  url: string,
  get: RetainedMediaGet,
  prefix: URL | null = retainedMediaBucketPrefix(),
) {
  if (!new URL(url).pathname.startsWith('/rails/active_storage/blobs/redirect/')) return get(url, false);
  const hop = await get(url, true);
  const location = hop.headers?.location;
  if (
    hop.status < 300 ||
    hop.status >= 400 ||
    typeof location !== 'string' ||
    !isRetainedMediaBucketUrl(location, prefix)
  )
    throw new Error('retained_cw_video_redirect_untrusted');
  return get(location, false);
}
