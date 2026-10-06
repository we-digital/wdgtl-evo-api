# Native provider edit-target indexes

Retained provider edits are matched by their original protocol target keys. An
instance-only scan still computes nested JSON fields for every message in that
instance, which can exceed a bounded recovery reader's deadline. Three nonunique
partial B-tree indexes store the exact target expressions together with the
instance ID. They preserve every duplicate-key version and change no message,
provider identity, outbound state, payload or receiver policy.

The adjacent SQL is a separately operated schema change. Do not run it through
application startup, Prisma migration retries, a transaction block, or a single
multi-statement client query. Publish the exact SQL and runbook through a separate
PR, synthetic PostgreSQL lab and main; retain the artifact SHA. A documentation
release does not require an application image recreation.

## Inspect before building

Use the authenticated native database connection without logging its URI or
credentials. Capture the real server version and select its matching official
documentation. The proposal covers PostgreSQL 16, 17 and 18; real synthetic checks passed on
PostgreSQL 16.15 and 17.11. An
unreviewed major stops. Confirm the configured namespace is `public` and uniquely
owns the regular, nonpartitioned `Message` table. Confirm `instanceId` is text and
`message` is JSONB, database/table ownership, and the existing index definitions.
Retain database, heap and total table sizes, the actual database/tablespace/WAL
filesystem free bytes or managed-database storage metrics, replication lag if configured, long-running transactions,
table locks and `pg_stat_progress_create_index` state. These are facts to review,
not a claim that the proposed indexes are small. Database free space must come
from the actual database host or managed database service; application-host free
space is not a substitute. A proxy or loopback database address does not prove
that the database files are on the application host.

Approve a conservative disk/WAL allowance for three serial builds and an
operational free-space reserve using those actual values. Concurrent builds make
two scans, wait for transactions and add write work; they do not provide an
instant zero-impact migration. Keep application health and immutable runtime
bookends, memory, disk and replica continuity under observation. Run one build
at a time; do not overlap another index build on the same table or another heavy
recovery helper.

Every proposed name must be absent, or independently verified as the exact
valid/ready/live, nonunique B-tree definition with its exact `IS NOT NULL`
predicate. A same-name wrong or invalid index stops. Do not use `IF NOT EXISTS`,
automatically drop an invalid index, or retry an uncertain previous invocation.

## One-shot concurrent build

Use a single owned session in autocommit with a fixed advisory lock for this
index set. Set `lock_timeout = '2s'`, `statement_timeout = '20min'` for this build
operation only, `maintenance_work_mem = '64MB'`, and
`max_parallel_maintenance_workers = 0`. These build limits do not change the
recovery reader's five-second SQL deadline.

Execute each adjacent `CREATE INDEX CONCURRENTLY` statement separately and
serially. After each returned success inspect its own index definition, predicate,
`indisvalid`, `indisready`, `indislive`, nonunique status, bytes and progress. Stop
before the next build on any mismatch or continuity/resource issue. On timeout,
cancellation, connection loss or uncertain response, inspect the exact own index
and active backend/progress first. A concurrent failure can leave an invalid
index. Keep that evidence; a drop or replacement needs a separate reviewed action.
Release the owned advisory lock on known completion and close the session.

## Reader acceptance

Push each original target equality/`ANY` predicate into its indexed branch,
before materialization. Envelope discovery is the union of protocol and nested
edited-protocol branches. Encrypted competitor discovery is the union of secret,
protocol and edited-protocol branches, each retaining the original instance,
excluded envelope ID and timestamp boundary. Deduplicate only identical native
IDs across branches; do not deduplicate provider keys or omit source versions.

The partial predicates exclude SQL NULL target expressions. Such rows cannot
match the original nonnull target equality/`ANY` predicates. The indexes have no
unique constraint, message-type filter, content-length filter, payload conversion
or timestamp filter. Rows with absent, null or unusual JSON values remain in the
table and are matched exactly as PostgreSQL's original `->`/`->>` expressions
match them.

After building, require fresh `EXPLAIN (FORMAT JSON)` without `ANALYZE` showing
each actual expression index with both instance and target-key index conditions.
An instance-only extraction scan, sequential scan or unconditioned global primary
key scan is not sufficient. Fetch complete opaque rows by the bounded selected
native IDs, retain all duplicate-key/edit competitors and repeat the original
source/CW/version/media bookends and namespace/receiver guards. Validate the
additive index catalogue separately; an index does not establish source identity,
processing authority, a provider send, a processed marker or job resume.

Synthetic PostgreSQL checks must compare the full original and indexed envelope
and competitor results, including duplicate-key versions, rows matching multiple
branches, foreign instances, absent/null/scalar keys, envelope exclusions and
timestamp boundaries. Verify real concurrent/autocommit creation, index validity,
unchanged full rows and actual conditioned index plans. Production performance
and successful recovery are established only by the later genuine read.

## PostgreSQL documentation

- [PostgreSQL 16 CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html)
- [Indexes on expressions (16)](https://www.postgresql.org/docs/16/indexes-expressional.html)
- [CREATE INDEX progress (16)](https://www.postgresql.org/docs/16/progress-reporting.html#CREATE-INDEX-PROGRESS-REPORTING)

- [PostgreSQL 17 CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html)
- [PostgreSQL 18 CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html)
- [Indexes on expressions (17)](https://www.postgresql.org/docs/17/indexes-expressional.html)
- [Indexes on expressions (18)](https://www.postgresql.org/docs/18/indexes-expressional.html)
- [CREATE INDEX progress (17)](https://www.postgresql.org/docs/17/progress-reporting.html#CREATE-INDEX-PROGRESS-REPORTING)
- [CREATE INDEX progress (18)](https://www.postgresql.org/docs/18/progress-reporting.html#CREATE-INDEX-PROGRESS-REPORTING)
