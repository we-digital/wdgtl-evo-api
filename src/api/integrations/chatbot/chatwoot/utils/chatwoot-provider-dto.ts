import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { Chatwoot as ChatwootModel } from '@prisma/client';

export const toChatwootProviderDto = (data: ChatwootModel): ChatwootDto => ({
  id: data.id,
  enabled: data.enabled,
  accountId: data.accountId ?? undefined,
  token: data.token ?? undefined,
  url: data.url ?? undefined,
  nameInbox: data.nameInbox ?? undefined,
  signMsg: data.signMsg,
  signDelimiter: data.signDelimiter ?? undefined,
  reopenConversation: data.reopenConversation,
  conversationPending: data.conversationPending,
  mergeBrazilContacts: data.mergeBrazilContacts,
  importContacts: data.importContacts,
  importMessages: data.importMessages,
  daysLimitImportMessages: data.daysLimitImportMessages ?? undefined,
  organization: data.organization ?? undefined,
  logo: data.logo ?? undefined,
  ignoreJids: Array.isArray(data.ignoreJids) ? data.ignoreJids.map((event) => String(event)) : [],
});
