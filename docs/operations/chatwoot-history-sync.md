# Chatwoot stored-history sync

Evolution API can backfill messages already stored in its database into the Chatwoot inbox configured for an instance.
The same operation is used by the six-hour incremental repair job that runs at startup and every 30 minutes.

## Safety properties

- `POST /chatwoot/historySync/:instanceName` is protected by the normal Evolution API guards.
- Dry-run is the default. A write requires `"dryRun": false`.
- The target account and inbox come from the instance's Chatwoot configuration; callers cannot override them.
- An explicit authenticated history-sync request may use an existing provider with `importMessages: true` while its
  live `enabled` flag is false. This does not enable Chatwoot webhooks, live message forwarding, or scheduled sync.
  The response reports `providerEnabled` so operators can distinguish a one-off import from an active integration.
- `scope` explicitly selects `direct` (default), `groups`, or `all`; callers cannot accidentally import groups through
  the legacy/default request.
- WhatsApp LIDs are mapped to phone JIDs from stored `remoteJidAlt` values and the active Baileys signal repository.
- An explicit `refreshLidMappings` request can query known phone JIDs through Baileys USync and persists confirmed
  mappings in the normal Signal store. It never guesses a phone number.
- `unresolvedLidMode: "provisional"` preserves messages that still have no confirmed mapping in a contact whose
  identifier is the canonical LID, whose phone is empty, and whose label is `unresolved_lid`.
- Groups use their group JID as the contact identifier and keep the incoming participant name/confirmed phone in the
  message content, matching live Chatwoot group conversations.
- Status broadcasts, invalid messages, and unsupported content are skipped and counted.
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

Group dry-run:

```bash
curl -sS -X POST "$EVOLUTION_URL/chatwoot/historySync/$INSTANCE_NAME" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true,"scope":"groups"}'
```

Refresh confirmed LID mappings and preview the remaining provisional messages:

```bash
curl -sS -X POST "$EVOLUTION_URL/chatwoot/historySync/$INSTANCE_NAME" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true,"scope":"direct","refreshLidMappings":true,"unresolvedLidMode":"provisional"}'
```

`refreshLidMappings` is an explicit Signal-store operation even in a Chatwoot dry-run. It may persist confirmed
Baileys mappings, but it does not write Chatwoot messages or contacts.

Canary for one normalized phone JID:

```bash
curl -sS -X POST "$EVOLUTION_URL/chatwoot/historySync/$INSTANCE_NAME" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"remoteJid":"628123456789@s.whatsapp.net"}'
```

Canary for one group or unresolved LID:

```bash
curl -sS -X POST "$EVOLUTION_URL/chatwoot/historySync/$INSTANCE_NAME" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"scope":"groups","remoteJid":"123456-789@g.us"}'

curl -sS -X POST "$EVOLUTION_URL/chatwoot/historySync/$INSTANCE_NAME" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"scope":"direct","unresolvedLidMode":"provisional","remoteJid":"123456@lid"}'
```

Full import of every supported identity:

```bash
curl -sS -X POST "$EVOLUTION_URL/chatwoot/historySync/$INSTANCE_NAME" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"scope":"all","unresolvedLidMode":"provisional"}'
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

Stored rows that repeat the same canonical message ID are collapsed before selection and reported as
`duplicateSourceMessagesSkipped`; they cannot turn a successful idempotent insert into a false partial-write error.

The incremental repair job uses a six-hour overlap and remains idempotent through `source_id`; it is not a replacement
for the initial full backfill. It stays in the legacy-safe `direct`/`skip` mode until a successful explicit write with
`scope: "all"` and `unresolvedLidMode: "provisional"` enables extended sync for that instance in the shared cache.
After activation, the incremental job includes groups and provisional LIDs. Confirmed `lid-mapping.update` events
reconcile provisional contacts immediately. A daily 03:15 job retries only unresolved LID contacts against the current
Signal store. Each contact is isolated during that retry, so one failed Chatwoot merge/update is logged and counted
without aborting reconciliation of the remaining contacts.

Startup, 30-minute incremental repair, and the daily LID reconciliation are scheduled only for providers whose live
`enabled` flag is true. For a disabled provider, use this endpoint explicitly or enable the integration separately
after reviewing its webhook and outbound-message behavior.
