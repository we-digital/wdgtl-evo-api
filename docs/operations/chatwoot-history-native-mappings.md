# History native message mappings

Successful `historySyncBatch/v2` ordinary imports and existing-message outcomes now bind the native `Message` to the independently qualified Chatwoot message. This preserves incoming edit/reaction/read/delete lookups after SQL-based history recovery. Controls and ignored/unavailable edits are not treated as destination messages.

Already processed history can use the authenticated, per-instance endpoint:

`POST /chatwoot/historyMappings/reconcile/:instanceName`

```json
{
  "contractVersion": "2026-10-08",
  "dryRun": true,
  "expectedDestinationKey": "chatwoot:1:42",
  "expectedInboxId": 42,
  "messages": [{
    "sourceId": "WAID:SYNTHETIC_SOURCE",
    "expectedDirection": "incoming",
    "message": {
      "id": "exact-native-database-id",
      "key": {"id": "SYNTHETIC_SOURCE", "remoteJid": "120363000000001@g.us", "fromMe": false},
      "messageType": "conversation",
      "messageTimestamp": 1700000000,
      "message": {"conversation": "Synthetic source"}
    }
  }]
}
```

Use the actual destination key returned by `GET /chatwoot/historySyncBatch/v2/:instanceName`; the example key is illustrative. Supply the current native key, payload, type and timestamp, not an inferred message or a cached source from another instance. The endpoint accepts 1–250 entries and requires an explicit `dryRun`. After inspecting the preview, `dryRun:false` applies the same guarded operation. It shares the per-instance history writer exclusion.

Each source must have exactly one public raw/WAID alias in the configured account and inbox, the correct direction, and an authenticated canonical WhatsApp peer binding. Native LID alternatives are used only when the same stored native key supplies a valid PN alternative. The existing canonical peer lock remains held through native row locking and the pointer update. Native conversation pointers use Chatwoot `display_id`, not the database conversation ID.

Same-key native copies are accepted only when all 1–32 rows have identical critical source fields and every pointer is null or already exactly the verified destination. All such copies are bound together; divergent payloads or conflicting nonnull references stop the operation. Delivery status changes alone do not change the critical source version. Read flags, source payloads, statuses, files, Chatwoot rows, processing markers and recovery ledgers remain untouched. No provider send/download or history replay occurs.

The operation is atomic per source, not across the entire request or both databases. A later refusal can leave earlier sources successfully bound. Repeat only after independently reading the affected native pointers; exact existing bindings are idempotent, and conflicting bindings are never overwritten. The response reports `bound`, `existing`, or `would_bind` plus the native copy counts.
