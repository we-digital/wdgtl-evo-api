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
    const legacy = legacyDownloadStampBody(body);
    if (legacy) hashes.add(inboundPayloadHash(legacy));
  }
  return hashes;
}

// Same lists as TypeMediaMessage / MessageSubtype in wa.types (kept local: utils stay alias-free).
const downloadMediaTypes = [
  'imageMessage',
  'documentMessage',
  'audioMessage',
  'videoMessage',
  'stickerMessage',
  'ptvMessage',
];
const downloadWrappers = ['ephemeralMessage', 'documentWithCaptionMessage', 'viewOnceMessage', 'viewOnceMessageV2'];
const downloadKeyFields = ['mediaKey', 'fileSha256', 'fileEncSha256'];

// Until 2026-11-11 the media download turned these three fields of the delivered
// body into Buffers in place, before the receiver stamp was hashed. Every inbound
// media row delivered then carries this stamp; accepting it lets those rows confirm.
export function legacyDownloadStampBody(body: InboundPayload): InboundPayload | null {
  const legacy = canonicalInboundBody(body);
  let node = legacy.message;
  for (const wrapper of downloadWrappers) if (node?.[wrapper]?.message) node = node[wrapper].message;
  const type = downloadMediaTypes.find((name) => node?.[name] && typeof node[name] === 'object');
  if (!type) return null;
  const media = node[type];
  let changed = false;
  for (const field of downloadKeyFields)
    if (typeof media[field] === 'string') {
      media[field] = Buffer.from(media[field], 'base64');
      changed = true;
    }
  return changed ? legacy : null;
}
// A blank-text sender-key distribution copy carries no user content. WhatsApp
// sends it to (re)distribute group keys; Chatwoot can never render it.
export function isInboundTransportOnly(body: InboundPayload): boolean {
  return plainTransportBody(body) && body.message.conversation === '' && !!body.message.senderKeyDistributionMessage;
}
const retransmittedMediaTypes = new Set([
  'imageMessage',
  'documentMessage',
  'videoMessage',
  'audioMessage',
  'stickerMessage',
  'ptvMessage',
]);
// Copies of one WhatsApp key that delivery may reconcile. Queries read one more
// than this so an overflow is seen and refused instead of silently truncated.
export const MAX_NATIVE_COPIES = 4;
export const NATIVE_COPY_QUERY_LIMIT = MAX_NATIVE_COPIES + 1;

// An empty plain text copy under a key carries no content at all (with or
// without a sender-key sidecar). Edits/deletes arrive as protocol messages.
export function isBlankNativeCopy(body: InboundPayload): boolean {
  return plainTransportBody(body) && body.message.conversation === '';
}

const bareJid = (jid: string) => jid.replace(/:\d+@/, '@');
// Every sender identity a copy carries about itself: the key participant and its
// LID/PN alternate (participantAlt, participantPn, participantLid) and the
// stored participant column. A copy with none of them asserts no sender.
export function nativeSenderIdentities(body: InboundPayload): Set<string> {
  const key = body?.key ?? {};
  return new Set(
    [key.participant, key.participantAlt, key.participantPn, key.participantLid, body?.participant]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .map(bareJid),
  );
}
const sameIdentities = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((v) => b.has(v));

// Same sender, proven only from what the copies say about themselves: one copy
// names the other's LID or phone-number form (WhatsApp sends both on a LID-addressed
// copy), or one copy names nobody. Disjoint identities are different people.
function provenSameSender(a: InboundPayload, b: InboundPayload): boolean {
  const left = nativeSenderIdentities(a);
  const right = nativeSenderIdentities(b);
  if (left.size && right.size && ![...left].some((value) => right.has(value))) return false;
  // Identical addressing: nothing explains a different display name.
  if (sameIdentities(left, right) && (a.pushName ?? null) !== (b.pushName ?? null)) return false;
  return true;
}

const mediaCopyKeys = new Set(['senderKeyDistributionMessage', 'messageContextInfo', 'mediaUrl', 'base64']);
// Same content, proven by text equality or by the sender's per-message media
// secret and file hashes (a forward would carry another key id).
function provenSameContent(a: InboundPayload, b: InboundPayload): boolean {
  if (a.messageType !== b.messageType || a.status === 'EDITED' || b.status === 'EDITED') return false;
  if ((a.contextInfo?.stanzaId ?? null) !== (b.contextInfo?.stanzaId ?? null)) return false;
  if (a.messageType === 'conversation')
    return (
      plainTransportBody(a) &&
      plainTransportBody(b) &&
      a.message.conversation.length > 0 &&
      a.message.conversation === b.message.conversation
    );
  if (!retransmittedMediaTypes.has(a.messageType)) return false;
  const [left, right] = [canonicalInboundBody(a).message, canonicalInboundBody(b).message];
  const type = a.messageType;
  if (![left, right].every((m) => m?.[type] && Object.keys(m).every((k) => k === type || mediaCopyKeys.has(k))))
    return false;
  return (
    ['mediaKey', 'fileSha256', 'fileEncSha256'].every(
      (field) => typeof left[type][field] === 'string' && left[type][field] === right[type][field],
    ) && ['caption', 'fileName', 'mimetype'].every((field) => (left[type][field] ?? '') === (right[type][field] ?? ''))
  );
}

