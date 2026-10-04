import { Pool } from 'pg';

export type ProviderHistoryIdentity = {
  identityKey: string;
  identifier: string;
  phoneNumber: string | null;
  name: string;
  first: number;
  last: number;
  aliases?: string[];
};

type ProviderFks = { identity_key: string; contact_id: string; conversation_id: string };

export const providerConversationLockKey = (accountId: number, inboxId: number, peer: string): string =>
  `provider-conversation:${accountId}:${inboxId}:whatsapp:${peer}`;

// Shares Chatwoot's binding, ownership constraints and transaction lock. History
// inserts keep their native timestamps and do not run live ingress callbacks.
export async function resolveProviderHistoryConversations(
  pool: Pool,
  accountId: number,
  inboxId: number,
  identities: ProviderHistoryIdentity[],
): Promise<Map<string, ProviderFks> | null> {
  const registration = await pool.query(
    `SELECT a.custom_attributes #> '{we_digital,provider_peer_conversations}' = 'true'::jsonb AS enabled,
       ch.additional_attributes->>'we_digital_provider' AS provider
     FROM accounts a JOIN inboxes i ON i.account_id = a.id
     JOIN channel_api ch ON ch.id = i.channel_id AND ch.account_id = a.id
     WHERE a.id = $1 AND i.id = $2 AND i.channel_type = 'Channel::Api'`,
    [accountId, inboxId],
  );
  if (registration.rows[0]?.enabled !== true || registration.rows[0]?.provider !== 'evo_whatsapp') return null;
  for (const identity of identities) {
    const aliases = identity.aliases || [];
    if (
      aliases.length &&
      (!identity.identityKey.endsWith('@s.whatsapp.net') ||
        aliases.length > 4 ||
        aliases.some((alias) => !/^[1-9]\d{4,19}@lid$/.test(alias)))
    ) {
      throw new Error('History provider alias identity is unavailable');
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = new Map<string, ProviderFks>();
    const lockPeers = [
      ...new Set(identities.flatMap((identity) => [identity.identityKey, ...(identity.aliases || [])])),
    ].sort();
    for (const peer of lockPeers) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        providerConversationLockKey(accountId, inboxId, peer),
      ]);
    }
    // Consistent ordering prevents deadlocks when overlapping batches share peers.
    for (const identity of [...identities].sort((a, b) => a.identityKey.localeCompare(b.identityKey))) {
      const peer = identity.identityKey;
      if (
        identity.identifier !== peer ||
        !/^(?:[1-9]\d{4,19}@(s\.whatsapp\.net|lid)|[1-9]\d{4,19}(?:-\d{1,20})?@g\.us)$/.test(peer)
      ) {
        throw new Error('History provider peer identity is unavailable');
      }
      if (identity.aliases?.length) {
        const aliasConversations = await client.query(
          `SELECT c.id FROM contacts contact JOIN conversations c ON c.contact_id = contact.id
           WHERE contact.account_id = $1 AND c.account_id = $1 AND c.inbox_id = $2 AND contact.identifier = ANY($3::text[]) LIMIT 1`,
          [accountId, inboxId, identity.aliases],
        );
        if (aliasConversations.rows.length)
          throw new Error('History LID alias needs verified conversation reconciliation');
      }
      // Match live provider ingress: exact provider identifier wins over phone aliases.
      // Retain the other contact, documents and message authors without merging them.
      let contacts = await client.query(
        `SELECT id, identifier FROM contacts WHERE account_id = $1
         AND identifier = $2 ORDER BY id FOR UPDATE`,
        [accountId, peer],
      );
      if (!contacts.rows.length && identity.phoneNumber !== null) {
        if (!/^[1-9]\d{4,19}@s\.whatsapp\.net$/.test(peer) || identity.phoneNumber !== `+${peer.split('@')[0]}`) {
          throw new Error('History provider phone identity is unavailable');
        }
        contacts = await client.query(
          `SELECT id, identifier FROM contacts WHERE account_id = $1
           AND phone_number = $2 ORDER BY id FOR UPDATE`,
          [accountId, identity.phoneNumber],
        );
      }
      if (!contacts.rows.length) {
        contacts = await client.query(
          `INSERT INTO contacts (account_id,identifier,phone_number,name,created_at,updated_at)
           VALUES ($1,$2,$3,$4,to_timestamp($5),to_timestamp($6))
           ON CONFLICT (identifier,account_id) DO UPDATE SET identifier = EXCLUDED.identifier
           RETURNING id,identifier`,
          [accountId, peer, identity.phoneNumber, identity.name, identity.first, identity.last],
        );
      }
      if (
        contacts.rows.length !== 1 ||
        (contacts.rows[0].identifier?.match(/@(s\.whatsapp\.net|lid|g\.us)$/) && contacts.rows[0].identifier !== peer)
      ) {
        throw new Error('History contact provider identity is ambiguous');
      }
      const contactId = contacts.rows[0].id;
      const binding = await client.query(
        `SELECT c.id,c.contact_id FROM provider_conversation_bindings b
         JOIN conversations c ON c.id = b.conversation_id AND c.account_id = b.account_id AND c.inbox_id = b.inbox_id
         WHERE b.account_id = $1 AND b.inbox_id = $2 AND b.provider = 'whatsapp' AND b.peer = $3`,
        [accountId, inboxId, peer],
      );
      const candidates = await client.query(
        `SELECT c.id,c.additional_attributes,ci.source_id,ci.inbox_id AS contact_inbox_inbox_id,ci.contact_id AS contact_inbox_contact_id
         FROM conversations c LEFT JOIN contact_inboxes ci ON ci.id = c.contact_inbox_id
         WHERE c.account_id = $1 AND c.inbox_id = $2 AND c.contact_id = $3 ORDER BY c.created_at,c.id`,
        [accountId, inboxId, contactId],
      );
      if (
        candidates.rows.some((row) => {
          const sourcePeer = /^[1-9]\d{4,19}$/.test(row.source_id) ? `${row.source_id}@s.whatsapp.net` : row.source_id;
          return (
            Number(row.contact_inbox_inbox_id) !== inboxId ||
            Number(row.contact_inbox_contact_id) !== Number(contactId) ||
            (/@(s\.whatsapp\.net|lid|g\.us)$/.test(sourcePeer) && sourcePeer !== peer) ||
            (row.additional_attributes?.provider_peer && row.additional_attributes.provider_peer !== peer)
          );
        }) ||
        (binding.rows.length && Number(binding.rows[0].contact_id) !== Number(contactId))
      ) {
        throw new Error('History conversation provider identity conflicts with its binding');
      }
      let conversationId = binding.rows[0]?.id || candidates.rows[0]?.id;
      if (!conversationId) {
        let contactInbox = await client.query(
          'SELECT id,source_id FROM contact_inboxes WHERE inbox_id = $1 AND contact_id = $2 ORDER BY created_at,id LIMIT 1',
          [inboxId, contactId],
        );
        if (!contactInbox.rows.length) {
          contactInbox = await client.query(
            `INSERT INTO contact_inboxes (contact_id,inbox_id,source_id,created_at,updated_at)
             VALUES ($1,$2,$3,to_timestamp($4),to_timestamp($5)) RETURNING id`,
            [contactId, inboxId, peer, identity.first, identity.last],
          );
        } else {
          const source = contactInbox.rows[0].source_id;
          const sourcePeer = /^[1-9]\d{4,19}$/.test(source) ? `${source}@s.whatsapp.net` : source;
          if (/@(s\.whatsapp\.net|lid|g\.us)$/.test(sourcePeer) && sourcePeer !== peer) {
            throw new Error('History contact inbox provider identity conflicts');
          }
        }
        const created = await client.query(
          `INSERT INTO conversations (account_id,inbox_id,contact_id,contact_inbox_id,status,uuid,
             last_activity_at,created_at,updated_at,additional_attributes)
           VALUES ($1,$2,$3,$4,0,gen_random_uuid(),to_timestamp($5),to_timestamp($6),to_timestamp($5),$7::jsonb) RETURNING id`,
          [
            accountId,
            inboxId,
            contactId,
            contactInbox.rows[0].id,
            identity.last,
            identity.first,
            JSON.stringify({ provider_peer: peer }),
          ],
        );
        conversationId = created.rows[0].id;
      }
      if (!binding.rows.length) {
        await client.query(
          `INSERT INTO provider_conversation_bindings (account_id,inbox_id,provider,peer,conversation_id,created_at,updated_at)
           VALUES ($1,$2,'whatsapp',$3,$4,NOW(),NOW())`,
          [accountId, inboxId, peer, conversationId],
        );
      }
      result.set(peer, { identity_key: peer, contact_id: String(contactId), conversation_id: String(conversationId) });
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
