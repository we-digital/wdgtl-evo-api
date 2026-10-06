-- PostgreSQL 16. One separately reviewed serial autocommit operation.
-- Never run through Prisma startup, an automatic migration, BEGIN, or retry.
-- Preserve invalid/wrong same-name indexes for inspection; no IF NOT EXISTS.
CREATE INDEX CONCURRENTLY "Msg_instance_source_key_idx"
ON "public"."Message" USING btree ("instanceId", ("key"->>'id'))
WHERE ("key"->>'id') IS NOT NULL;
