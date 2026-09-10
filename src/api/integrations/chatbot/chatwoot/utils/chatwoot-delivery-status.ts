export const buildChatwootDeliveryFailureUpdate = (accountId: number, conversationId: number, messageId: number) => ({
  accountId,
  conversationId,
  messageId,
  data: {
    status: 'failed',
    external_error: 'EVO WhatsApp delivery failed',
  },
});

export const buildChatwootDeliverySuccessUpdate = (
  accountId: number,
  conversationId: number,
  messageId: number,
  whatsappMessageId: string,
) => ({
  accountId,
  conversationId,
  messageId,
  data: {
    status: 'sent',
    source_id: whatsappMessageId,
    external_error: null,
  },
});

export const isChatwootDeliverySuccessAcknowledged = (
  response: unknown,
  messageId: number,
  whatsappMessageId: string,
): boolean => {
  const acknowledgement = response as { id?: unknown; source_id?: unknown; status?: unknown } | null;
  return (
    Number(acknowledgement?.id) === messageId &&
    acknowledgement?.source_id === whatsappMessageId &&
    ['sent', 'delivered', 'read'].includes(String(acknowledgement?.status))
  );
};

export const isChatwootDeliveryFailureAcknowledged = (response: unknown, messageId: number): boolean => {
  const acknowledgement = response as { id?: unknown; status?: unknown } | null;
  return Number(acknowledgement?.id) === messageId && acknowledgement?.status === 'failed';
};

export const isChatwootMessageDeletion = (body: any): boolean =>
  body?.event === 'message_updated' && body?.content_attributes?.deleted === true;

export const isDeliverableChatwootOutgoing = (body: any, chatId: string): boolean =>
  body?.event === 'message_created' &&
  body?.message_type === 'outgoing' &&
  Number.isSafeInteger(Number(body?.id)) &&
  Number(body.id) > 0 &&
  chatId !== '123456' &&
  !(typeof body?.source_id === 'string' && body.source_id.startsWith('WAID:'));
