-- PostgreSQL 16. One operator run in autocommit; never inside BEGIN, Prisma
-- startup or an automatic retry. See incoming-unread-index.md.
CREATE INDEX CONCURRENTLY "Msg_instance_remotejid_incoming_idx"
ON "public"."Message" USING btree ("instanceId", ("key"->>'remoteJid'), "status", "messageTimestamp")
WHERE (("key"->>'fromMe')::boolean = false);
