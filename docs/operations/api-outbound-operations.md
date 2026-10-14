# Durable API sends

`POST /message/sendText/:instanceName` and JSON `sendMedia` opt into durable
receipt recovery with a UUID `Idempotency-Key`. The authenticated caller remains
bound to its instance. Baileys is required; other providers and multipart media
refuse opt-in before transport. Ordinary requests retain their existing behavior.

The additive `ApiOutboundOperation` model persists the instance, canonical
route/payload SHA-256, planned WhatsApp ID, resolved destination, CAS claim token,
lease, attempt count, transport boundary, retry time and receipt. Full canonical
UUIDs yield distinct 32-character native IDs, with a unique per-instance index;
common UUID prefixes cannot share receipts. Same-key payload
or sender drift returns 409. Pending/unknown/live operations return 202; sent
operations return 201 with the saved native key. Only a precise pre-send negative
WhatsApp recipient check is terminal. Arbitrary 400 errors do not prove rejection.

`GET /message/operations/:instanceName/:operationId` uses the same instance/auth
guards, returns 200 for a retained operation or exactly
`{"error":"API_OPERATION_NOT_FOUND"}` with 404 for an absent one. It can
reconcile an interrupted operation against native retained rows using instance,
planned ID, outbound direction and actual destination. An unavailable message
body does not invalidate that exact key evidence.

Claims lease for 180 seconds; the HTTP-side send deadline is 120 seconds. A shared renewable lease remains owned until the underlying native promise
settles, even after an HTTP timeout. A process-local active promise also prevents
overlap; another API worker must wait for release or genuine lease expiry. The native receipt is committed before optional
history/webhook/media work; later failure cannot erase it. Expired claims before
transport become pending; after transport they become unknown. Recovery classifies the current marker
inside SQL CAS; receipt commits fence the validated destination, marker, claim
and attempt generation so stale snapshots cannot change a newer attempt. Backoff starts at
5 seconds and caps at 5 minutes. Shutdown closes admission and drains active sends.

Unknown attempts stay held unless a caller explicitly sets
`X-Evo-Retry-Ambiguous: true`. This standing policy accepts possible duplicates.
Reusing a planned WhatsApp ID is not an exactly-once delivery guarantee. Native
history may recover a receipt before another attempt; retain the operations table
and provider history throughout rollback and upgrades.

Both supported schemas have an additive migration `20261013090000`; production
PostgreSQL is tested with real SQL/CAS and migration application. MySQL has a
matching migration and JSON lookup adapter, but requires its own runtime
acceptance before enabling this mode. Apply the correct migration before sender
activation; do not remove retained evidence when reverting source or flags.

Tests: `API_OUTBOUND_TEST_DATABASE_URL=<synthetic local DSN> npx tsx --test
tests/api-outbound*.test.ts`. DB suites explicitly opt in and never read the
production DSN. Native transport is synthetic; no real provider send occurs.
