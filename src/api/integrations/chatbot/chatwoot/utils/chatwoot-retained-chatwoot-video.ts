import { Message } from '@prisma/client';

import { nativeCachedMediaPayload, verifyCachedMediaBytes } from './chatwoot-cached-media';
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
    target.messageType !== 'videoMessage' ||
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
  if (media.type !== 'videoMessage' || media.descriptor.mimetype !== 'video/mp4' || !canonicalDigest(media.descriptor))
    throw new Error('retained_cw_video_native_authority');
  const expected = nativeCachedMediaPayload(target);
  for (const copy of copies) {
    const matches = natives.filter((candidate) => candidate.instanceId === copy.instance_id);
    if (matches.length !== 1) throw new Error('retained_cw_video_ambiguous_native');
    const native = matches[0];
    const nativeKey = native?.key as { id?: unknown; remoteJid?: unknown; fromMe?: unknown };
    if (
      !native ||
      native.messageType !== target.messageType ||
      native.messageTimestamp !== target.messageTimestamp ||
      nativeKey.id !== key.id ||
      nativeKey.remoteJid !== key.remoteJid ||
      typeof nativeKey.fromMe !== 'boolean' ||
      copy.account_id !== accountId ||
      copy.private !== false ||
      copy.peer !== key.remoteJid ||
      ![key.id, `WAID:${key.id}`].includes(copy.source_id) ||
      copy.message_type !== (nativeKey.fromMe ? 1 : 0) ||
      ![copy.id, copy.inbox_id, copy.display_id, copy.attachment_id].every((id) => Number.isSafeInteger(id) && id > 0)
    )
      throw new Error('retained_cw_video_copy_authority');
    if (copies.filter((candidate) => candidate.inbox_id === copy.inbox_id).length !== 1)
      throw new Error('retained_cw_video_ambiguous_copy');
    const nativeExpected = nativeCachedMediaPayload(native);
    const nativeMedia = retainedHistoryMedia(native);
    if (
      nativeMedia.type !== 'videoMessage' ||
      !canonicalDigest(nativeMedia.descriptor) ||
      nativeMedia.descriptor.mimetype !== 'video/mp4' ||
      copy.content_type !== 'video/mp4' ||
      Number(copy.byte_size) !== expected.size ||
      nativeExpected.size !== expected.size ||
      !nativeExpected.digest.equals(expected.digest)
    )
      throw new Error('retained_cw_video_digest_authority');
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

export function retainedVideoProxyUrl(copy: RetainedChatwootVideo, payload: any, trustedOrigin: string): string {
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
    attachment.file_type !== 'video' ||
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
    !url.pathname.startsWith('/rails/active_storage/blobs/proxy/')
  )
    throw new Error('retained_cw_video_proxy_untrusted');
  return url.toString();
}
