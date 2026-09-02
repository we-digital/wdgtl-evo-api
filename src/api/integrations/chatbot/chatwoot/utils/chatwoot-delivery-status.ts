export const buildChatwootDeliveryFailureUpdate = (accountId: number, conversationId: number, messageId: number) => ({
  accountId,
  conversationId,
  messageId,
  data: {
    status: 'failed',
    external_error: 'EVO WhatsApp delivery failed',
  },
});
