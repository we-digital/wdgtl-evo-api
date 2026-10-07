import { Constructor } from '@api/integrations/integration.dto';

export class ChatwootDto {
  id?: string;
  instanceId?: string;
  enabled?: boolean;
  accountId?: string;
  token?: string;
  url?: string;
  nameInbox?: string;
  signMsg?: boolean;
  signDelimiter?: string;
  number?: string;
  reopenConversation?: boolean;
  conversationPending?: boolean;
  mergeBrazilContacts?: boolean;
  importContacts?: boolean;
  importMessages?: boolean;
  daysLimitImportMessages?: number;
  autoCreate?: boolean;
  organization?: string;
  logo?: string;
  ignoreJids?: string[];
  webhookSecret?: string;
  webhookPreviousSecret?: string;
  webhookPreviousSecretValidUntil?: string | Date;
}

export class ChatwootHistorySyncDto {
  dryRun?: boolean;
  since?: string;
  remoteJid?: string;
  limit?: number;
  scope?: 'direct' | 'groups' | 'all';
  unresolvedLidMode?: 'skip' | 'provisional';
  refreshLidMappings?: boolean;
}

export class ChatwootHistorySyncBatchMessageDto {
  sourceId: string;
  message: Record<string, unknown>;
}

export class ChatwootHistoryRecoveryBatchMessageDto extends ChatwootHistorySyncBatchMessageDto {
  expectedDirection: 'incoming' | 'outgoing';
}

export class ChatwootHistorySyncBatchDto {
  contractVersion: '2026-08-01';
  dryRun: false;
  scope: 'direct' | 'groups' | 'all';
  unresolvedLidMode: 'skip' | 'provisional';
  refreshLidMappings: boolean;
  messages: ChatwootHistorySyncBatchMessageDto[];
}

export class ChatwootHistoryRecoveryBatchDto {
  contractVersion: '2026-08-28';
  dryRun: false;
  scope: 'direct' | 'groups' | 'all';
  unresolvedLidMode: 'skip' | 'provisional';
  refreshLidMappings: boolean;
  recoveryMode: 'standard' | 'maximize';
  expectedDestinationKey: string;
  expectedInboxId: number;
  messages: ChatwootHistoryRecoveryBatchMessageDto[];
}

export class ChatwootHistoryMappingReconcileDto {
  contractVersion: '2026-10-08';
  dryRun: boolean;
  expectedDestinationKey: string;
  expectedInboxId: number;
  messages: ChatwootHistoryRecoveryBatchMessageDto[];
}

export function ChatwootInstanceMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    chatwootAccountId?: string;
    chatwootToken?: string;
    chatwootUrl?: string;
    chatwootSignMsg?: boolean;
    chatwootReopenConversation?: boolean;
    chatwootConversationPending?: boolean;
    chatwootMergeBrazilContacts?: boolean;
    chatwootImportContacts?: boolean;
    chatwootImportMessages?: boolean;
    chatwootDaysLimitImportMessages?: number;
    chatwootNameInbox?: string;
    chatwootOrganization?: string;
    chatwootLogo?: string;
    chatwootAutoCreate?: boolean;
  };
}
