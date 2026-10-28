# we:Digital EVO read-path boundaries

Source baseline: `33494d5ca661a775751568f60909fdc1dae33273` (2026-10-29).
The fork ledger records release history; this page is the concise maintenance map.

## Native ownership

Express RouterBroker validation/authentication → thin controllers → the selected
instance's channel service → PrismaRepository. `ChannelStartupService` owns
shared persisted reads; `BaileysStartupService` owns native WhatsApp metadata.
Keep PostgreSQL/MySQL schemas and their existing provider-specific behavior;
do not replace a local optimization with another query framework or cache layer.

## Existing bounded paths

- Instance inventory: `src/api/routes/instance.router.ts` through the monitoring
  service. `includeCounts=false` omits relation counts only; connection state is
  still fresh. Default callers retain exact counters and existing authorization.
- Chat list: `src/api/services/channel.service.ts#fetchChats` selects narrow
  latest-message IDs before Contact/Chat joins and full payload hydration.
  Keep instance/peer/time filters inside the selector, message-only membership,
  current pagination and timestamp-tie behavior. This existing raw query is
  PostgreSQL-specific; do not claim new MySQL qualification from its tests.
- Chatwoot inbound: `utils/chatwoot-inbound-queue.ts` and
  `utils/chatwoot-inbound-prisma-store.ts` under the Chatwoot integration retain
  durable enqueue, leases, native source identity and two shared active receiver
  slots for live/polled work. Overflow stays in durable storage, not another
  in-memory queue. Disabled diagnostics must not serialize full message/media
  payloads. These boundaries are not changed by a roster read optimization.

## Group participant enrichment (2026-10-29)

`BaileysStartupService.findParticipants` fetches fresh metadata for the requested
group, then one instance-scoped Prisma Contact query restricted to the returned
participant IDs and known PN/LID aliases. Select only `remoteJid`, `pushName` and
`profilePicUrl`; all are native columns in both supported schemas.

The per-request JID → returned-row-index map removes repeated full contact scans.
When aliases match different contacts, the smallest returned-row index wins,
exactly as the former `contacts.find`; do not silently prefer PN, LID or exact ID.
This preserves the existing unspecified database row order, not a new ordering
guarantee. Preserve provider participant order/fields, nullish name/photo fallback
(including meaningful empty strings), input immutability and the existing PN-only
cache-write input. No contact from another instance may enrich the result.

The lookup dies at request completion. No persistent cache, new freshness policy,
extra metadata call, provider send, identity repair or dependency is introduced.
Baileys/Signal recovery and native send fences remain governed by
`../operations/baileys-group-sender-key-refresh.md`.

## Focused acceptance and upstream updates

Use literal-method tests, not a benchmark-only copy of the algorithm:
`tests/group-participant-lookup.test.ts`. They cover alias conflicts, shared
aliases, tenant isolation, null/empty values, absent aliases, unsaved/empty
rosters, provider snapshot preservation and exact query/cache inputs.

`../performance/2026-10-29-group-participants.md` records CPU/payload evidence
and its limits. Other affected-path regressions include chat-list projection,
instance inventory, Chatwoot mentions/participating groups and hot-path tests.
Run focused source lint/typecheck, exact merge-candidate lab acceptance and the
normal immutable release/readback separately. No automated test sends a real
provider message. During upstream merges reapply only the small method delta
if the same repeated scan remains; remove it if upstream already supplies an
equivalent linear lookup with the same contract. Rollback needs no data change.
