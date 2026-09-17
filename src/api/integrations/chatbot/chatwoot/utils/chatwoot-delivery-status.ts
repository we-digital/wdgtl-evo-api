import {
  isChatwootOutgoingMessageType,
  unwrapChatwootPayload,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-message-api';

export const buildChatwootDeliveryFailureUpdate = (accountId: number, conversationId: number, messageId: number) => ({
  accountId,
  conversationId,
  messageId,
  data: {
    status: 'failed',
    external_error: 'EVO WhatsApp delivery failed',
  },
});

export interface ChatwootProviderDeliveryPart {
  partKey: string;
  partIndex: number;
  partCount: number;
  sourceId: string;
}

export interface ChatwootProviderContext {
  snapshot_version: 1;
  snapshot_fingerprint: string;
  binding: {
    version: number;
    provider: string;
    inbox_id: number;
    instance_id: string;
    instance_name: string;
    receiver_fingerprint: string;
  };
}

export const buildChatwootDeliverySuccessUpdate = (
  accountId: number,
  conversationId: number,
  messageId: number,
  whatsappMessageId: string,
  providerPart?: ChatwootProviderDeliveryPart,
  providerContext?: ChatwootProviderContext,
) => ({
  accountId,
  conversationId,
  messageId,
  data: {
    status: 'sent',
    source_id: whatsappMessageId,
    external_error: null,
    ...(providerPart
      ? {
          provider_delivery: {
            part_key: providerPart.partKey,
            part_index: providerPart.partIndex,
            part_count: providerPart.partCount,
          },
        }
      : {}),
    ...(providerContext ? { provider_context: providerContext } : {}),
  },
});

export const isChatwootDeliverySuccessAcknowledged = (
  response: unknown,
  messageId: number,
  whatsappMessageId: string,
): boolean => {
  const acknowledgement = unwrapChatwootPayload(response) as {
    id?: unknown;
    source_id?: unknown;
    status?: unknown;
  } | null;
  return (
    Number(acknowledgement?.id) === messageId &&
    acknowledgement?.source_id === whatsappMessageId &&
    ['sent', 'delivered', 'read'].includes(String(acknowledgement?.status))
  );
};

const isCanonicalProviderPartSet = (parts: ChatwootProviderDeliveryPart[]): boolean =>
  parts.length > 0 &&
  parts.length <= 100 &&
  parts.every(
    (part, index) =>
      part.partIndex === index &&
      part.partCount === parts.length &&
      /^[a-zA-Z0-9:_-]{1,128}$/.test(part.partKey) &&
      typeof part.sourceId === 'string' &&
      part.sourceId.length > 0,
  ) &&
  new Set(parts.map((part) => part.partKey)).size === parts.length &&
  new Set(parts.map((part) => part.sourceId)).size === parts.length;

export const isChatwootProviderDeliveryAcknowledged = (
  response: unknown,
  messageId: number,
  requestedPart: ChatwootProviderDeliveryPart,
  expectedParts: ChatwootProviderDeliveryPart[],
): boolean => {
  if (!isCanonicalProviderPartSet(expectedParts)) return false;
  const acknowledgement = unwrapChatwootPayload(response) as {
    id?: unknown;
    source_id?: unknown;
    status?: unknown;
    provider_delivery?: {
      contract_version?: unknown;
      acknowledged?: unknown;
      message_confirmed?: unknown;
      part_key?: unknown;
      part_index?: unknown;
      part_count?: unknown;
      acknowledged_part_count?: unknown;
      source_ids?: unknown;
    };
  } | null;
  const delivery = acknowledgement?.provider_delivery;
  if (
    Number(acknowledgement?.id) !== messageId ||
    !['sent', 'delivered', 'read', 'failed'].includes(String(acknowledgement?.status)) ||
    delivery?.contract_version !== 1 ||
    delivery?.acknowledged !== true ||
    typeof delivery?.message_confirmed !== 'boolean' ||
    delivery?.part_key !== requestedPart.partKey ||
    delivery?.part_index !== requestedPart.partIndex ||
    delivery?.part_count !== requestedPart.partCount ||
    !Array.isArray(delivery?.source_ids)
  ) {
    return false;
  }

  const expectedByKey = new Map(expectedParts.map((part) => [part.partKey, part]));
  const persisted = delivery.source_ids as Array<{
    part_key?: unknown;
    part_index?: unknown;
    source_id?: unknown;
  }>;
  const normalized = persisted
    .map((part) => ({ partKey: part?.part_key, partIndex: part?.part_index, sourceId: part?.source_id }))
    .sort((left, right) => Number(left.partIndex) - Number(right.partIndex));
  if (
    delivery.acknowledged_part_count !== normalized.length ||
    normalized.length === 0 ||
    normalized.length > expectedParts.length ||
    new Set(normalized.map((part) => part.partKey)).size !== normalized.length ||
    new Set(normalized.map((part) => part.partIndex)).size !== normalized.length ||
    normalized.some((part) => {
      if (typeof part.partKey !== 'string') return true;
      const expected = expectedByKey.get(part.partKey);
      return !expected || expected.partIndex !== part.partIndex || expected.sourceId !== part.sourceId;
    })
  ) {
    return false;
  }

  const requestedAcknowledged = normalized.some(
    (part) =>
      part.partKey === requestedPart.partKey &&
      part.partIndex === requestedPart.partIndex &&
      part.sourceId === requestedPart.sourceId,
  );
  const complete =
    normalized.length === expectedParts.length &&
    normalized.every((part, index) => part.partIndex === index) &&
    delivery.message_confirmed === true;
  if (!requestedAcknowledged || delivery.message_confirmed !== (normalized.length === expectedParts.length)) {
    return false;
  }
  if (complete) {
    return (
      ['sent', 'delivered', 'read'].includes(String(acknowledgement?.status)) &&
      acknowledgement?.source_id === expectedParts[0].sourceId
    );
  }
  return true;
};

export const isChatwootDeliveryFailureAcknowledged = (response: unknown, messageId: number): boolean => {
  const acknowledgement = unwrapChatwootPayload(response) as { id?: unknown; status?: unknown } | null;
  return Number(acknowledgement?.id) === messageId && acknowledgement?.status === 'failed';
};

export const isChatwootMessageDeletion = (body: any): boolean =>
  body?.event === 'message_updated' && body?.content_attributes?.deleted === true;

/** Sync probe from Chatwoot mute/unmute (conversation-level, includes groups). */
export const isChatwootNativeMuteProbe = (body: any): boolean =>
  body?.event === 'conversation_updated' && body?.native_mute_probe === true;

/** Sync probe from Chatwoot pin/unpin. */
export const isChatwootNativePinProbe = (body: any): boolean =>
  body?.event === 'conversation_updated' && body?.native_pin_probe === true;

/** Sync probe from Chatwoot archive/unarchive. */
export const isChatwootNativeArchiveProbe = (body: any): boolean =>
  body?.event === 'conversation_updated' && body?.native_archive_probe === true;

/** Sync probe from Chatwoot EditService (native-first). Async message_updated after DB write omits the probe. */
export const isChatwootMessageEdit = (body: any): boolean =>
  body?.event === 'message_updated' &&
  body?.content_attributes?.edited === true &&
  body?.content_attributes?.native_edit_probe === true &&
  !body?.content_attributes?.deleted &&
  typeof body?.content === 'string';

export const isDeliverableChatwootOutgoing = (body: any, chatId: string): boolean =>
  body?.event === 'message_created' &&
  isChatwootOutgoingMessageType(body?.message_type) &&
  Number.isSafeInteger(Number(body?.id)) &&
  Number(body.id) > 0 &&
  chatId !== '123456' &&
  !(typeof body?.source_id === 'string' && body.source_id.startsWith('WAID:'));
