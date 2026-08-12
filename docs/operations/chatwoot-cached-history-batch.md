# Chatwoot cached history batch

`POST /chatwoot/historySyncBatch/v1/:instanceName` is the bounded production writer used by the local
`we-digital/evo-history-backfill` service. It accepts at most 500 messages previously read from the same Evolution
instance through `/chat/findMessages/:instanceName`.

## Safety contract

- Authentication and instance resolution use the normal Evolution API guards.
- `contractVersion` must be `2026-08-01` and `dryRun` must be `false`.
- Every embedded Evolution database id is reloaded with an `instanceName` constraint before any Chatwoot write.
- Every supplied `sourceId` must equal the canonical `WAID:<key.id>` recomputed from both the supplied and authoritative
  stored message.
- Duplicate database ids or source ids reject the complete request.
- The writer shares the per-instance lock with the legacy stored-history sync.
- Normalization, LID resolution, group/provisional-contact behavior, original timestamps, and the guarded
  `(inbox_id, source_id)` insert are the same as the existing importer. It never invokes a WhatsApp send.
- A successful response acknowledges every terminally handled input in `processedSourceIds`. Any ambiguous or partial
  write returns an error without an acknowledgement.

The caller must stop on any non-2xx response, contract mismatch, partial acknowledgement, failed health check, or
excessive batch duration. There is intentionally no fallback to repeated full-history scans.
