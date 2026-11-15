import { CHATWOOT_READ_STATE_HEADER } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-read-state';

// A WhatsApp READ/PLAYED receipt for one of our messages means the customer
// read the chat up to it. Chatwoot marks every earlier outgoing message read.
//
// The receipt often arrives before Chatwoot has the message: phone-sent
// messages reach Chatwoot through the bus and get their binding a moment
// later. Retry with growing pauses instead of dropping the receipt.
export const CONTACT_READ_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 45_000, 120_000] as const;

export type ContactReadRequest = {
  url: string;
  headers: Record<string, string>;
  data: { message_id: number };
};

export function buildContactReadRequest(params: {
  baseUrl: string;
  accountId: number | string;
  conversationId: number;
  messageId: number;
  token: string;
}): ContactReadRequest {
  const baseUrl = params.baseUrl.replace(/\/+$/, '');
  return {
    url: `${baseUrl}/api/v1/accounts/${params.accountId}/conversations/${params.conversationId}/contact_read`,
    headers: { [CHATWOOT_READ_STATE_HEADER]: params.token },
    data: { message_id: params.messageId },
  };
}

export type ContactReadTarget = { conversationId: number; messageId: number };

/** The Chatwoot message a receipt points at, or null while the binding is missing. */
export function contactReadTarget(
  message: { chatwootMessageId?: number | null; chatwootConversationId?: number | null } | null | undefined,
): ContactReadTarget | null {
  const messageId = message?.chatwootMessageId;
  const conversationId = message?.chatwootConversationId;
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return null;
  return { conversationId, messageId };
}

/** Chatwoot may not have the message or conversation yet, or is restarting. */
export function isRetryableContactReadStatus(status: unknown): boolean {
  const code = Number(status);
  if (!Number.isFinite(code) || code <= 0) return true; // network error, timeout
  return [404, 408, 409, 425, 429].includes(code) || code >= 500;
}

export function nextContactReadDelay(attempt: number): number | null {
  return CONTACT_READ_RETRY_DELAYS_MS[attempt] ?? null;
}
