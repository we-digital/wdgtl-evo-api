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
