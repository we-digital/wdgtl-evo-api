import { chatwootEvoRouteBindingsEqual } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';
import { isChatwootOutgoingMessageType } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-message-api';
import { StoredChatwootOutboundOperation } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';
import { matchesChatwootOutboundProvenance } from '@api/types/outbound-provenance';
import { Chatwoot as ChatwootModel } from '@prisma/client';

export const chatwootOutboundDestination = (conversation: any): string =>
  conversation?.meta?.sender?.identifier || conversation?.meta?.sender?.phone_number?.replace(/^\+/, '') || '';

const positiveInteger = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

export const chatwootOutboundContactIdentity = (body: any) => ({
  contactInboxSourceId: body?.conversation?.contact_inbox?.source_id,
  contactId:
    positiveInteger(body?.conversation?.meta?.sender?.id) ??
    positiveInteger(body?.conversation?.contact_inbox?.contact_id),
  contactInboxId: positiveInteger(body?.conversation?.contact_inbox?.id),
});

export const validatesCurrentChatwootOutboundSnapshot = (params: {
  operation: StoredChatwootOutboundOperation;
  provider: ChatwootModel;
  currentInbox: any;
  conversation: any;
  currentMessage?: any;
  expectedRoute: unknown;
  currentRoute: unknown;
  expectedDeleted?: boolean;
}): boolean => {
  const { operation, provider } = params;
  const { origin } = operation.payload;
  if (
    provider.enabled !== true ||
    provider.id !== origin.providerId ||
    provider.url?.replace(/\/+$/, '') !== origin.baseUrl ||
    Number(provider.accountId) !== origin.accountId ||
    provider.nameInbox !== origin.inboxName ||
    operation.chatwootMessageId !== origin.messageId ||
    operation.chatwootInboxId !== origin.inboxId ||
    operation.chatwootConversationId !== origin.conversationId ||
    origin.routeBinding.instance_id !== operation.instanceId ||
    origin.routeBinding.inbox_id !== origin.inboxId ||
    !chatwootEvoRouteBindingsEqual(params.expectedRoute as any, origin.routeBinding) ||
    !chatwootEvoRouteBindingsEqual(params.currentRoute as any, origin.routeBinding)
  )
    return false;

  const currentMessage = params.currentMessage;
  return Boolean(
    currentMessage &&
      Number(currentMessage.contract_version) === 1 &&
      Number(currentMessage.account_id) === origin.accountId &&
      Number(currentMessage.inbox_id) === origin.inboxId &&
      Number(currentMessage.conversation_id) === origin.conversationId &&
      Number(currentMessage.message_id) === origin.messageId &&
      isChatwootOutgoingMessageType(currentMessage.message_type_name ?? currentMessage.message_type) &&
      currentMessage.deleted === (params.expectedDeleted ?? false) &&
      currentMessage.destination === operation.payload.chatId &&
      (!origin.contactInboxSourceId || currentMessage.contact_inbox_source_id === origin.contactInboxSourceId) &&
      (!origin.contactId || Number(currentMessage.contact_id) === origin.contactId) &&
      (!origin.contactInboxId || Number(currentMessage.contact_inbox_id) === origin.contactInboxId) &&
      currentMessage.route?.inbox_name === origin.inboxName &&
      currentMessage.route?.channel_type === 'Channel::Api' &&
      chatwootEvoRouteBindingsEqual(currentMessage.route?.binding, origin.routeBinding) &&
      Number(currentMessage.outbound_snapshot?.version) === 1 &&
      /^[a-f0-9]{64}$/.test(String(origin.snapshotFingerprint || '')) &&
      /^[a-f0-9]{64}$/.test(String(currentMessage.outbound_snapshot?.fingerprint || '')) &&
      ((params.expectedDeleted ?? false) ||
        currentMessage.outbound_snapshot.fingerprint === origin.snapshotFingerprint),
  );
};

export const validatesLocalChatwootDeletionBinding = (
  message: {
    chatwootMessageId?: number | null;
    chatwootInboxId?: number | null;
    chatwootConversationId?: number | null;
    contextInfo?: unknown;
  },
  operation: StoredChatwootOutboundOperation,
): boolean => {
  const origin = operation.payload.origin;
  if (
    !matchesChatwootOutboundProvenance(message.contextInfo, {
      requestId: operation.operationKey,
      chatwootMessageId: origin.messageId,
      chatwootInboxId: origin.inboxId,
      chatwootConversationId: origin.conversationId,
    })
  )
    return false;
  const topLevelMappings = [message.chatwootMessageId, message.chatwootInboxId, message.chatwootConversationId];
  if (topLevelMappings.every((value) => value === null || value === undefined)) return true;
  return (
    message.chatwootMessageId === origin.messageId &&
    message.chatwootInboxId === origin.inboxId &&
    message.chatwootConversationId === origin.conversationId
  );
};
