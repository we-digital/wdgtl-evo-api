import { MessageUserReceiptUpdate } from 'baileys';

export const CHATWOOT_READ_STATE_HEADER = 'X-Chatwoot-Read-State-Token';

export type ExternalReadRequest = {
  url: string;
  headers: Record<string, string>;
  data: {
    message_id: number;
    source: 'whatsapp';
    source_cursor: string;
  };
};

export function selectWhatsAppOwnerReadTimestamps(updates: MessageUserReceiptUpdate[]): Record<string, number> {
  const timestamps: Record<string, number> = {};

  for (const update of updates) {
    const remoteJid = update.key.remoteJid;
    const readTimestamp = update.receipt.readTimestamp;

    // Baileys emits group receipt updates both when another group participant
    // reads one of our outgoing messages (fromMe=true) and when another linked
    // device of this WhatsApp account reads incoming messages (fromMe=false).
    // Only the latter is an owner read position.
    if (!remoteJid?.endsWith('@g.us') || update.key.fromMe !== false || typeof readTimestamp !== 'number') {
      continue;
    }

    timestamps[remoteJid] = Math.max(timestamps[remoteJid] ?? 0, readTimestamp);
  }

  return timestamps;
}

export function buildWhatsAppReadCursor(params: {
  instanceId: string;
  remoteJid: string;
  readTimestamp: number;
  chatwootMessageId: number;
}): string {
  return `wa-read:${params.instanceId}:${params.remoteJid}:${params.readTimestamp}:${params.chatwootMessageId}`;
}

export function buildExternalReadRequest(params: {
  baseUrl: string;
  accountId: number | string;
  conversationId: number;
  messageId: number;
  sourceCursor: string;
  token: string;
}): ExternalReadRequest {
  const baseUrl = params.baseUrl.replace(/\/+$/, '');

  return {
    url: `${baseUrl}/api/v1/accounts/${params.accountId}/conversations/${params.conversationId}/external_read`,
    headers: { [CHATWOOT_READ_STATE_HEADER]: params.token },
    data: {
      message_id: params.messageId,
      source: 'whatsapp',
      source_cursor: params.sourceCursor,
    },
  };
}
