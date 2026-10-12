import { normalizeStoredHistoryMessages } from './chatwoot-history-sync';
import { InboundPayload, inboundPayloadHash } from './chatwoot-inbound-queue';

const transportByteFields = new Set([
  'axolotlSenderKeyDistributionMessage',
  'recipientKeyHash',
  'senderKeyHash',
  'messageSecret',
]);

// Prisma persists protobuf bytes as base64; events can serialize Uint8Array as numeric-key objects.
function transportBytes(value: any, field = ''): any {
  if (transportByteFields.has(field) && value && typeof value === 'object') {
    const bytes = value.type === 'Buffer' && Array.isArray(value.data) ? value.data : Object.values(value);
    const numericKeys = Array.isArray(value.data) || Object.keys(value).every((key, i) => key === String(i));
    if (numericKeys && bytes.length && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
      return Buffer.from(bytes).toString('base64');
  }
  if (Array.isArray(value)) return value.map((item) => transportBytes(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transportBytes(item, key)]));
  return value;
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
    const normalizedStored = transportBytes(stored);
    // An exact provider-original snapshot must still exist, including its timestamp and transport bytes.
    const anchor = sources.some(
      (source) =>
        plainTransportBody(source) &&
        inboundPayloadHash(transportBytes(source)) === inboundPayloadHash(normalizedStored),
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
        inboundPayloadHash(transportBytes(semantic(source))) === inboundPayloadHash(transportBytes(semantic(stored)))
      );
    });
    if (anchor && sameEntity) return stored;
  }
  if (sources.length > 1 && new Set(sources.map((source) => inboundPayloadHash(source))).size !== 1)
    throw new Error('InboundNativeSourceAmbiguous');
  return sources[0] ?? stored;
}

// Back-pointer CAS remains per native row. Source roster changes still invalidate an in-flight delivery.
export function inboundNativeSnapshot(sources: InboundPayload[]): string {
  return JSON.stringify(
    sources.map((source) => [source.id ?? null, source.status ?? null, inboundPayloadHash(source)]).sort(),
  );
}

// This compatibility path is only for an unchanged ordinary PDF/document recovered
// by the stock cached-media importer. It never substitutes a rendered-text hash.
export async function inboundHistoryDocumentProjection(
  native: InboundPayload,
  queued: InboundPayload,
): Promise<InboundPayload> {
  if (
    native.messageType !== 'documentMessage' ||
    queued.messageType !== 'documentMessage' ||
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
    !native.message?.documentMessage ||
    !queued.message?.documentMessage
  )
    throw new Error('InboundHistorySourceUnconfirmed');
  const bytePaths = [
    ['message', 'documentMessage', 'fileSha256'],
    ['message', 'documentMessage', 'fileEncSha256'],
    ['message', 'documentMessage', 'mediaKey'],
    ['message', 'documentMessage', 'jpegThumbnail'],
    ['message', 'messageContextInfo', 'messageSecret'],
    ['message', 'messageContextInfo', 'deviceListMetadata', 'recipientKeyHash'],
  ];
  const normalize = (source: InboundPayload) => {
    const result = JSON.parse(JSON.stringify(source));
    for (const path of bytePaths) {
      const parent = path.slice(0, -1).reduce((value, field) => value?.[field], result);
      const field = path[path.length - 1];
      if (parent?.[field] === undefined) continue;
      const value = parent[field];
      let bytes: Buffer;
      if (typeof value === 'string') {
        bytes = Buffer.from(value, 'base64');
        if (bytes.toString('base64') !== value) throw new Error('InboundHistoryBytesInvalid');
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entries = value.type === 'Buffer' && Array.isArray(value.data) ? value.data : Object.values(value);
        if (
          !(value.type === 'Buffer' && Object.keys(value).length === 2 && Array.isArray(value.data)) &&
          !Object.keys(value).every((key, index) => key === String(index))
        )
          throw new Error('InboundHistoryBytesInvalid');
        if (!entries.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
          throw new Error('InboundHistoryBytesInvalid');
        bytes = Buffer.from(entries);
      } else throw new Error('InboundHistoryBytesInvalid');
      if (
        !bytes.length ||
        bytes.length > 65536 ||
        (['fileSha256', 'fileEncSha256', 'mediaKey', 'messageSecret'].includes(field) && bytes.length !== 32)
      )
        throw new Error('InboundHistoryBytesInvalid');
      parent[field] = bytes.toString('base64');
    }
    return result;
  };
  const before = normalize(queued);
  const current = normalize(native);
  if (before.message.mediaUrl === undefined && current.message.mediaUrl !== undefined) {
    if (
      typeof current.message.mediaUrl !== 'string' ||
      current.message.mediaUrl.length > 32768 ||
      !/^https:\/\//.test(current.message.mediaUrl) ||
      /[\r\n]/.test(current.message.mediaUrl)
    )
      throw new Error('InboundHistoryLocatorInvalid');
    before.message.mediaUrl = current.message.mediaUrl;
  }
  if (inboundPayloadHash(before) !== inboundPayloadHash(current)) throw new Error('InboundHistorySourceChanged');
  const normalized = await normalizeStoredHistoryMessages([native as any], [native as any], undefined, {
    retainProviderAliases: true,
    includeGroups: true,
    includeUnresolvedLids: false,
  });
  if (normalized.messages.length !== 1) throw new Error('InboundHistoryIdentityUnconfirmed');
  return normalized.messages[0];
}
