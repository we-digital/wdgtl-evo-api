-- Prisma JSON path equality is JSONB #>, unlike the retained text ->> index.
-- Keep live inserts/updates running; do not wrap this migration in a transaction.
CREATE INDEX CONCURRENTLY "Msg_instance_json_key_timestamp_idx"
ON "Message" ("instanceId", (key #> '{id}'::text[]), "messageTimestamp" DESC);
