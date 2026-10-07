import { Media, Message } from '@prisma/client';

import {
  cachedMediaDescriptor,
  cachedMediaMIMEsEqual,
  nativeCachedMediaPayload,
  verifyCachedMediaBytes,
} from './chatwoot-cached-media';
import { retainedHistoryMedia } from './chatwoot-retained-history-formats';

export interface RetainedGroupMediaCandidate {
  message: Message;
  media: Media;
}

// The caller scopes candidates to registered routes in the same account and
// verifies their native snapshots again around this read. Only bytes are reused;
// the target retains its own author, direction, caption and source identity.
export async function readRetainedGroupMedia(
  message: Message,
  candidates: RetainedGroupMediaCandidate[],
  readObject: (name: string, limit: number, mime: string) => Promise<Buffer>,
): Promise<Buffer | null> {
  if (candidates.length > 25) throw new Error('retained_group_media_candidate_bound');
  const key = message.key as { id?: unknown; remoteJid?: unknown; fromMe?: unknown };
  if (
    typeof key.id !== 'string' ||
    !key.id ||
    typeof key.remoteJid !== 'string' ||
    !/^(?:\d+|\d+-\d+)@g\.us$/.test(key.remoteJid) ||
    typeof key.fromMe !== 'boolean' ||
    !Number.isSafeInteger(message.messageTimestamp) ||
    message.messageTimestamp < 1
  )
    return null;
  const expected = nativeCachedMediaPayload(message);
  const target = retainedHistoryMedia(message);
  for (const candidate of candidates) {
    const retained = candidate.message;
    const retainedKey = retained.key as { id?: unknown; remoteJid?: unknown };
    if (
      retainedKey.id !== key.id ||
      retainedKey.remoteJid !== key.remoteJid ||
      retained.messageTimestamp !== message.messageTimestamp ||
      retained.messageType !== message.messageType ||
      retained.instanceId === message.instanceId
    )
      continue;
    const descriptor = cachedMediaDescriptor(retained, candidate.media);
    if (
      descriptor.size !== expected.size ||
      !descriptor.digest.equals(expected.digest) ||
      !cachedMediaMIMEsEqual(target.type, target.descriptor.mimetype, descriptor.mimetype)
    )
      throw new Error('retained_group_media_source_conflict');
    let bytes: Buffer;
    try {
      bytes = await readObject(descriptor.objectName, descriptor.size, descriptor.mimetype);
    } catch {
      // A removed storage object does not make a retained copy elsewhere invalid.
      continue;
    }
    return verifyCachedMediaBytes(bytes, descriptor);
  }
  return null;
}
