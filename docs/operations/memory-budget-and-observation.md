# EVO bounded history and memory observation

## Retained behavior

No dependency/schema/provider change. Installed Baileys constants supply the
five-minute user-device and one-hour retry-counter TTLs (seconds, not milliseconds).
Bootstrap deduplication queries only incoming native IDs in instance-scoped
250-ID/250-result windows. The obsolete whole-instance ID cache is removed.
Chat/contact buffer append no longer copies all previously buffered references.
Incoming provider packets themselves remain owned by Baileys; this change does not
claim a hard cap on provider packet size or on compact identity/source evidence.

Legacy stored-history scans read at most 250 full message rows per query.
Key-only LID evidence pages retain timestamp/ID chronology, not UUID ordering;
late/out-of-order database IDs cannot override newer native mapping evidence. A
compact first-pass plan preserves global deduplication/limit, first/last identity
timestamps and first push name; a second pass reads only selected source rows.
SHA-256 binds the complete normalized source version across passes. Before each
dependent import, first/last/name donors and routing-map donors from every page
are checked under instance-scoped PostgreSQL SHARE locks held until the bounded
Chatwoot write has conclusively committed or rolled back. This is an owned native
PostgreSQL session, not an expiring Prisma interactive transaction. Its30-second
soft deadline stops new destination statements/COMMIT but never releases source
locks under a continuing writer. Dedicated destination leases retain5-second
statement deadlines, permit rollback after cancellation, restore exact prior
session settings through transaction-local settings and settle all cleanup before
source rollback/unlock. Every scoped statement has an owned transaction, including
through the production transaction pooler; no session-level SET is issued. Ancillary
group/user lookups happen before lock acquisition. No global DB setting changes.
A real31.5-second test crosses the unchanged30-second deadline and proves source
updates stay blocked until destination rollback, with zero stale metadata. A stale/deleted later-page donor cannot supply metadata
to an earlier write. Each dependency query is capped at250 rows; locks, not
payload arrays, span the mutation. Changed or
missing versions refuse, preserving already applied rows for idempotent retry.
The existing import writer guards, instance/destination isolation and SQL source
checks remain authoritative. At most two legacy scans hold global capacity.
Compact identity/source sets scale with the number of unique IDs, not body size.
Legacy buffered bootstrap (when managed reconciliation is disabled) still buffers
provider payloads; production keeps managed history reconciliation enabled.

Synthetic benchmark: `npx tsx scripts/benchmark-history-memory.ts whole 20000`
and `paged 20000`. Compare separate process RSS and identical count/checksum;
results characterize the synthetic payload reader, not a measured production
leak cure. Re-run normalization/source/direction/group/quote/media/edit tests
after upstream changes. No source content or historical IDs are rewritten.

## Metrics

`/metrics` adds main-process RSS, heap used/total/limit, external memory, ArrayBuffer
memory, CPU counters, event-loop p99/max and aggregate device/retry cache counts.
ArrayBuffers are included in external memory: do not add them together. RSS and
container cgroup usage are distinct. Histogram p99/max resets per successful
scrape; the private sampler is the intended single collector.

Production infrastructure enables the route only for TCP loopback peers
`127.0.0.1,::1`. Neither Express proxy IP nor forwarded headers grants access.
The remote sampler uses `docker exec evo-api wget` inside that namespace.
Do not expose this route publicly or add a public proxy IP to its allowlist.

## Observation and rollback

Infrastructure owns the minute sampler and bounded 14-day SQLite history;
`bbc-public-n8n/scripts/bbc_evo_instance_status_report.py` is the source actually
invoked by the existing daily report. Keep its schedule/destination unchanged.
Missing/old probes are unknown, not zero. Require at least 48 hours of the exact
new revision with ≥95% minute coverage before considering downsize. Also review
host and container p95/max, heap/native overhead, CPU, pressure, swap, restarts,
OOM, API latency and all WhatsApp connections. The summary never authorizes
resizing. Keep 4608 MiB cgroup and 2560 MiB V8 heap throughout observation.

Rollback: revert this PR and deploy a new immutable main artifact through the
normal receiver. Preserve source receipts/history and monitoring DB. Do not
restore the tight 3200 MiB cap, reset WhatsApp auth or replay customer messages.
