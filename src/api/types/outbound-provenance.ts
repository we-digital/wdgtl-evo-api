import { randomUUID } from 'node:crypto';

export type OutboundMessageOrigin = 'api' | 'chatwoot';

export interface OutboundMessageProvenance {
  version: 1;
  origin: OutboundMessageOrigin;
  requestId: string;
  chatwootMessageId?: number;
  chatwootInboxId?: number;
  chatwootConversationId?: number;
}

const OPAQUE_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveOutboundRequestId(candidate?: string): string {
  return candidate && OPAQUE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

export function attachOutboundProvenance<T extends { contextInfo?: unknown }>(
  message: T,
  provenance?: OutboundMessageProvenance,
): T {
  if (!provenance) {
    return message;
  }

  const contextInfo =
    message.contextInfo && typeof message.contextInfo === 'object' && !Array.isArray(message.contextInfo)
      ? message.contextInfo
      : {};

  return {
    ...message,
    contextInfo: {
      ...contextInfo,
      weDigitalOutbound: provenance,
    },
  };
}

export function matchesChatwootOutboundProvenance(
  contextInfo: unknown,
  expected: Required<
    Pick<OutboundMessageProvenance, 'requestId' | 'chatwootMessageId' | 'chatwootInboxId' | 'chatwootConversationId'>
  >,
): boolean {
  if (!contextInfo || typeof contextInfo !== 'object' || Array.isArray(contextInfo)) return false;
  const provenance = (contextInfo as any).weDigitalOutbound;
  return Boolean(
    provenance &&
      provenance.version === 1 &&
      provenance.origin === 'chatwoot' &&
      provenance.requestId === expected.requestId &&
      Number(provenance.chatwootMessageId) === expected.chatwootMessageId &&
      Number(provenance.chatwootInboxId) === expected.chatwootInboxId &&
      Number(provenance.chatwootConversationId) === expected.chatwootConversationId,
  );
}
