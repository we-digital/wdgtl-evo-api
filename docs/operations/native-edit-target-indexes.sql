-- PostgreSQL only. One independently reviewed, serial, autocommit operation per index.
-- Do not add this file to startup Prisma migrations or automatic retry wrappers.
-- Inspect namespace, version, ownership, disk, snapshots and index status first.
-- No IF NOT EXISTS: same-name invalid/wrong indexes must stop for inspection.
-- One reviewed operation, autocommit. Never inside BEGIN or automatic migration retry.
CREATE INDEX CONCURRENTLY "Msg_instance_protocol_target_idx"
ON "public"."Message" USING btree ("instanceId", (message->'protocolMessage'->'key'->>'id'))
WHERE (message->'protocolMessage'->'key'->>'id') IS NOT NULL;

-- One reviewed operation, autocommit. Never inside BEGIN or automatic migration retry.
CREATE INDEX CONCURRENTLY "Msg_instance_edited_protocol_target_idx"
ON "public"."Message" USING btree ("instanceId", (message->'editedMessage'->'message'->'protocolMessage'->'key'->>'id'))
WHERE (message->'editedMessage'->'message'->'protocolMessage'->'key'->>'id') IS NOT NULL;

-- One reviewed operation, autocommit. Never inside BEGIN or automatic migration retry.
CREATE INDEX CONCURRENTLY "Msg_instance_secret_target_idx"
ON "public"."Message" USING btree ("instanceId", (message->'secretEncryptedMessage'->'targetMessageKey'->>'id'))
WHERE (message->'secretEncryptedMessage'->'targetMessageKey'->>'id') IS NOT NULL;

