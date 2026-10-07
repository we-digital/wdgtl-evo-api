import { withCanonicalChatwootMessageBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-canonical-message-binding';
import {
  acknowledgedMultipartSourceIds,
  ChatwootProviderDeliveryPart,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';
import {
  historyBindingPeers,
  historyBindingSourceMatches,
  reconcileHistoryMessageBinding,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-message-binding';
import { Message, PrismaClient } from '@prisma/client';
import type { Pool } from 'pg';

// Repair only native pointers. Existing content, provider acknowledgements and
// history processing markers are never changed by this event lookup.
export async function reconcileNativeEventBinding(
  pool: Pool,
  prisma: PrismaClient,
  source: Message,
  accountId: number,
  inboxId: number,
): Promise<Message> {
  const key = source.key as { id: string; fromMe: boolean };
  const complete =
    [source.chatwootMessageId, source.chatwootInboxId, source.chatwootConversationId].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) &&
    typeof source.chatwootContactInboxSourceId === 'string' &&
    source.chatwootContactInboxSourceId.length > 0;
  let expectedMessageId: number;
  let expectedConversationId: number;
  if (complete && key.fromMe) {
    const result = await pool.query(
      'SELECT source_id,additional_attributes,private,message_type FROM messages WHERE id=$1 AND account_id=$2 AND inbox_id=$3',
      [source.chatwootMessageId, accountId, inboxId],
    );
    const message = result.rows[0];
    const exactSource = [key.id, `WAID:${key.id}`].includes(message?.source_id);
    if (result.rows.length === 1 && !exactSource) {
      const sources = acknowledgedMultipartSourceIds(message.additional_attributes, message.source_id);
      if (message.private !== false || message.message_type !== 1 || !sources?.has(`WAID:${key.id}`))
        throw new Error('Native event mapping multipart source identity mismatch');
      const attributes =
        typeof message.additional_attributes === 'string'
          ? JSON.parse(message.additional_attributes)
          : message.additional_attributes;
      const delivery = attributes.we_digital_api_inbox_status.provider_delivery;
      const parts = Object.entries(delivery.acknowledgements)
        .map(([partKey, part]: [string, any]) => ({
          partKey,
          partIndex: part.part_index,
          partCount: delivery.part_count,
          sourceId: part.source_id,
        }))
        .sort((a, b) => a.partIndex - b.partIndex) as ChatwootProviderDeliveryPart[];
      const binding = await withCanonicalChatwootMessageBinding(
        pool,
        {
          accountId,
          inboxId,
          messageId: source.chatwootMessageId,
          whatsappMessageId: parts.find((part) => part.sourceId.replace(/^WAID:/, '') === key.id).sourceId,
          acknowledgedParts: parts,
        },
        async (actual) => {
          const peers = await pool.query(
            `SELECT b.peer FROM provider_conversation_bindings b JOIN conversations c ON c.id=b.conversation_id
             AND c.account_id=b.account_id AND c.inbox_id=b.inbox_id
             WHERE b.account_id=$1 AND b.inbox_id=$2 AND c.display_id=$3 AND b.provider='whatsapp'`,
            [accountId, inboxId, actual.conversationId],
          );
          if (peers.rows.length !== 1 || !historyBindingPeers(source).includes(peers.rows[0].peer))
            throw new Error('Native event mapping multipart peer mismatch');
          if (
            source.chatwootInboxId !== actual.inboxId ||
            source.chatwootConversationId !== actual.conversationId ||
            source.chatwootContactInboxSourceId !== actual.contactInboxSourceId
          )
            throw new Error('Native event mapping refuses conflicting existing pointers');
          return actual;
        },
      );
      expectedMessageId = source.chatwootMessageId;
      expectedConversationId = binding.conversationId;
    } else {
      const binding = await reconcileHistoryMessageBinding(pool, prisma, source, accountId, inboxId, true);
      expectedMessageId = binding.messageId;
      expectedConversationId = binding.conversationId;
    }
  } else {
    const binding = await reconcileHistoryMessageBinding(pool, prisma, source, accountId, inboxId, complete);
    expectedMessageId = binding.messageId;
    expectedConversationId = binding.conversationId;
  }
  const current = await prisma.message.findFirst({ where: { id: source.id, instanceId: source.instanceId } });
  if (
    !current ||
    !historyBindingSourceMatches(current, source) ||
    current.chatwootMessageId !== expectedMessageId ||
    current.chatwootInboxId !== inboxId ||
    current.chatwootConversationId !== expectedConversationId ||
    typeof current.chatwootContactInboxSourceId !== 'string' ||
    !current.chatwootContactInboxSourceId.length
  )
    throw new Error('Native event mapping source or pointers changed after reconciliation');
  return current;
}
