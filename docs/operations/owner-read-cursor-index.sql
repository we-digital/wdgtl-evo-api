-- PostgreSQL 16. One operator run in autocommit; never inside BEGIN, Prisma
-- startup or an automatic retry. See owner-read-cursor-index.md.
CREATE INDEX CONCURRENTLY "Msg_instance_remotejid_cw_read_idx"
ON "public"."Message" USING btree ("instanceId", ("key"->>'remoteJid'), "messageTimestamp" DESC, "chatwootMessageId" DESC)
WHERE (("key"->>'fromMe')::boolean = false AND "chatwootMessageId" IS NOT NULL AND "chatwootConversationId" IS NOT NULL);
