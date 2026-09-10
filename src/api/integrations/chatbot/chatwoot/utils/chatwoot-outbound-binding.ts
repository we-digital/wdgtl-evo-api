import { chatwootEvoRouteBindingsEqual } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';
import { StoredChatwootOutboundOperation } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';
import { Chatwoot as ChatwootModel } from '@prisma/client';

export const chatwootOutboundDestination = (conversation: any): string =>
  conversation?.meta?.sender?.identifier || conversation?.meta?.sender?.phone_number?.replace(/^\+/, '') || '';

export const validatesCurrentChatwootOutboundSnapshot = (params: {
  operation: StoredChatwootOutboundOperation;
  provider: ChatwootModel;
  currentInbox: any;
  conversation: any;
  messages?: any[];
  expectedRoute: unknown;
  currentRoute: unknown;
  requireMessage: boolean;
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
  if (!params.requireMessage) return true;
  const currentMessage = params.messages?.find((candidate: any) => Number(candidate?.id) === origin.messageId);
  return Boolean(
    currentMessage &&
      currentMessage.message_type === 'outgoing' &&
      currentMessage?.content_attributes?.deleted !== true &&
      (currentMessage.conversation_id === undefined ||
        Number(currentMessage.conversation_id) === origin.conversationId),
  );
};
