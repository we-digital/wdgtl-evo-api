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

## Destination-aware recovery v2

`GET /chatwoot/historySyncBatch/v2/:instanceName` resolves the current Chatwoot destination before any write and returns
`inboxId` plus a stable `destinationKey`. The orchestrator includes that destination in its processed-message namespace,
so a previous inbox cannot suppress a later import after an instance is reconnected to a different inbox.

`POST /chatwoot/historySyncBatch/v2/:instanceName` uses contract `2026-08-28` and requires `recoveryMode`:

- `standard` preserves the normal stored-history formatter;
- `maximize` additionally renders recoverable reactions and button interactions and creates explicit unavailable-content
  placeholders for user-message rows whose original body is no longer stored. Protocol, encrypted, album-wrapper, and
  other structural records remain skipped.

Every POST also repeats the capability values as `expectedDestinationKey` and `expectedInboxId`. Evolution compares them
with the current provider/inbox immediately before recovery and rejects a changed route before any write.

The response contains one outcome for every requested source ID: `existing`, `imported`, or `skipped`, with a reason.
The caller verifies destination identity, outcome membership, uniqueness, and acknowledgement before checkpointing the
batch. Existing and imported rows are always scoped to the resolved destination inbox. The recovery writer still uses the
normal Evolution identity/LID/group/timestamp logic and never invokes a WhatsApp send.
