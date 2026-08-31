# Chatwoot stored-history sync

Evolution API can backfill messages already stored in its database into the Chatwoot inbox configured for an instance.
The same operation is used by the automatic incremental repair coordinator.

## Lifecycle strategy

- An instance without a stored owner, or an authenticated source whose canonical owner JID differs from the stored
  owner, requests a full Baileys history sync. If credentials do not expose an owner until QR authorization, an existing
  instance starts in incremental mode; a newly observed different owner triggers one controlled socket restart in
  full-history mode.
- A restart, redeploy, or reconnect of the same source requests incremental repair. The last successful checkpoint is
  stored in the shared cache and the next run starts 15 minutes before it. If no valid checkpoint exists, the fallback
  window is six hours.
- Every enabled instance requests incremental repair at connection time and every 30 seconds. This also repairs gaps
  after an Evolution or Chatwoot restart without requiring an operator to estimate the outage window.
- Incremental requests for one instance are coalesced. If another request arrives during a run, one follow-up pass starts
  from the earliest requested timestamp.
- At most four incremental writers and two full-history writers run concurrently. Every writer also holds one shared
  per-instance lock across all `ChatwootService` objects in the process.
- A full history download and an explicit/manual stored-history request use separate in-memory message buffers. The
  manual request therefore cannot clear or mix the full-history payload while it is still arriving.

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
  identifier is the canonical LID and whose phone is empty. Reconciliation discovers these contacts by identifier, so
  the import does not create a customer-facing Chatwoot label for this internal state.
- Groups use their group JID as the contact identifier and keep the incoming participant name/confirmed phone in the
  message content, matching live Chatwoot group conversations.
- Status broadcasts, invalid messages, duplicate source IDs, already imported rows, and unsupported content are removed
  before contact, contact-inbox, or conversation foreign keys are selected or created. An unsupported-only identity
  therefore cannot leave an empty Chatwoot conversation shell.
- Imported rows keep their original direction and timestamp.
- `source_id` is canonicalized as `WAID:<message-id>` and checked within the target inbox.
- Inserts use an additional `NOT EXISTS` guard, so rerunning the same request is idempotent.
- The importer writes historical rows directly to Chatwoot's database. It does not trigger the API-inbox webhook and
  therefore cannot resend historical outgoing messages to WhatsApp.
- Only one stored-history writer can run per instance in a process. Interactive writes wait for that writer instead of
  colliding with it; the bounded worker endpoints intentionally fail fast so their orchestrator can pause safely.

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

The incremental repair job uses a shared checkpoint with a 15-minute overlap and a six-hour fallback when the checkpoint
is missing. It remains idempotent through `source_id`; it is not a replacement for the initial full backfill. It stays in
the legacy-safe `direct`/`skip` mode until a successful explicit write with
`scope: "all"` and `unresolvedLidMode: "provisional"` enables extended sync for that instance in the shared cache.
After activation, the incremental job includes groups and provisional LIDs. Confirmed `lid-mapping.update` events
reconcile provisional contacts immediately. A daily 03:15 job retries only unresolved LID contacts against the current
Signal store. Each contact is isolated during that retry, so one failed Chatwoot merge/update is logged and counted
without aborting reconciliation of the remaining contacts.

Reconciliation selects provisional contacts by their canonical `@lid` or `@hosted.lid` identifier. Legacy
`unresolved_lid` Chatwoot labels are not used by this process and can be removed without deleting contacts,
conversations, or imported messages.

Startup, 30-second incremental repair, and the daily LID reconciliation are scheduled only for providers whose live
`enabled` flag is true. For a disabled provider, use this endpoint explicitly or enable the integration separately
after reviewing its webhook and outbound-message behavior.
