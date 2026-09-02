export const buildChatwootDeliveryFailureUpdate = (accountId: number, conversationId: number, messageId: number) => ({
  accountId,
  conversationId,
  messageId,
  data: {
    status: 'failed',
    external_error: 'EVO WhatsApp delivery failed',
  },
});

export const isDeliverableChatwootOutgoing = (body: any, chatId: string): boolean =>
  body?.message_type === 'outgoing' &&
  Boolean(body?.conversation?.messages?.length) &&
  chatId !== '123456' &&
  !body.conversation.messages[0]?.source_id?.startsWith('WAID:');