// A notify upsert under a key that already has a native row is a WhatsApp
// retransmission (edits arrive as protocol messages, history as append), not
// new content. Storing it again made every later lookup of the key ambiguous.
export function isNativeRetransmission(existing: InboundPayload[], incoming: InboundPayload): boolean {
  if (isInboundTransportOnly(incoming)) return true;
  if (existing.length && isBlankNativeCopy(incoming)) return true;
  // Keep the copy that names its group sender when every stored row names nobody
  // (history-synced copies lose the key participant): delivery reconciles both.
  if (
    incoming.key?.remoteJid?.endsWith('@g.us') &&
    nativeSenderIdentities(incoming).size &&
    existing.length &&
    existing.every((row) => !nativeSenderIdentities(row).size)
  )
    return false;
  return existing.some(
    (row) =>
      row.messageType === incoming.messageType &&
      row.messageType !== 'reactionMessage' &&
      row.status !== 'EDITED' &&
      incoming.status !== 'EDITED',
  );
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
  if (sources.length > MAX_NATIVE_COPIES) throw new Error('InboundNativeSourceAmbiguous');
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
  // Sender-key retransmissions keep the exact media under the same key with a
  // newer transport timestamp, a different sender-key/context envelope or a
  // retained mediaUrl, or come as a blank sender-key-only copy (prod 2026-11-11:
  // image+blank and document+document pairs on every instance of a group).
  if (
    stored.key?.fromMe === false &&
    retransmittedMediaTypes.has(stored.messageType) &&
    stored.status !== 'EDITED' &&
    stored.message?.[stored.messageType] &&
    sources.length > 1
  ) {
    // The provider-original row must still exist; S3 retention may have added a mediaUrl to it.
    const anchor = sources.find((source) => inboundSourceIdentityHash(source) === inboundSourceIdentityHash(stored));
    const semantic = (source: InboundPayload) => {
      const projected = canonicalInboundBody(source);
      const message = withoutLocators(projected.message, true);
      delete message.senderKeyDistributionMessage;
      delete message.messageContextInfo;
      return { ...projected, message, messageTimestamp: stored.messageTimestamp };
    };
    if (
      anchor &&
      sources.every(
        (source) =>
          (isInboundTransportOnly(source) && source.key?.fromMe === false) ||
          (source.messageType === stored.messageType &&
            source.status !== 'EDITED' &&
            inboundPayloadHash(semantic(source)) === inboundPayloadHash(semantic(stored))),
      )
    )
      return canonicalInboundBody(anchor);
  }
  // Copies that differ in sender addressing (prod 2026-11-11): a LID-addressed copy
  // with its phone-number alternate, and a copy that names no sender at all
  // (history sync), each with its own pushName, thumbnail and context envelope.
  if (stored.status !== 'EDITED' && sources.length > 1) {
    const anchor = sources.find((source) => inboundSourceIdentityHash(source) === inboundSourceIdentityHash(stored));
    const same = (source: InboundPayload) =>
      source.key?.id === anchor!.key?.id &&
      source.key?.remoteJid === anchor!.key?.remoteJid &&
      source.key?.fromMe === anchor!.key?.fromMe &&
      provenSameSender(anchor!, source) &&
      provenSameContent(anchor!, source);
    const addressingDiffers =
      !!anchor &&
      sources.some((source) => !sameIdentities(nativeSenderIdentities(source), nativeSenderIdentities(anchor)));
    if (
      anchor &&
      // Outgoing copies reconcile only on an addressing difference, never on a
      // repeated identical outgoing row.
      (anchor.key?.fromMe === false || addressingDiffers) &&
      sources.every(
        (source) =>
          source === anchor ||
          (isBlankNativeCopy(source) && source.key?.fromMe === anchor.key?.fromMe && source.key?.fromMe === false) ||
          same(source),
      )
    )
      return canonicalInboundBody(anchor);
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
