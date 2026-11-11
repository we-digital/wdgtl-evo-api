-- Chatwoot replies, edits, reactions, deletions and forwards look up the native
-- row by Chatwoot message id. Without this index Postgres walks every message of
-- the instance (2.6 s on a 280k-message number). Partial: most rows have no id.
-- Keep live inserts/updates running; do not wrap this migration in a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Msg_instance_chatwoot_message_idx"
ON "Message" ("instanceId", "chatwootMessageId")
WHERE "chatwootMessageId" IS NOT NULL;
