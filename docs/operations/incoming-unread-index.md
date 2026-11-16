# Incoming unread-status index

Two read-receipt paths in `whatsapp.baileys.service.ts` run on every chat read
and every inbound read receipt:

- `updateChatUnreadMessages`: `SELECT COUNT(*) … WHERE "instanceId"=$1 AND
  "key"->>'remoteJid'=$2 AND ("key"->>'fromMe')::boolean = false AND "status"=$3`;
- `updateMessagesReadedByTimestamp`: `UPDATE "Message" SET "status"=… WHERE` the
  same chat, `fromMe = false`, `"messageTimestamp" <= $` and
  `("status" IS NULL OR "status"=$)`.

The only index for that chat filter is `Msg_instance_remotejid_id_idx`
(`"instanceId", key->>'remoteJid', id`). It returns every row of the chat, and
the status/direction filter runs on the heap. On 2026-11-16 the busiest chat
(24,395 rows) needed about 11k buffers and 94 ms for a 16-row result. Large
group chats make it worse. This is the main evolution_db read load behind the
cluster's cache hit drop (load review 2026-11-16).

`key->>'id'` lookups are not the problem: `Msg_instance_source_key_idx` already
covers `("instanceId", (key->>'id'))`.

## The index

`incoming-unread-index.sql`: a partial B-tree on
`("instanceId", key->>'remoteJid', status, "messageTimestamp")` for incoming rows
only. Both statements write `fromMe` as the literal `= false` cast, so the
planner proves the predicate even for generic prepared plans. The COUNT becomes
a range scan on the exact status. The UPDATE becomes two ranges (`status IS
NULL`, `status = DELIVERY_ACK`) with the timestamp bound checked in the index.

Preflight on 2026-11-16: 1.92M rows, every `key->'fromMe'` is a JSON boolean
(1.32M false), so the cast cannot fail during the build. The longest key tuple is
77 bytes. The expected size is about 100–130 MB. PostgreSQL 16.15, no idle-in-transaction
sessions.

## Run

One owned session from the EVO host (`docker exec -i -w /evolution evo-api node -`
with `pg` and `DATABASE_CONNECTION_URI`), in a quiet hour, agreed with the
deploy coordinator:

1. Check the name is absent from `pg_indexes`. If it exists, stop and inspect it;
   do not drop or retry automatically.
2. `SET lock_timeout = '2s'; SET statement_timeout = '30min';
   SET maintenance_work_mem = '256MB';` then the statement from the SQL file in
   autocommit. CONCURRENTLY takes only a SHARE UPDATE EXCLUSIVE lock: inserts and
   updates keep running.
3. Record the elapsed time, `pg_relation_size`, `indisvalid`, `indisready`.
   An interrupted build leaves an INVALID index: report it and drop it
   (`DROP INDEX CONCURRENTLY`) only in a separate reviewed step.
4. After it is valid, `EXPLAIN` both statements for a busy chat and confirm
   `Msg_instance_remotejid_incoming_idx` is used.

Cost: `status` becomes an indexed column, so a status change on an incoming
row is no longer a HOT update and writes entries into every `Message` index.
These updates run about 14 times a minute on a few rows each, so the cost is
small next to the reads saved. Checked on a synthetic PostgreSQL 16.15 table
with `plan_cache_mode = force_generic_plan`: both statements use the index.

No application change or image recreation is needed. The index is not in
`schema.prisma`, like the other operator indexes in this folder.
