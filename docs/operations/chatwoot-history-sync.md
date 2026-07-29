# Chatwoot stored-history sync

Evolution API can backfill messages already stored in its database into the Chatwoot inbox configured for an instance.
The same operation is used by the six-hour incremental repair job that runs at startup and every 30 minutes.

## Safety properties

- `POST /chatwoot/historySync/:instanceName` is protected by the normal Evolution API guards.
- Dry-run is the default. A write requires `"dryRun": false`.
- The target account and inbox come from the instance's Chatwoot configuration; callers cannot override them.
- Groups, status broadcasts, invalid messages, unsupported content, and unresolved LIDs are skipped and counted.
- WhatsApp LIDs are mapped to phone JIDs from stored `remoteJidAlt` values and the active Baileys signal repository.
- Imported rows keep their original direction and timestamp.
- `source_id` is canonicalized as `WAID:<message-id>` and checked within the target inbox.
- Inserts use an additional `NOT EXISTS` guard, so rerunning the same request is idempotent.
- The importer writes historical rows directly to Chatwoot's database. It does not trigger the API-inbox webhook and
  therefore cannot resend historical outgoing messages to WhatsApp.
- Only one stored-history sync can run per instance in a process.

## Requests

Full dry-run:

```bash
curl -sS -X POST "$EVOLUTION_URL/chatwoot/historySync/$INSTANCE_NAME" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true}'
```

Canary for one normalized phone JID:

```bash
curl -sS -X POST "$EVOLUTION_URL/chatwoot/historySync/$INSTANCE_NAME" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"remoteJid":"628123456789@s.whatsapp.net"}'
```

Full import:

```bash
curl -sS -X POST "$EVOLUTION_URL/chatwoot/historySync/$INSTANCE_NAME" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false}'
```

Bounded incremental repair:

```bash
curl -sS -X POST "$EVOLUTION_URL/chatwoot/historySync/$INSTANCE_NAME" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"since":"2026-07-29T00:00:00Z"}'
```

`limit` can restrict a run to the first 1–4000 importable messages. Use `remoteJid` for a meaningful canary because a
global limit can span multiple conversations.

## Verification

1. Run dry-run and record `selectedMessages`, unresolved LID counts, and skipped content.
2. Run one-conversation canary.
3. Verify message direction, original timestamps, chronology, and absence of outbound WhatsApp sends.
4. Run the full import.
5. Repeat the same request. `selectedMessages` and `importedMessages` must both be zero.
6. Confirm there are no duplicate `(inbox_id, source_id)` pairs in Chatwoot.

The incremental repair job uses a six-hour overlap. It complements live delivery and remains idempotent through
`source_id`; it is not a replacement for the initial full backfill.
