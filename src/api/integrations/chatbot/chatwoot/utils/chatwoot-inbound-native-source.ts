import { normalizeStoredHistoryMessages } from './chatwoot-history-sync';
import { InboundPayload, inboundPayloadHash } from './chatwoot-inbound-queue';

// Protobuf bytes reach this bridge in three JSON shapes: base64 strings (the
// persisted native Message row), numeric-key objects (JSON of a Uint8Array, as
// frozen in the queue payload) and {type:'Buffer',data}. The field-name list
// above missed thumbnailSha256, streamingSidecar, scansSidecar, waveform, ...,
// so the same source hashed differently in the ledger and in the Message table.
function jsonBytes(value: any): number[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const bytes =
    value.type === 'Buffer' && Array.isArray(value.data) && keys.length === 2
      ? value.data
      : keys.length && keys.every((key, i) => key === String(i))
        ? keys.map((key) => value[key])
        : null;
  return bytes && bytes.every((byte: any) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}
function canonicalBytes(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalBytes);
  if (value && typeof value === 'object') {
    const bytes = jsonBytes(value);
    if (bytes) return Buffer.from(bytes).toString('base64');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalBytes(item)]));
  }
  return value;
}
// The persisted (base64) encoding of a payload. Baileys only accepts string or
// Buffer media keys, so a numeric-key mediaKey fails with "bad decrypt".
export function canonicalInboundBody(body: InboundPayload): InboundPayload {
  return canonicalBytes(JSON.parse(JSON.stringify(body)));
}
// Download locators are refreshed by media re-upload and S3 retention; they are
// not source content. Cryptographic media identity (mediaKey/fileSha256/...) stays.
const mediaLocatorFields = new Set(['url', 'directPath', 'mediaKeyTimestamp', 'staticUrl']);
function withoutLocators(value: any, top = false): any {
  if (Array.isArray(value)) return value.map((item) => withoutLocators(item));
  if (!value || typeof value !== 'object') return value;
  const media = typeof value.mediaKey === 'string';
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !(media && mediaLocatorFields.has(key)) && !(top && (key === 'mediaUrl' || key === 'base64')))
      .map(([key, item]) => [key, withoutLocators(item)]),
  );
}
// Encoding- and locator-insensitive source identity for comparing the frozen
// queue payload with native rows and receiver stamps of the same WhatsApp key.
export function inboundSourceIdentityHash(body: InboundPayload): string {
  const canonical = canonicalInboundBody(body);
  return inboundPayloadHash({ ...canonical, message: withoutLocators(canonical.message, true) });
}
// Every hash a receiver row may legitimately carry for this exact source,
// depending on which encoding an earlier attempt delivered.
export function inboundAcceptedSourceHashes(...bodies: InboundPayload[]): Set<string> {
  const hashes = new Set<string>();
  for (const body of bodies) {
    if (!body) continue;
    hashes.add(inboundPayloadHash(body));
    hashes.add(inboundPayloadHash(canonicalInboundBody(body)));
  }
  return hashes;
}
// A blank-text sender-key distribution copy carries no user content. WhatsApp
// sends it to (re)distribute group keys; Chatwoot can never render it.
export function isInboundTransportOnly(body: InboundPayload): boolean {
  return plainTransportBody(body) && body.message.conversation === '' && !!body.message.senderKeyDistributionMessage;
}
// Rows that can never be the content source of a message under the same key.
export function inboundSourceCandidates<T extends InboundPayload>(sources: T[], stored: InboundPayload): T[] {
  if (stored?.messageType === 'reactionMessage') return sources;
  return sources.filter((source) => source.messageType !== 'reactionMessage');
}

function plainTransportBody(body: InboundPayload): boolean {
  const message = body?.message;
  return (
    body?.messageType === 'conversation' &&
    body.status !== 'EDITED' &&
    typeof message?.conversation === 'string' &&
    Object.keys(message).every((key) =>
      ['conversation', 'senderKeyDistributionMessage', 'messageContextInfo'].includes(key),
    )
  );
}

