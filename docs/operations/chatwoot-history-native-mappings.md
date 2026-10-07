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

Same-key native copies are locked within the exact instance, raw peer and direction. The admitted native database ID must retain its exact key, payload, type and timestamp. Only that admitted row and copies with fully identical key, payload and type qualify for pointer updates; equivalent receives retain their own timestamps. Differing envelopes remain unchanged and are counted as `unselectedNativeRows`, separately from `nativeRows` and `boundRows`. Any non-null conflicting pointer on a qualified row refuses; exact complete bindings are idempotent. The response reports `bound`, `existing`, or `would_bind`.

Incoming edits and reactions resolve native targets by known raw peer and direction. Before applying the event, historical NULL pointers use this same canonical peer lock and exact source-version checks, followed by an independent native reread. Existing complete mappings are checked without writing them; confirmed outgoing multipart ownership retains the complete acknowledged part set. Read/delete/reply lookups also use the available target peer/direction, and unscoped ambiguous keys return no target rather than selecting an arbitrary first row. Reply direction is not inferred from the replying message.

A single completely bound plain-text receive can be preferred for read-only event lookup when other copies differ only by omitted participant/addressing mode or the known passive `messageContextInfo` thread/secret fields, with identical visible content. This preference never qualifies those differing copies for mapping writes; contradictory pointers, other payload differences and unknown context fields remain ambiguous.
