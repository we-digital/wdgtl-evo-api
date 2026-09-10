import { chatwootEvoRouteBindingsEqual } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';
import { isChatwootOutgoingMessageType } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-message-api';
import { StoredChatwootOutboundOperation } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';
import { matchesChatwootOutboundProvenance } from '@api/types/outbound-provenance';
import { Chatwoot as ChatwootModel } from '@prisma/client';

export const chatwootOutboundDestination = (conversation: any): string =>
  conversation?.meta?.sender?.identifier || conversation?.meta?.sender?.phone_number?.replace(/^\+/, '') || '';

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
  const { operation, provider, currentInbox, conversation } = params;
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
    !currentInbox ||
    Number(currentInbox.id) !== origin.inboxId ||
    currentInbox.name !== origin.inboxName ||
    !chatwootEvoRouteBindingsEqual(params.currentRoute as any, origin.routeBinding) ||
    Number(conversation?.id) !== origin.conversationId ||
    Number(conversation?.account_id) !== origin.accountId ||
    Number(conversation?.inbox_id) !== origin.inboxId ||
    chatwootOutboundDestination(conversation) !== operation.payload.chatId
  )
    return false;

  if (origin.contactInboxSourceId) {
    const currentSourceId =
      conversation?.contact_inbox?.source_id ||
      conversation?.last_non_activity_message?.conversation?.contact_inbox?.source_id;
    if (currentSourceId && currentSourceId !== origin.contactInboxSourceId) return false;
  }
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
      currentMessage.route?.inbox_name === origin.inboxName &&
      currentMessage.route?.channel_type === 'Channel::Api' &&
      chatwootEvoRouteBindingsEqual(currentMessage.route?.binding, origin.routeBinding),
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