export function resolveInboundNativeBody(sources: InboundPayload[], stored: InboundPayload): InboundPayload {
  if (sources.length >= 3) throw new Error('InboundNativeSourceAmbiguous');
  if (
    stored.key?.fromMe === false &&
    plainTransportBody(stored) &&
    stored.message.conversation.length > 0 &&
    sources.length
  ) {
    const normalizedStored = canonicalInboundBody(stored);
    // An exact provider-original snapshot must still exist, including its timestamp and transport bytes.
    const anchor = sources.some(
      (source) =>
        plainTransportBody(source) &&
        inboundPayloadHash(canonicalInboundBody(source)) === inboundPayloadHash(normalizedStored),
    );
    const semantic = (source: InboundPayload) => ({
      ...source,
      message: { conversation: stored.message.conversation },
      messageTimestamp: stored.messageTimestamp,
    });
    const sameEntity = sources.every((source) => {
      if (!plainTransportBody(source)) return false;
      const text = source.message.conversation;
      // A blank sender-key transport copy is not an edit/delete command.
      if (text !== stored.message.conversation && !(text === '' && source.message.senderKeyDistributionMessage))
        return false;
      return (
        inboundPayloadHash(canonicalInboundBody(semantic(source))) ===
        inboundPayloadHash(canonicalInboundBody(semantic(stored)))
      );
    });
    if (anchor && sameEntity) return normalizedStored;
  }
  // Sender-key retransmissions can retain the exact image with a newer transport timestamp.
  if (
    stored.key?.fromMe === false &&
    stored.messageType === 'imageMessage' &&
    stored.status !== 'EDITED' &&
    stored.message?.imageMessage &&
    sources.length
  ) {
    const normalized = canonicalInboundBody(stored);
    const anchor = sources.some(
      (source) => inboundPayloadHash(canonicalInboundBody(source)) === inboundPayloadHash(normalized),
    );
    const semantic = (source: InboundPayload) => {
      const projected = canonicalInboundBody(source);
      const message = { ...projected.message };
      delete message.senderKeyDistributionMessage;
      return { ...projected, message, messageTimestamp: stored.messageTimestamp };
    };
    if (
      anchor &&
      sources.every(
        (source) =>
          source.messageType === 'imageMessage' &&
          source.status !== 'EDITED' &&
          inboundPayloadHash(semantic(source)) === inboundPayloadHash(semantic(stored)),
      )
    )
      return normalized;
  }
  if (sources.length > 1 && new Set(sources.map((source) => inboundSourceIdentityHash(source))).size !== 1)
    throw new Error('InboundNativeSourceAmbiguous');
  return canonicalInboundBody(sources[0] ?? stored);
}

// Back-pointer CAS remains per native row. Source roster changes still invalidate an in-flight delivery.
export function inboundNativeSnapshot(sources: InboundPayload[]): string {
  return JSON.stringify(
    sources.map((source) => [source.id ?? null, source.status ?? null, inboundPayloadHash(source)]).sort(),
  );
}

const historyMediaTypes = ['documentMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage'];

// Compatibility path for an unchanged ordinary media message whose receiver row
// was written by the stock cached-media importer (history) and stamped with the
// importer projection. It never substitutes a rendered-text hash: the caller
// still verifies the full stored bytes against the native SHA/length.
export async function inboundHistoryDocumentProjection(
  native: InboundPayload,
  queued: InboundPayload,
): Promise<InboundPayload> {
  const type = native.messageType;
  if (
    !historyMediaTypes.includes(type) ||
    queued.messageType !== type ||
    native.status === 'EDITED' ||
    queued.status === 'EDITED' ||
    !native.instanceId ||
    native.instanceId !== queued.instanceId ||
    !native.key?.id ||
    typeof native.key?.fromMe !== 'boolean' ||
    typeof native.key?.remoteJid !== 'string' ||
    !/^\d+(?::\d+)?@(s\.whatsapp\.net|hosted|lid|hosted\.lid|g\.us)$/.test(native.key.remoteJid) ||
    (native.key.remoteJidAlt !== undefined &&
      (typeof native.key.remoteJidAlt !== 'string' ||
        !/^\d+(?::\d+)?@(s\.whatsapp\.net|hosted)$/.test(native.key.remoteJidAlt))) ||
    !Number.isSafeInteger(native.messageTimestamp) ||
    native.messageTimestamp <= 0 ||
    !native.message?.[type] ||
    !queued.message?.[type]
  )
    throw new Error('InboundHistorySourceUnconfirmed');
  for (const body of [native, queued]) {
    const media = canonicalInboundBody(body).message[type];
    for (const field of ['fileSha256', 'fileEncSha256', 'mediaKey'])
      if (typeof media[field] !== 'string' || Buffer.from(media[field], 'base64').length !== 32)
        throw new Error('InboundHistoryBytesInvalid');
  }
  const mediaUrl = canonicalInboundBody(native).message.mediaUrl;
  if (
    mediaUrl !== undefined &&
    (typeof mediaUrl !== 'string' ||
      mediaUrl.length > 32768 ||
      !/^https:\/\//.test(mediaUrl) ||
      /[\r\n]/.test(mediaUrl))
  )
    throw new Error('InboundHistoryLocatorInvalid');
  if (inboundSourceIdentityHash(queued) !== inboundSourceIdentityHash(native))
    throw new Error('InboundHistorySourceChanged');
  const normalized = await normalizeStoredHistoryMessages([native as any], [native as any], undefined, {
    retainProviderAliases: true,
    includeGroups: true,
    includeUnresolvedLids: false,
  });
  if (normalized.messages.length !== 1) throw new Error('InboundHistoryIdentityUnconfirmed');
  return normalized.messages[0];
}
