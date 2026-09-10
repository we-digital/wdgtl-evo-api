import { ChatwootAPIConfig } from '@figuro/chatwoot-sdk';
import { request as chatwootRequest } from '@figuro/chatwoot-sdk/dist/core/request';

export const unwrapChatwootPayload = <T = any>(response: any): T =>
  response && typeof response === 'object' && !Array.isArray(response) && 'payload' in response
    ? (response.payload as T)
    : (response as T);

export const unwrapChatwootCollection = <T = any>(response: any): T[] => {
  const payload = unwrapChatwootPayload<unknown>(response);
  return Array.isArray(payload) ? (payload as T[]) : [];
};

export const isChatwootOutgoingMessageType = (messageType: unknown): boolean =>
  messageType === 'outgoing' || messageType === 1 || messageType === '1';

export const getExactChatwootMessage = (
  config: ChatwootAPIConfig,
  accountId: number,
  inboxId: number,
  conversationId: number,
  messageId: number,
) =>
  chatwootRequest<any>(config, {
    method: 'GET',
    url: '/api/v1/accounts/{account_id}/inboxes/{inbox_id}/conversations/{conversation_id}/messages/{message_id}',
    path: {
      account_id: accountId,
      inbox_id: inboxId,
      conversation_id: conversationId,
      message_id: messageId,
    },
    errors: { 401: 'Unauthorized', 404: 'Message not found' },
  });

export const updateChatwootMessageJson = (
  config: ChatwootAPIConfig,
  accountId: number,
  conversationId: number,
  messageId: number,
  data: Record<string, unknown>,
) =>
  chatwootRequest<any>(config, {
    method: 'PATCH',
    url: '/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages/{message_id}',
    path: { account_id: accountId, conversation_id: conversationId, message_id: messageId },
    body: data,
    mediaType: 'application/json',
    errors: { 403: 'Access denied', 404: 'Message not found' },
  });
