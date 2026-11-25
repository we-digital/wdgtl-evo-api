# Owner-read cursor index

`forwardChatwootOwnerRead` in `whatsapp.baileys.service.ts` runs on every chat
the phone owner reads (each inbound read of our side). It asks for the newest
incoming message of that chat that already has a Chatwoot id:

```sql
SELECT "chatwootMessageId", "chatwootConversationId" FROM "Message"
WHERE "instanceId" = $1 AND "key"->>'remoteJid' = $2
  AND ("key"->>'fromMe')::boolean = false AND "messageTimestamp" <= $3
  AND "chatwootMessageId" IS NOT NULL AND "chatwootConversationId" IS NOT NULL
ORDER BY "messageTimestamp" DESC, "chatwootMessageId" DESC LIMIT 1
```

On prod, pg_stat_statements from 11-17 to 11-25 shows 34,341 calls with a mean of
84 ms, a max of 10 s and 2,877 s in total. It is the second-largest EVO statement.
`Msg_instance_remotejid_incoming_idx` has `status` before `messageTimestamp`, so
it returns every incoming row of the chat. The Chatwoot-id filter runs on the
heap, and then the rows are sorted. On the busiest chat (12k rows, 11-25), a
lookup reads 9,797 rows and 5.8k buffers to return 1 row.

## The index

`owner-read-cursor-index.sql` creates a partial B-tree on
`("instanceId", key->>'remoteJid', "messageTimestamp" DESC, "chatwootMessageId" DESC)`.
It covers only incoming rows that carry both Chatwoot ids: 492k of the 2.04M
rows on 11-25. Its order equals the query's ORDER BY, so the lookup becomes a
one-row index descent. The predicate repeats the statement's literals
(`= false` cast, both `IS NOT NULL`), so the planner proves it for generic plans
too.

Cost: `chatwootMessageId` is already indexed (`Msg_instance_chatwoot_message_idx`),
so the update that binds a Chatwoot id was already a non-HOT update. The new
index adds one entry per bound incoming row. Expected size is about 40–50 MB.

## Run

Follow the run steps in `incoming-unread-index.md`: one owned session from the
EVO host, at a quiet hour, agreed with the deploy coordinator. Use
`lock_timeout 2s`, `statement_timeout 30min` and `maintenance_work_mem 256MB`,
and run in autocommit. Check the name is absent first. Never use
`IF NOT EXISTS` and never retry automatically. Afterwards, record the elapsed
time, size, `indisvalid` and `indisready`, then EXPLAIN the statement for a busy
chat.

No application change is needed; the index is not in `schema.prisma`, like the
other operator indexes in this folder.
