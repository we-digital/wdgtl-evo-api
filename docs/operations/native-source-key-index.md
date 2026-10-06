# Native provider source-key index

The source message lookup must match every native row with the selected instance
and provider key, including duplicate-key versions and rows whose Chatwoot
pointers are NULL. Materializing all keys for an instance before filtering can
exceed the recovery reader's five-second deadline. The separate nonunique partial
B-tree index in the adjacent SQL supports the original `key->>'id'` predicate.
The three edit-target indexes remain unchanged; they index different expressions
and cannot accelerate this lookup.

Publish this exact SQL and runbook through a separate PR, synthetic PostgreSQL
16.15 lab and main. This operator artifact changes no application source, sender,
startup migration, message data or recovery eligibility. It does not require an
application image recreation. Do not execute this file as a transaction batch.

## One-shot operator contract

Retain the authenticated configured namespace, regular nonpartitioned table,
owner, real PostgreSQL version, UTF8 encoding, 8192-byte block size and existing
index catalogue. Verify `instanceId` is text and `key` is JSONB. Inspect actual
managed-database disk/WAL capacity, table and database sizes, progress, table
locks, long transactions and replica lag. Application-host disk is not database
capacity. Approve capacity and continuity separately; this index covers every
nonnull source key and is not assumed to be as small as the sparse edit indexes.
Run serially after any other build on the same table and any heavy helper ends.

Use one owned autocommit session with application name
`bbc-native-source-key-index260` and a separately scoped advisory lock:
`pg_try_advisory_lock(hashtextextended('bbc-native-source-key-index260',0))`.
Set `lock_timeout='2s'`, `maintenance_work_mem='64MB'`,
`max_parallel_maintenance_workers=0` and `max_parallel_workers_per_gather=0`.
Use `statement_timeout='20min'` only for the full key-size preflight and the one
concurrent build, under the existing bounded continuity watch. Ordinary metadata
and all recovery reads keep their five-second timeout.

Before DDL, capture this whole-table key-size scalar in the owned session:

```sql
SELECT count(*)::text AS message_rows,
       count("key"->>'id')::text AS source_nonnull_rows,
       max(COALESCE(octet_length("instanceId"),0)
           + octet_length("key"->>'id')) AS source_max_UTF8_bytes
FROM "public"."Message";
```

The maximum must be NULL or at most 2000 UTF8 bytes. This conservative bound
includes nonnull source keys when `instanceId` is NULL. Stop before DDL for any
larger value, unknown block size/encoding or timeout. Do not filter long keys or
rewrite data to make a build pass.

The proposed index name must be absent, or independently verified as the exact
valid/ready/live, nonunique, nonprimary B-tree index with the adjacent columns,
expression and `IS NOT NULL` predicate. A wrong or invalid same-name object stops.
Do not use `IF NOT EXISTS`, automatically drop an invalid index, or retry an
uncertain build. Run the one adjacent statement in autocommit. Then capture
`pg_get_indexdef`, `pg_get_expr(indpred,indrelid)`, `indisvalid`, `indisready`,
`indislive`, uniqueness, index bytes and progress. Release the owned advisory
lock and close the session on known completion. A timeout or uncertain response
requires own-index/backend/progress inspection before a separately reviewed next
operation; concurrent failure can leave an invalid index.

## Reader contract

Push both original predicates into their branches before deduplicating IDs:

```sql
WITH instance_keys AS MATERIALIZED (
  SELECT id FROM "public"."Message"
  WHERE "instanceId"=$1 AND id=ANY($2::text[])
  UNION
  SELECT id FROM "public"."Message"
  WHERE "instanceId"=$1 AND "key"->>'id'=ANY($3::text[])
    AND ("key"->>'id') IS NOT NULL
)
SELECT id FROM instance_keys ORDER BY id LIMIT 1001;
```

The only deduplication is identical native IDs across branches. Never deduplicate
provider keys or select only the cached native ID. Preserve all same-key versions,
full opaque rows and NULL pointers; retain the 1001 sentinel, original row/byte
bounds, five-second deadline, instance/receiver authentication and source/CW
bookends. Fetch full rows by selected native primary IDs and retain their instance
predicate. Fresh `EXPLAIN (FORMAT JSON)` without `ANALYZE` must show the source-key
index with both instance and key conditions; an active ID branch must use the
primary index. An instance-only extraction or unconditioned global primary scan
is insufficient. An empty ID branch can be optimized away. The index supplies no
provider identity, callback acknowledgement, send, processing marker or resume
authority.

The predicate excludes only SQL NULL extracted keys, which cannot match the
original nonnull equality/ANY keys. It imposes no uniqueness, direction, content,
message type, timestamp, or nonnull-instance filter. Absent/null/scalar/other JSON
shapes and duplicate versions stay in the table. A focused real PostgreSQL 16.15
fixture must prove original OR and indexed UNION equivalence, both conditioned
index branches, exact valid/ready/live nonunique definition, unchanged full rows,
and duplicate-key insert retention. Production performance is a later read fact.

See the version-matched references already used by the edit-index runbook:
[CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html),
[expression indexes](https://www.postgresql.org/docs/16/indexes-expressional.html),
[concurrent-build progress](https://www.postgresql.org/docs/16/progress-reporting.html#CREATE-INDEX-PROGRESS-REPORTING).
