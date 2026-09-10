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

type ChatwootOutboundMessageIdLookup = (whatsappMessageId: string) => Promise<boolean>;

interface ChatwootOutboundMessageIdRepository {
  chatwootOutboundOperation: {
    findMany(args: {
      where: {
        instanceId: string;
        OR: Array<{ plannedWhatsappMessageId?: string; whatsappMessageId?: string }>;
      };
      select: {
        instanceId: true;
        plannedWhatsappMessageId: true;
        whatsappMessageId: true;
      };
    }): Promise<
      Array<{
        instanceId: string;
        plannedWhatsappMessageId: string;
        whatsappMessageId: string | null;
      }>
    >;
  };
}

export async function isRetainedChatwootOutboundMessageId(
  repository: ChatwootOutboundMessageIdRepository,
  instanceId: unknown,
  whatsappMessageId: string,
): Promise<boolean> {
  if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 100 || /\s/.test(instanceId)) {
    return false;
  }

  const operations = await repository.chatwootOutboundOperation.findMany({
    where: {
      instanceId,
      OR: [{ plannedWhatsappMessageId: whatsappMessageId }, { whatsappMessageId }],
    },
    select: {
      instanceId: true,
      plannedWhatsappMessageId: true,
      whatsappMessageId: true,
    },
  });
  return operations.some(
    (operation) =>
      operation.instanceId === instanceId &&
      (operation.plannedWhatsappMessageId === whatsappMessageId || operation.whatsappMessageId === whatsappMessageId),
  );
}

export async function isChatwootOutboundEcho(
  message: unknown,
  isKnownChatwootOutboundMessageId?: ChatwootOutboundMessageIdLookup,
): Promise<boolean> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;

  const candidate = message as {
    key?: { fromMe?: unknown; id?: unknown };
    contextInfo?: unknown;
  };
  if (candidate.key?.fromMe !== true) return false;

  const whatsappMessageId = candidate.key?.id;
  if (
    typeof whatsappMessageId !== 'string' ||
    whatsappMessageId.length === 0 ||
    whatsappMessageId.length > 100 ||
    /\s/.test(whatsappMessageId)
  ) {
    return false;
  }

  const provenance =
    candidate.contextInfo && typeof candidate.contextInfo === 'object' && !Array.isArray(candidate.contextInfo)
      ? (candidate.contextInfo as any).weDigitalOutbound
      : null;
  const hasCompleteProvenance = Boolean(
    provenance &&
      provenance.version === 1 &&
      provenance.origin === 'chatwoot' &&
      typeof provenance.requestId === 'string' &&
      provenance.requestId.length > 0 &&
      provenance.requestId.length <= 128 &&
      Number.isSafeInteger(provenance.chatwootMessageId) &&
      provenance.chatwootMessageId > 0 &&
      Number.isSafeInteger(provenance.chatwootInboxId) &&
      provenance.chatwootInboxId > 0 &&
      Number.isSafeInteger(provenance.chatwootConversationId) &&
      provenance.chatwootConversationId > 0,
  );
  if (hasCompleteProvenance) return true;

  if (!isKnownChatwootOutboundMessageId) {
    return false;
  }

  return isKnownChatwootOutboundMessageId(whatsappMessageId);
}
