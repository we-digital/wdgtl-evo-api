import {
  acknowledgedMultipartPartsMatch,
  ChatwootProviderDeliveryPart,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';
import type { Pool } from 'pg';

type Binding = { conversationId: number; inboxId: number; contactInboxSourceId: string };

// The CW peer lock covers the local mapping write as well as the CW lookup.
// Online native-map reconciliation must acquire this same lock before its
// Evolution UPDATE; a delayed caller cannot overwrite that update with old IDs.
export async function withCanonicalChatwootMessageBinding<T>(
  pool: Pool,
  scope: {
    accountId: number;
    inboxId: number;
    messageId: number;
    whatsappMessageId: string;
    claimedConversationId?: number;
    acknowledgedParts?: ChatwootProviderDeliveryPart[];
    history?: { peers: string[]; direction: 'incoming' | 'outgoing' };
  },
  write: (binding: Binding) => Promise<T>,
): Promise<T> {
  if (
    ![scope.accountId, scope.inboxId, scope.messageId].every((id) => Number.isSafeInteger(id) && id > 0) ||
    !scope.whatsappMessageId
  )
    throw new Error('Invalid canonical mapping scope');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query(
      "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s'",
    );
    const original = await client.query(
      'SELECT conversation_id,source_id,message_type,private,additional_attributes FROM messages WHERE id=$1 AND account_id=$2 AND inbox_id=$3' +
        (scope.acknowledgedParts || scope.history ? ' FOR SHARE' : ''),
      [scope.messageId, scope.accountId, scope.inboxId],
    );
    // An outgoing operator message gets its WA source ID only after this
    // existing binding call. Do not disable that established null-source path.
    const message = original.rows[0];
    const acknowledgedPart =
      message?.message_type === 1 &&
      scope.acknowledgedParts?.some((part) => part.sourceId === scope.whatsappMessageId) &&
      acknowledgedMultipartPartsMatch(message.additional_attributes, message.source_id, scope.acknowledgedParts);
    if (
      original.rows.length !== 1 ||
      (scope.acknowledgedParts && message.message_type !== 1) ||
      (original.rows[0].source_id &&
        ![scope.whatsappMessageId, `WAID:${scope.whatsappMessageId}`].includes(original.rows[0].source_id) &&
        !acknowledgedPart)
    )
      throw new Error('Canonical mapping message identity mismatch');
    const routed = await client.query('SELECT public.provider_message_conversation_route($1,$2,$3) AS id', [
      scope.accountId,
      scope.inboxId,
      Number(original.rows[0].conversation_id),
    ]);
    const canonicalId = Number(routed.rows[0]?.id);
    if (!Number.isSafeInteger(canonicalId) || canonicalId <= 0) throw new Error('Canonical mapping route missing');
    if (scope.history) {
      const aliases = await client.query(
        'SELECT id FROM messages WHERE account_id=$1 AND inbox_id=$2 AND source_id=ANY($3::text[])',
        [scope.accountId, scope.inboxId, [scope.whatsappMessageId, `WAID:${scope.whatsappMessageId}`]],
      );
      if (
        aliases.rows.length !== 1 ||
        Number(aliases.rows[0].id) !== scope.messageId ||
        message.private !== false ||
        message.message_type !== (scope.history.direction === 'outgoing' ? 1 : 0) ||
        ![scope.whatsappMessageId, `WAID:${scope.whatsappMessageId}`].includes(message.source_id)
      )
        throw new Error('History mapping requires one public scoped source and direction');
    }
    const actual = await client.query(
      `SELECT c.id,c.display_id,c.inbox_id,ci.source_id FROM messages m
       JOIN conversations c ON c.id=$4 AND c.account_id=m.account_id AND c.inbox_id=m.inbox_id
       JOIN contact_inboxes ci ON ci.id=c.contact_inbox_id AND ci.inbox_id=c.inbox_id AND ci.contact_id=c.contact_id
       WHERE m.id=$1 AND m.account_id=$2 AND m.inbox_id=$3
         AND public.provider_message_conversation_route(m.account_id,m.inbox_id,m.conversation_id)=c.id` +
        (scope.history ? ' FOR SHARE OF c, ci' : ''),
      [scope.messageId, scope.accountId, scope.inboxId, canonicalId],
    );
    if (actual.rows.length !== 1) throw new Error('Canonical mapping current scope mismatch');
    const row = actual.rows[0];
    if (scope.history) {
      const binding = await client.query(
        `SELECT b.peer FROM provider_conversation_bindings b
         WHERE b.account_id=$1 AND b.inbox_id=$2 AND b.conversation_id=$3 AND b.provider='whatsapp' FOR SHARE`,
        [scope.accountId, scope.inboxId, canonicalId],
      );
      if (
        binding.rows.length !== 1 ||
        !scope.history.peers.includes(binding.rows[0].peer) ||
        typeof row.source_id !== 'string' ||
        !row.source_id.length
      )
        throw new Error('History mapping canonical peer or contact inbox mismatch');
    }

    if (scope.claimedConversationId !== undefined && scope.claimedConversationId !== Number(row.display_id)) {
      const old = await client.query(
        `SELECT canonical_conversation_id FROM provider_conversation_routes
         WHERE account_id=$1 AND inbox_id=$2 AND source_display_id=$3`,
        [scope.accountId, scope.inboxId, scope.claimedConversationId],
      );
      if (old.rows.length !== 1 || Number(old.rows[0].canonical_conversation_id) !== canonicalId)
        throw new Error('Canonical mapping claimed conversation is foreign');
    }
    const result = await write({
      conversationId: Number(row.display_id),
      inboxId: Number(row.inbox_id),
      contactInboxSourceId: row.source_id,
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
