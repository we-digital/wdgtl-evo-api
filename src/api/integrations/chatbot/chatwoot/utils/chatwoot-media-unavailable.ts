// A WhatsApp message whose media bytes can no longer be obtained is still a
// message staff saw on the phone. It is delivered as text (caption kept) with
// a per-type placeholder instead of retrying until the ledger gives up.

export type MediaFailureKind = 'unavailable' | 'transient' | 'unknown';

// Outcomes that another attempt of the same frozen source cannot change.
const unavailablePatterns = [
  /native_media_refresh_(?!persistence_CAS_refused)[a-z_]+/,
  /bad decrypt/i,
  /Failed to re-upload media/i,
  /InboundNativeMediaBytesUnconfirmed/,
  /Cannot derive from empty media key/i,
  /The message is not of the media type/,
  /Template message does not contain a supported media type/,
  /Message not found/,
  /status code (403|404|410)\b/,
];
// Network and receiver hiccups worth a normal retry.
const transientPatterns = [
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE/,
  /socket hang up|Connection Closed|Connection Terminated|Timed Out|timeout of \d+ms exceeded/i,
  /status code (429|5\d\d)\b/,
  /native_media_refresh_persistence_CAS_refused/,
];

export function mediaFailureKind(error: unknown): MediaFailureKind {
  const text = [
    (error as any)?.name,
    (error as any)?.message,
    (error as any)?.response?.message,
    typeof error === 'string' ? error : '',
  ]
    .filter((part) => typeof part === 'string')
    .join(' ');
  if (transientPatterns.some((pattern) => pattern.test(text))) return 'transient';
  if (unavailablePatterns.some((pattern) => pattern.test(text))) return 'unavailable';
  return 'unknown';
}

// Unknown errors get a few ordinary retries, transient ones about an hour of
// backoff, before the message is delivered without its file.
export const MEDIA_UNKNOWN_RETRIES = 3;
export const MEDIA_TRANSIENT_RETRIES = 12;
export function deliverWithoutMedia(kind: MediaFailureKind, attempts: number): boolean {
  if (kind === 'unavailable') return true;
  return attempts >= (kind === 'transient' ? MEDIA_TRANSIENT_RETRIES : MEDIA_UNKNOWN_RETRIES);
}

const labels: Record<string, string> = {
  imageMessage: 'Photo',
  videoMessage: 'Video',
  audioMessage: 'Audio',
  documentMessage: 'Document',
  stickerMessage: 'Sticker',
  ptvMessage: 'Video',
};

function mediaNode(message: Record<string, any> | undefined): [string, Record<string, any>] | null {
  if (!message || typeof message !== 'object') return null;
  for (const [type, value] of Object.entries(message)) {
    if (labels[type] && value && typeof value === 'object') return [type, value];
    if (value && typeof value === 'object' && value.message) {
      const nested = mediaNode(value.message);
      if (nested) return nested;
    }
  }
  return null;
}

export function mediaUnavailableLabel(message: Record<string, any> | undefined): string | null {
  const node = mediaNode(message);
  if (!node) return null;
  const [type, media] = node;
  if (type === 'audioMessage' && media.ptt) return '[Voice message — file no longer available]';
  const fileName = typeof media.fileName === 'string' ? media.fileName.replace(/[\r\n\]]/g, ' ').trim() : '';
  if (type === 'documentMessage' && fileName)
    return `[Document “${fileName.slice(0, 200)}” — file no longer available]`;
  return `[${labels[type]} — file no longer available]`;
}

// The exact text Chatwoot receives (and the receiver confirmation expects).
export function mediaUnavailableContent(
  caption: string | null | undefined,
  message: Record<string, any>,
): string | null {
  const label = mediaUnavailableLabel(message);
  if (!label) return null;
  return caption ? `${caption}\n\n${label}` : label;
}
