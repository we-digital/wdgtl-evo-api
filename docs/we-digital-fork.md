### Native JPEG cryptographic key-family selection (265)

A missing-cache native plain JPEG can retain an image envelope while its authenticated encrypted bytes use WhatsApp Document keys. The bounded default read authenticates the native Image MAC first. Only if that fails does it select Document decryption, requiring the exact native encrypted SHA-256, AES block shape and Document MAC from the same native media key and the same single fetched ciphertext. The original Baileys decryptor still produces bytes that must match the full native plaintext SHA-256 and size before any history write. Missing/corrupt digest, wrong keys/MAC, wrong plaintext or uncertain reads refuse; no second GET, key rewrite, MIME/source-kind change, retry or provider send is introduced. Owned media remains first, and video formats are unchanged.

Reapply this narrow `chatwoot-cached-media.ts` default-path check with its focused whole250/native-envelope regression after upstream changes. Rollback restores strict safe refusal for mismatched JPEG cryptographic families without modifying native rows, stored attachments, cache records or acknowledgements. Verify the original installed SDK with synthetic Image/Document encryption, negative encrypted/plaintext hashes and MAC/key/size, one-read bounds, unchanged MIME/envelopes, cache-first handling and the exact synthetic candidate lab before immutable deployment. Real private retained ciphertext fixtures are separate local evidence and are never committed.

# we:Digital Evolution API fork

## Unavailable native edit originals without a destination (2026-10-07)

- A retained edited image whose authoritative native payload is JSON null and whose native Chatwoot pointers are null can be acknowledged as `ignored_unavailable_provider_edit_original` only after exact source identity, one retained EDITED update and scoped destination absence are proved and rechecked.
- An encrypted edit of that same unavailable original records the complete envelope, original and ordering evidence without claiming successful decryption or a preserved destination. A target-key direction discrepancy is explicitly retained. Competing edits, identity changes, available originals and ambiguous destinations stop recovery.
- The outcome is skipped with a version-bound unavailable-original gap. The History service stores it in a separate schema-7 gap family; old preservation records retain their meaning. A changed source payload/version becomes eligible for reconciliation again. Ordinary missing media continues through authenticated media recovery and is never skipped by this branch.
- Existing unique destinations retain the previous preservation path. No provider sends, replacement content, placeholder imports or manual processed markers are introduced.

## Rails JSON store representation in recovery media proof (2026-10-07)

- The media import postimage reader accepts Chatwoot content attributes as a plain object or one JSON-encoded plain object, matching the Rails JSON store representation. It retains every field and compares every expected native/ingress attribute exactly. Malformed, null, array, double-encoded and changed attributes refuse before acceptance.
- No persisted attributes, media bytes, routing, provider requests or history markers are changed by this correction. Existing source, owner, attachment digest, timestamp and physical storage proof checks remain required.
- Source: `chatwoot.service.ts`; focused validation covers real service postimage checks, both valid representations and malformed/native-field negatives.

## Canonical routing for delayed provider writes (2026-10-04)

- Resolve actual Chatwoot message ownership under the Chatwoot provider peer lock before persisting Evolution conversation mappings. Preserve all source payload fields and existing outgoing null-source behavior; stale display IDs require the exact retained internal route.
- History imports serialize per inbox and then acquire sorted authenticated provider peer/alias locks before the existing source checks and insert. This replaces the broad messages table lock and preserves importer deduplication without claiming a universal source-ID uniqueness constraint.
- Source areas: chatwoot.service, chatwoot-canonical-message-binding and chatwoot-import-helper. No dependency, provider authentication, Baileys, template, auto-reply flag or Evolution schema changes. Deploy this compatible bridge before the additive Chatwoot routing migration.
- Reapply the cross-store lock lifetime and import lock order together. A native commit followed by a Chatwoot connection failure requires reconciliation; it is never evidence of rollback or authority to replay a send.
- Rollback: old shells remain through qualification. After deletion, retain compatible mapping/import consumers and durable Chatwoot routes; unbridged writers are unsafe. This change introduces no provider sends or business operations.
- Focused validation: literal mapping/import helper recordings, actual PostgreSQL delayed writer/import interleavings and duplicate import, existing direction/source guards, targeted TypeScript checks and lint. Runtime bridge and final cleanup acceptance are separate.


## Source and deployment contract

`main` packages the production source for `bbc-evo`; `staging` packages the
staging source for `bbc-stage-evo`. The source workflow publishes an immutable
`<branch>-<40-character-sha>@sha256:<digest>` reference and sends the exact
repository, branch, source SHA, image namespace, and digest to the reviewed
receiver in `we-digital/bbc-devops`.

Runtime configuration, secrets, destination inventory, migration/bootstrap,
isolation, smoke checks, and rollback remain owned by bbc-devops. Mutable image
tags are never deployment inputs.

## Minimal GitHub Actions policy

- **Behavior:** exactly one source workflow may exist and it may only package,
  publish, reuse, and dispatch an immutable Evolution API image for `main` or
  `staging`.
- **Source areas:** `.github/workflows/build-and-deploy.yaml`,
  `.github/we-digital-actions-allowlist.txt`,
  `.github/check-we-digital-actions-policy.sh`, and
  `docs/we-digital-ci-policy.md`.
- **Flags/schema:** no application flag or database schema change.
- **Upstream reapply/conflicts:** remove every workflow introduced by an
  upstream merge, keep the one-file allowlist closed by default, and refresh
  the reviewed workflow blob only after inspecting the exact diff.
- **Reviewed workflow identity:** blob
  `4aab8c71a79ead19706891c1f697d0ae755be592` groups build identity outputs and
  dispatches staging through the authoritative `bbc-devops:main` receiver.
- **Rollback:** revert the policy commit only together with a conscious review
  of any workflow being restored. Deployment safety checks remain mandatory.
- **Focused regression:** run the local policy checker, `git diff --check`,
  `npm run lint:check`, affected tests, a production image build for Dockerfile
  changes, and stage smoke before promotion.
- **Build optimization:** the Docker context excludes documentation, policy,
  and test-only paths; npm downloads and cross-branch BuildKit layers use
  registry-backed caches. A policy-versioned runtime tag allows an exact
  validated `BUILD_INPUT_SHA` match to receive a new immutable commit tag
  without rebuilding identical production bytes.

## BBC Manager branding

- **Behavior:** the bundled Evolution Manager uses the local Evolution logo
  and displays an environment-aware browser page title: `Evo :: BBC :: Stage`
  on `stage.evo.respon.io` and `Evo :: BBC :: Prod` on `evo.respon.io`.
  Unknown/local hosts fall back to `Evo :: BBC` instead of being mislabeled as
  a BBC deployment contour.
- **Source areas:** `manager/dist/index.html` and the bundled Manager assets
  under `manager/dist/`.
- **Flags/schema:** no application flag, API contract, or database schema
  change.
- **Upstream reapply/conflicts:** an upstream Manager rebuild can replace the
  committed `dist` output. Reapply the exact hostname-to-environment title map
  after every Manager upgrade and confirm that no bundled script overrides
  `document.title`.
- **Rollback:** restore the upstream `<title>` value; the Manager runtime and
  API are otherwise unchanged.
- **Focused regression:** verify the title script maps `stage.evo.respon.io` to
  `Evo :: BBC :: Stage`, maps `evo.respon.io` to `Evo :: BBC :: Prod`, and keeps
  the neutral fallback for unknown hosts. Package the immutable image, deploy
  to staging, and verify the browser title on both login and authenticated
  Manager routes.

## Chatwoot ingress scope contract

- **Behavior:** every live EVO-to-Chatwoot inbound message includes the
  version 2 `content_attributes.we_digital_ingress` object with provider
  `evo_whatsapp`, inbound/outbound direction, `from_me`, scope `direct`,
  `group`, `broadcast`, or `unknown`, and a route binding for the exact EVO
  instance and Chatwoot inbox. The route contains an HMAC fingerprint of the
  physical receiver number, never the number itself. Text and multipart media
  paths use the same helper. Unknown identities fail closed; a LID is direct
  only when its alternate JID is a confirmed `@s.whatsapp.net` identity.
  Automatic replies require an explicit boolean `fromMe: false`; a missing or
  malformed direction is forwarded normally but marked unknown and therefore
  fails closed for auto-reply eligibility. EVO
  reconciles the expected binding into the selected Chatwoot API channel's
  `additional_attributes` before forwarding an inbound message. A missing
  binding or a physical-number/instance change fails closed for automatic
  replies; an existing mismatched binding is replaced only by an explicit
  Chatwoot integration update. The live phone-form Baileys owner JID is the
  authoritative receiver; a present LID/non-phone owner fails closed rather
  than falling back to a possibly stale creation-time number. When WhatsApp
  delivery fails, EVO updates that exact Chatwoot message to `failed` before
  writing the existing private diagnostic note; this preserves the original
  auto-reply intent/cooldown while exposing a correlatable failure outcome.
  Chatwoot auto replies must also carry a versioned delivery binding with the
  exact EVO instance, physical receiver fingerprint, and Chatwoot inbox. EVO
  rebuilds that expected route from the live instance and rejects missing,
  stale, foreign, or mismatched bindings before calling Baileys, then marks
  the exact Chatwoot message failed. Successful Chatwoot and public `sendText` calls persist a
  privacy-safe origin and request ID in the stored message `contextInfo`, so a
  server send is distinguishable from an unbound linked-device `fromMe`
  message after the fact. Group ingress also preserves only the validated,
  sorted WhatsApp participant JIDs from native `mentionedJid` metadata under
  `we_digital_ingress.mentioned_jids`; message text is never copied into the
  provenance envelope. This lets read-only reporting distinguish an explicit
  linked-account mention from unrelated operational or informational group
  traffic. Extraction reads only the current message and supported wrappers;
  quoted-message mentions are deliberately ignored. EVO also retains a
  bounded, privacy-safe cache of only `stanzaId` and validated `mentionedJid`
  values from an earlier Baileys `append` event. If the matching `notify`
  event is stripped of that context, EVO restores those identifiers before
  Chatwoot delivery so native replies and mentions keep their structure;
  quoted content and message text never enter this cache. Concurrent
  `append`/`notify` deliveries for the same provider identity share one
  Chatwoot request and retain its result briefly; later replays reuse the
  already persisted Chatwoot binding. This prevents duplicate Chatwoot rows
  without suppressing a retry after a failed request. Native reaction
  callbacks mark authenticated `fromMe` actors as `external_id=me` and forward the
  provider event timestamp so reporting can reconstruct additions/removals
  without using callback receipt time. Provider deletion callbacks first obtain
  an authenticated Chatwoot soft-delete acknowledgement containing explicit
  WhatsApp provenance, then remove the local provider mapping. A failed or
  uncertain Chatwoot callback leaves that mapping intact for safe retry; the
  provider event never hard-deletes the Chatwoot row. For live group ingress, exact native
  `mentionedJid` actors are also joined to the freshly persisted participant
  roster by either the exact participant identity or its confirmed phone alias,
  then rendered as Chatwoot structured mention links using the roster identity.
  Unresolved actors
  remain plain text and cannot become a false notification.
- **Source areas:**
  `src/api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope.ts`,
  `chatwoot-auto-reply-binding.ts`, `chatwoot-provider-deletion.ts`,
  `outbound-provenance.ts`, and
  the message/inbox creation paths and correlated delivery-failure update in
  `chatwoot.service.ts`.
- **Flags/schema:** no EVO feature flag or database schema change. Ingress,
  channel route binding, delivery binding, and outbound provenance are
  additive metadata; Chatwoot owns its separately gated automatic-reply
  behavior. The Chatwoot API token is used only as the local HMAC key and is
  never written into the route metadata.
- **Upstream reapply/conflicts:** preserve the helper call on both JSON text
  and multipart media forwarding paths when upstream changes Chatwoot payload
  construction. Preserve fail-closed cached-inbox reconciliation and the
  explicit-rebind-only rule when instance lifecycle code changes. Never infer
  direct scope or physical receiver identity from contact names, assignees,
  agent access, or Chatwoot conversation shape.
- **Rollback:** deploying the prior immutable EVO image removes the additive
  marker. Chatwoot then classifies new messages as unclassified and must not
  auto-reply, while ordinary message delivery remains available. Roll back the
  provider-deletion callback only together with a Chatwoot image that retains
  the legacy deletion behavior; local message mappings remain recoverable
  because they are removed only after acknowledged soft deletion.
- **Focused regression:** run `npm run test:unit --
  tests/chatwoot-ingress-scope.test.ts tests/chatwoot-auto-reply-binding.test.ts
  tests/chatwoot-provider-deletion.test.ts tests/outbound-provenance.test.ts`,
  `npm run lint:check`, and `npm run build`;
  staging canary must prove direct/text, direct/media, group, broadcast,
  unknown, wrong-instance auto-reply rejection, stored provenance, a failed
  provider delivery, missing route, cross-instance/inbox replay,
  receiver-fingerprint mismatch, and explicit relink before production
  promotion.

## Chatwoot LID contact creation and webhook echo acknowledgement

- **Behavior:** when a direct WhatsApp message arrives with a LID but no
  `remoteJidAlt`, EVO first asks the live Baileys LID mapping for a phone JID.
  A confirmed phone JID follows the canonical phone-contact path and is stored
  back on the message key. If no mapping exists, EVO creates or reuses a
  provisional contact keyed by the canonical `@lid` identifier without
  inventing a `phone_number`; later history reconciliation can merge or update
  that identity when a trusted phone mapping becomes available. For incoming
  LID-addressed group messages, a confirmed phone `participantAlt` remains the
  participant identity while the group JID remains the conversation route. A
  missing or invalid alternate preserves the participant's provisional LID
  namespace instead of reinterpreting its numeric user part as a phone. Avatar
  lookup receives the canonical phone, LID, hosted-LID, or group JID, and newly
  created contacts are labelled from the returned contact ID or an exact
  identifier lookup. Incoming
  `message_created` events and outgoing Chatwoot echoes that already carry a
  `WAID:` source are acknowledged before loading the Chatwoot client. A valid
  new outgoing message still follows authenticated durable admission.
- **Flags/schema:** no new flag, schema, or public API. The behavior uses the
  existing Baileys LID mapping, Chatwoot contact identifier, `WAID:` source ID,
  and durable outbound admission contract.
- **Source areas:** `chatwoot.service.ts`, `src/utils/createJid.ts`, with focused unit coverage in
  `chatwoot-create-conversation-lid.test.ts` and
  `chatwoot-webhook-fast-ack.test.ts`.
- **Upstream reapply/conflicts:** preserve the distinction between phone JIDs,
  LIDs, hosted LIDs, and groups when upstream changes conversation creation.
  Never derive a phone number from the numeric portion of a direct or group
  participant LID, and never gate group `participantAlt` selection on the
  group route itself being a LID. Keep the fast
  acknowledgement before `clientCw`; do not bypass authentication or durable
  admission for a genuinely deliverable outgoing webhook.
- **Rollback:** revert this block to the prior conversation lookup and webhook
  path. Provisional contacts remain valid Chatwoot contacts and can be
  reconciled by the existing LID maintenance path; no schema rollback is
  required.
- **Focused regression:** run both focused tests, including direct provisional
  reuse/reconciliation, group `participantAlt`, provisional group participant,
  canonical avatar lookup, and contact-label targeting; then the complete unit suite,
  `npm run lint:check`, `npm run build`, and staging canaries for an unresolved
  LID, a resolved LID, an inbound/retained echo, and one valid outgoing message
  before production promotion.

## Durable Chatwoot API-inbox outbound delivery

- **Behavior:** validated Chatwoot outgoing webhooks are transactionally
  recorded as one durable operation per text/attachment part before HTTP 202.
  Only the exact top-level `message_created` payload is used; deletion of a
  retained message atomically stops its frozen set and removes every confirmed
  WhatsApp part before clearing that part's local mapping. Stable numeric attachment IDs are sorted to
  make part identities independent of webhook array order, and the exact
  content/origin/part set is frozen by hash plus database uniqueness.
  The signed webhook's authoritative payload fingerprint is frozen with that
  set and must still equal Chatwoot's locked exact-message fingerprint before
  transport, so an edit during an unbounded socket outage cannot send stale
  content.
  A database-leased worker sends each part with a deterministic planned
  WhatsApp ID. Signed admission resolves the persisted instance/provider route
  without requiring a local WhatsApp socket; the exact local socket is checked
  again before transport. A missing, stale or disconnected socket keeps the
  operation pending with bounded backoff and does not consume the six
  preparation attempts. Preparation failures retry before transport; failures after the
  persisted `sending` boundary become `ambiguous` and reconcile by exact ID
  without blind resend. Preparation is bounded to six attempts and then emits
  one exact message-level failure callback without invoking transport. The
  captured provider/account/inbox/conversation/message/contact origin and the
  live physical receiver/instance binding, authoritative enabled provider row,
  inbox ID/name and route metadata, current conversation/message relationship,
  and destination are revalidated at enqueue, preparation, transport and
  callback; reassignment, rename, deletion, or mismatch quarantines the whole message.
  Multipart callback begins only after all parts resolve. The leader PATCHes
  every part in canonical order with its stable operation key, index, count and
  raw WAID. EVO validates Chatwoot's exact contract-version-1 acknowledgement
  and complete accumulated source-ID mapping for each response. Chatwoot picks
  part 0 as canonical `source_id`; EVO keeps every part WAID durable. Partial
  callback success is replayed idempotently from part 0 after outage/restart,
  never repeats WhatsApp transport, and marks the whole message completed only
  after all acknowledgements succeed. Conflicting mappings fail closed. The
  callback response must also acknowledge the exact message ID and valid status
  (or exact `failed` status). Mixed terminal multipart outcomes preserve the
  exact successful mappings as `PartialDelivery` without resending. Validation,
  readiness, media/send and callback work have abortable time budgets; only a
  pre-transport timeout may retry. Feature-off preserves the legacy source-ID
  path for new messages while retained ledger rows prevent replay across
  rollback/cutover.
  The live message check uses the bounded inbox-scoped exact-message contract
  and production `{meta,payload}` shape, including numeric outgoing enum `1`,
  rather than a recent-message list. Provider-delivery PATCHes use actual
  `application/json` with a nested three-key object. Persistent per-claim
  generations fence every lease mutation, and Baileys rechecks abort after the
  awaited transport boundary. Deletion requires an authoritative live
  `deleted=true` snapshot; the callback-outage window is handled through the
  deterministic planned WAID and exact retained `contextInfo` provenance
  without accepting conflicting top-level mappings. Signed attachment names
  are derived only from a decoded, sanitized URL pathname, never credentials,
  query parameters, or fragments. A validated download response MIME remains
  authoritative when the safe filename has no recognized extension.
  Media-preparation logs retain only the bounded error class, while binding
  and abort errors pass through. Locally generated `send.message` or
  `messages.upsert` echoes that carry complete Chatwoot outbound provenance, or
  whose byte-exact WhatsApp ID and instance ID are retained in the durable Chatwoot outbound ledger,
  are not imported back into Chatwoot as a second outgoing message. The ledger
  lookup covers Baileys socket echoes that do not retain custom message
  metadata. Ordinary API sends, inbound messages, and unknown IDs keep their
  existing event path. History recovery treats an exact raw WhatsApp source ID
  and its `WAID:`-prefixed form as the same retained Chatwoot message, so a
  later production history pass cannot re-import a successfully delivered
  live outbound row. Destination lookup failures abort the history batch
  instead of being interpreted as an empty destination.
  Quoted sends retain both the Chatwoot parent row and its exact external
  WhatsApp ID in the durable payload. Preparation resolves the internal
  provider binding first and then the exact external ID within the same
  instance; a requested quote that cannot be resolved fails before transport
  instead of silently becoming an unquoted message. The existing operation
  identity remains compatible because the signed snapshot fingerprint already
  binds the complete quoted-message attributes.
  Native same-session forwards use the same durable operation, deterministic
  planned WhatsApp ID, transport fence, callback retry, and webhook replay
  protection as text/media delivery. Source resolution and async-delivery
  availability fail before transport. Once Baileys acknowledges the forward,
  message-row persistence failure is deferred into callback maintenance and
  can never return to the copied-content path or trigger a second provider
  send. The prepared provider result is retained in the operation so local
  persistence and Chatwoot binding can be retried without transport.
  Admission no longer serializes every route through the singleton
  `ChatwootOutboundAdmissionGuard`. The short transaction first acquires the
  existing destination lane row, which serializes only messages that share an
  `instance + WhatsApp destination`; independent lanes commit concurrently.
  Backlog depth/age is measured only for that destination lane before the
  transaction, so a stale or exhausted disconnected instance/destination does
  not reject another lane. The check never holds the lane lock or a database
  connection while scanning. Duplicate receipt and
  frozen-message checks are repeated after the keyed lane lock, preserving
  idempotency for a lost HTTP 202. Prisma transaction acquisition and execution
  budgets are configurable and default to 2 seconds / 5 seconds instead of the
  previous 500 ms / 1.5 seconds.
- **Source areas:** `chatwoot-outbound-queue.ts`,
  `chatwoot-outbound-prisma-store.ts`, `chatwoot.service.ts`, the Chatwoot
  router/controller startup wiring, `chatwoot-transport-options.ts`, Baileys'
  existing message-ID option and `media-message-metadata.ts`,
  provider Prisma schemas/migrations, and
  `docs/operations/chatwoot-outbound-delivery.md`.
- **Flags/schema:** `CHATWOOT_OUTBOUND_ASYNC_ENABLED` and
  `CHATWOOT_OUTBOUND_ASYNC_DRAIN_ONLY` default to false. The
  `CHATWOOT_OUTBOUND_ADMISSION_MAX_WAIT_MS` and
  `CHATWOOT_OUTBOUND_ADMISSION_TIMEOUT_MS` controls default to `2000` and
  `5000`, and are clamped to bounded safe ranges. The
  additive `ChatwootOutboundOperation` table and claim-generation fence are present in PostgreSQL,
  PgBouncer and MySQL schemas; migrations exist for PostgreSQL and MySQL.
- **Upstream reapply/conflicts:** preserve the database transition immediately
  before the first Baileys transport call, the deterministic message ID on
  text/audio/media/native-forward, persisted authenticated admission during socket outages,
  non-terminal readiness deferral, exact-current-message selection, route validation before
  enqueue, every per-part `provider_delivery` acknowledgement, API-only live
  source-ID confirmation, and fail-closed treatment of expired `sending`
  leases. Never collapse multipart to a primary-only callback, move media
  preparation behind the sending boundary, remove retained-ledger cutover or
  deletion coordination, wrap `OutboundBindingMismatch` in an adapter error,
  or log operation payloads/customer identifiers.
- **Rollback:** establish an explicit ingress cutoff, then enable drain-only
  while async remains enabled, reject new ingress, and wait for active states
  to drain. Reconcile `ambiguous` only by
  exact planned WAID and investigate `quarantined`; never reset or blindly
  resend either. Disable async on the compatible ledger-aware image only after
  every accepted operation is terminal. Deploy the prior immutable image only
  after additionally proving that no queued upstream webhook, retry, or
  redelivery can cross the cutoff; otherwise roll forward. Keep the additive
  table and rows.
- **Focused regression:** run `npm run test:unit --
  tests/chatwoot-outbound-queue.test.ts tests/chatwoot-outbound-prisma-store.test.ts
  tests/chatwoot-provider-dto.test.ts tests/chatwoot-delivery-failure.test.ts
  tests/chatwoot-auto-reply-binding.test.ts tests/whatsapp-media-metadata.test.ts
  tests/outbound-provenance.test.ts tests/chatwoot-history-sync.test.ts
  tests/persist-native-forward-message.test.ts`,
  generate Prisma for PostgreSQL and
  MySQL, then run `npm run build` and `npm run lint:check`. Staging must prove
  text, media, multipart, duplicate webhook, callback retry, pre-send failure,
  process restart and deliberate ambiguous reconciliation before promotion.

## Upstream maintenance

Keep upstream Git history and reapply the fork as ordinary reviewable commits.
After every reviewed upstream merge, compare `.github/workflows`, run the local
policy checker, and preserve only the explicitly reviewed packaging workflow.
Do not revive upstream Docker Hub publishers, CodeQL, dependency review, or PR
quality jobs as part of conflict resolution.

## Native Chatwoot bridge authentication

- EVO includes `X-Chatwoot-Native-Bridge-Token` from `CHATWOOT_NATIVE_BRIDGE_TOKEN` on its authenticated Chatwoot client. Chatwoot requires this second credential before accepting `skip_native`, channel reaction actors, or other bridge-only parameters.
- Native-forward ambiguity and archive-key acceptance are shared production helpers imported directly by unit tests; tests must not duplicate these conditions.

## Local development lab and existing inbox binding

The local Docker lab in `bbc-devops/local/messaging` mounts this worktree using
`Dockerfile.dev-lab`, runs `tsx watch`, and retains independent database and
session volumes. It starts from production `db98edeca8eda7c55556207a64dc8d22901dca43`.
During setup, `POST /chatwoot/set/:instanceName` with `autoCreate=false` returned
500 because the route provides no `instanceId` when storing the signed webhook
secret. `ChatwootService.create` now resolves the persisted ID by route name
before either inbox initialization path and overrides any query-supplied ID.
Regression cases cover missing and foreign IDs; the live local API verifies
both existing inbox bindings and durable 24-character signing secrets.
No production deployment is part of this local change.

## API-inbox WhatsApp destination identity and immediate send (2026-09-28)

- **Behavior:** The authenticated Chatwoot webhook accepts a valid WhatsApp JID or numeric identifier; an opaque contact label such as `whatsapp:<id>` falls back to a valid E.164 phone. The selector is shared by normal message, edit, and deletion paths and must match Chatwoot's exact-message snapshot. Invalid destination data is not coerced into a guessed JID. Durable queued text delivery no longer waits an artificial randomized 500–2000 ms or emits typing presence solely for that delay; the existing Baileys destination check, transport fence, deterministic WAID, and callback remain in place.
- **Source areas:** `chatwoot-outbound-binding.ts`, `chatwoot.service.ts`, and focused outbound-binding tests. The matching Chatwoot snapshot selector must deploy in the same cutover.
- **Flags/schema:** No new flag or schema. `CHATWOOT_OUTBOUND_ASYNC_ENABLED` continues to control durable delivery.
- **Upstream reapply/conflicts:** Keep the same destination rule at webhook admission and in Chatwoot's signed frozen/exact snapshot. Do not remove authoritative pre-transport checks or retry an ambiguous send merely to improve latency.
- **Rollback:** Drain nonterminal operations before rolling both selectors back together; terminal failed operations need exact-ID reconciliation and are never blindly replayed.
- **Focused regression:** `npx tsx --test tests/chatwoot-outbound-binding.test.ts`, `npm run build`, `npm run lint:check`, and local/contour smoke checks. Measure creation-to-transport time on a designated test-only dialogue.

## EVO-first Chatwoot snapshot compatibility (2026-09-28)

- **Behavior:** During an EVO-first deployment, the prior Chatwoot image can still return an opaque contact label in its exact-message snapshot even though the authenticated webhook contains a separate valid phone. If and only if the exact destination differs from EVO's frozen valid phone, EVO reads the current account-scoped conversation and accepts the legacy snapshot only when account, inbox, conversation, contact ID, exact opaque label, current phone and frozen destination all agree. The existing exact snapshot fingerprint, route, deletion, provenance and pre-transport fence still apply. Normal matched snapshots incur no extra conversation read.
- **Source areas:** `chatwoot-outbound-binding.ts` and `chatwoot.service.ts`; focused mixed-version binding regression.
- **Upstream reapply/conflicts:** Keep this narrow transitional check until all production Chatwoot images and retained outbox rows have migrated. Never accept an arbitrary destination mismatch or skip the fresh phone/contact comparison. The exact message response alone does not include the current phone.
- **Rollback:** Do not roll EVO back after new Chatwoot is active unless no nonterminal operations exist and the old EVO can safely consume the frozen Chatwoot payloads. Preserve immutable receipts and reconcile any ambiguous send rather than replaying it.
- **Focused regression:** `npx tsx --test tests/chatwoot-outbound-binding.test.ts`, full EVO tests/build/lint, stage runtime canary, and a non-sending production legacy-shape validation before Chatwoot promotion.

## Bounded release and drain of uncertain outbound sends (2026-09-28)

- **Behavior:** Production EVO restart began transport for Chatwoot message 2463608 before shutdown; its exact provider WAID was not durably observed, so it correctly remained `ambiguous` and was never retried. Seven subsequent distinct messages in the same destination lane were then indefinitely pending. After a full 10-minute transport-lease window, an ambiguous or transport-unresolved quarantined predecessor with a known `sendStartedAt` no longer blocks *different* Chatwoot message IDs. The ambiguous operation remains unchanged and exact-ID maintenance continues; sibling parts of that same multipart message, recent ambiguities, and missing-start timestamps remain fenced. Pending siblings of an aged ambiguous multipart message no longer starve distinct later messages or their webhook admission; they can send only after their own preceding part reconciles. Pending/preparing/sending/deletion blockers retain their existing behavior. Unresolved outcomes are excluded from delivery-backlog depth/age, preventing an aged reconciliation row from rejecting new webhook admissions. This trades only indefinite cross-message ordering for live delivery, not exactly-once send safety.
- **Source areas:** `chatwoot-outbound-prisma-store.ts`, `main.ts`, `Dockerfile`, focused tests, and `docs/operations/chatwoot-outbound-delivery.md`; no schema or flag change. Docker execs Node as PID 1 after database bootstrap, and SIGTERM/SIGINT close HTTP ingress then await accepted requests and the outbound worker drain before exit. The paired bbc-devops compose files give this bounded drain three minutes in both contours.
- **Upstream reapply/conflicts:** Keep the no-resend rule for `ambiguous`, deterministic planned WAID, claim-generation fencing, and same-message multipart ordering. Never mark an ambiguous send failed merely because no local mapping exists.
- **Rollback:** Do not roll back to an image that permanently fences a lane while distinct successor operations remain pending. An ambiguous predecessor still needs exact provider/device reconciliation independently of later deliveries.
- **Focused regression:** `npx tsx --test tests/chatwoot-outbound-prisma-store.test.ts`, full unit suite, type/build/lint, Docker entrypoint signal test, staging exact-image verification and a production ledger readback of the affected lane without creating or replaying a customer message.

## Selected WhatsApp reply excerpts (2026-09-29)

- **Behavior:** WhatsApp ingress reads the provider quotedMessage and persists its textual quote snapshot as Chatwoot content_attributes.quote_text only when it differs from the currently stored complete parent. Equality proves an ordinary whole-parent reply. A difference can represent either a selected fragment or the provider snapshot of a missing/edited parent, so the bridge preserves the exact snapshot without claiming a distinction WhatsApp does not expose. Outbound delivery freezes quoteText into the durable operation identity and presents a cloned Baileys quoted message whose key still identifies the complete parent while its quoted content contains that snapshot. Ordinary whole-message replies retain the previous payload, operation identity, and provider behavior.
- **Source areas:** chatwoot-reply-context.ts, chatwoot-outbound-queue.ts, and chatwoot.service.ts.
- **Official contract:** Baileys accepts a WAMessage in the quoted send option and copies its key and message into contextInfo; the pinned fork retains this contract for text and attachment sends.
- **Flags/schema:** No new flag or database migration. The optional quoteText field is part of newly admitted durable operation JSON and its hash only when a selected excerpt exists.
- **Upstream reapply/conflicts:** Preserve wrapper-aware inbound extraction, parent-content comparison including missing/edited-parent fixtures, cloned rather than mutated stored provider content, and quoteText in the deterministic message-set hash. Do not retry an ambiguous transport after changing quote metadata.
- **Rollback:** Drain or reconcile nonterminal outbound operations before rolling EVO and Chatwoot back together. Existing terminal rows and Chatwoot quote_text metadata can remain.
- **Focused regression:** full serialized EVO unit suite, TypeScript build, lint, shared-lab synthetic inbound/outbound text/media request shapes, and exact-current-main merge-candidate verification.

## 2026-09-30: WhatsApp provider edits preserve the original identity

Edit callbacks POST to the existing authenticated Chatwoot native edit endpoint instead of creating a notice with the original WAID. Source content/edit history is persisted before the awaited callback; native outgoing edit/delete lookups are scoped by instance because two connected instances can legitimately observe the same WhatsApp ID. Original Chatwoot IDs and bindings are never overwritten by an edit notice.

Destination-aware cached recovery reconciles retained edited content through that same endpoint, including messages whose status was later replaced by a read receipt. It compares the destination text/edited flag and verifies persistence before acknowledging an existing source; imported edited originals receive the same update. Existing guards, account/inbox/direction scope, unsupported outcomes and immutable deployment contract remain unchanged. No new schema, provider retry queue or public n8n changes.

Reapply: retain this behavior when upstream changes messages.edit/send.message.update, import helper or native mutations. Rollback: stop in-place outgoing edit callers before reverting the coordinated Chatwoot permission extension; repaired original/provider ownership remains valid. Focused checks: chatwoot-provider-edit, history-sync/source guard, TypeScript/build/ESLint, exact synthetic shared lab and protected immutable receiver readback.

WhatsApp edit eligibility now uses the original send time and a strict 15-minute window. New edit persistence preserves messageTimestamp and stores the original time in existing contextInfo JSON. Legacy edited rows use a completed exact outbound operation sentAt; without proof they reject before sending. Incoming/accepted provider callbacks and history reconciliation are not age-gated. Native edit restriction is a structured rejected probe, never local success. Extended-text edits update the actual text field. No migration or added queue. Focused check: tests/whatsapp-edit-restrictions.test.ts.
Expired native edit probes carry only the structured time_expired reason; other eligibility failures retain the provider restriction. This lets Chatwoot show the owner's “Exceeded time for edit” copy without mislabeling a permission error as time expiry. Same 15-minute authority checks and no local success on rejection.

2026-09-30 automatic backfill correction: an outgoing Chatwoot message with multiple attachments legitimately owns multiple WhatsApp provider deliveries. History now reuses the existing confirmed provider_delivery contract1 complete part set, preserves part0 as canonical source, checks all part aliases for independent destination owners, and skips already delivered secondary parts instead of creating another bubble or overwriting source ownership. Incomplete/duplicate/wrong-canonical receipts remain conflicts. Body-free notify ingress telemetry distinguishes provider age at receipt, pre-delivery processing and destination delivery time. The unfiltered baseline includes44 delays over120seconds on p-yuli (max574.4s), so natural-traffic acceptance must include these outliers; a subset defined by post-delivery source persistence is insufficient proof.

2026-09-30 source-guard correction: PostgreSQL guard distinguishes an actual provider inbox/source change from an UPDATE that merely repeats the existing identity columns. Legacy alias duplicates previously made ordinary delivery/read status PATCH requests fail with23505, despite no new identity being created. Unchanged identity updates preserve all rows; INSERT/new/rebound aliases still lock the guard and reject duplicates. Source: chatwoot-history-source-guard.ts; focused PostgreSQL regression includes retained legacy aliases, no-op identity update, new alias/rebinding rejection and both arrival orders/in-flight writer. Existing production function needs a separately reviewed, exact-definition-backed-up refresh after deployment; future guard activation uses corrected source. No row cleanup or uniqueness relaxation for new identities. Rollback restores the prior function from verified backup and retains all provider records.

## Cached recovery with unavailable provider edits

- Known standalone reaction and sender-key encryption controls are explicit skipped outcomes, never message placeholders or reaction writes. Unknown/contradictory records stop before destination changes.
- Recovery compares the cached message key/body/timestamp with authoritative source and verifies unique destination aliases, account, inbox and direction before ACK. Missing supported ordinary messages use the existing guarded import path.
- An empty retained image edit may return `preserved_existing_source_payload_unavailable` only for one matching public image with a stored image blob and matching bridge metadata. The helper locks and reads that destination without changing its caption, attachments, sender, timestamps, replies or reactions. Missing/conflicting/deleted images fail closed.
- History persists that outcome as an unresolved source-version gap atomically with ACK. A newer nonempty `provider_edit_reconciled` outcome resolves the gap after persisted edit readback; mere message existence does not prove an edit.
- Contract version remains 2026-08-28; this is an additive outcome, not permission to replay old operator approval. No new feature flag or EVO schema migration. History adds SQLite schema v3. Rollback to previous immutable sources preserves gap rows; do not drop the ledger or manually change ACK markers.
- Focused checks: history/provider edit and unavailable image tests, cache restart/race/version tests, source lint/build and exact synthetic shared-lab candidate. Provider sender-key compatibility remains pinned and unaffected.
- The native SQL history importer does not materialize attachment blobs. Fresh missing media therefore stops this recovery before edit/import/ACK instead of silently acknowledging a placeholder as complete media. Fresh supported conversation/extended-text records can import once; existing media and uniquely proven unavailable image edits remain eligible.

## Canonical Chatwoot provider conversations (2026-10-01)

Opt-in `CHATWOOT_PROVIDER_CONVERSATION_BINDINGS=false` preserves the legacy path
by default. After Chatwoot's additive binding schema/controller is deployed, live
WhatsApp capability reads and trusted native resolution use the stable native peer
within the exact account/inbox. The protected reply distinguishes API display ID
from database ID, validates its complete scope, and bypasses old conversation caches.
Resolved incoming conversations reopen through the existing Chatwoot message path;
pending configuration is retained. Existing contacts, avatar attachments and files
are reused; group metadata is fetched only for new contacts and roster synchronization
retains the previous cache interval. Incoming group participants still reuse their
native PN/LID contact, or create it
when missing, without downloading existing avatars or inventing phone identities.
Native bridge credentials are sent only to the already configured trusted Chatwoot
origin, without redirects. Contact failures no
longer dump the complete HTTP error object into logs.

The direct SQL history resolver shares Chatwoot's binding, sorted
`provider-conversation:<account>:<inbox>:whatsapp:<peer>` PostgreSQL transaction
locks, ownership constraints and earliest-conversation rule. It fails on contradictory
native ContactInbox identities and ambiguous contacts. History timestamps and existing
statuses are preserved and no live callbacks/auto replies are introduced. Verified
LID normalization retains its original peer only while the opt-in is enabled; both
writers lock its aliases and stop when alias history needs independent reconciliation.
This release does not merge conversations, rewrite mappings, remove blobs or upgrade
Baileys. The controlled dependency/lockfile and sender-key layer remain unchanged.

Deploy Chatwoot first, then source with the opt-in off. Enable source capability reads
before independently reviewed account activation; rollout must include all live/history
writers before destructive cleanup. Rollback disables opt-ins and retains the binding
schema. Reapply in the Chatwoot service, identity normalization/import helper and provider
SQL resolver; check upstream new ingestion/creation paths. Focused checks: TypeScript,
changed-file ESLint, LID/cache/identity/history tests, actual PostgreSQL cross-runtime
worker through Chatwoot concurrency RSpec, exact-source synthetic lab and runtime readback.


The opt-in live contact resolver uses exact identifier/phone filters instead of
legacy Brazilian-number rewriting or contact merging. Duplicate, truncated or
contradictory PN/LID/group identities fail closed. Group participant creation must
return a positive contact ID and its exact native identifier before roster updates.
Existing confirmed contacts and avatars are reused. The legacy route remains
unchanged with the opt-in off. Focused regression includes phone fallback,
ambiguous filter results and unproven participant creation.

## Trusted provider requests and personal pins (2026-10-02)

Conversation detail GET requests now carry the existing native bridge credential
as well as the account API token when the configured destination is the trusted
Chatwoot origin. This lets the paired Chatwoot personal-pin feature retain shared
native pin state for provider reads and updates, without creating personal pin
preferences or changing a user's Unpin decision. Ordinary API credentials alone
do not authorize the native bridge context. No new secret, provider request,
conversation creation, media download or schema change is introduced.

Reapply around the existing Chatwoot getConversation request and trusted-origin
header helper; retain redirect rejection. Rollback is coordinated with Chatwoot
and keeps personal pins disabled until both runtimes are compatible. The existing
provider-conversation bindings remain enabled in the managed production runtime;
the deployment configuration must preserve that accepted setting and Telegram
session registry bytes. The controlled Baileys dependency is unchanged.

Focused verification: 13 actual-method tests, changed-source ESLint, the normal
commit hook's complete TypeScript check and independent paired source review.
Exact shared synthetic lab and immutable production readback remain release gates.

## Retained image edits with a JSON null payload (2026-10-02)

Cached history now classifies JSON null as unavailable content only for a retained
EDITED image. Reconciliation preserves the existing image only after proving one
destination with matching source identity, inbox and direction. It retains the
durable unavailable-edit result rather than claiming that an edit was applied.
Undefined, contradictory and encrypted payloads continue to stop recovery.

Reapply in the cached-history classifier and image-edit import helper. No schema,
provider send, media download, cache acknowledgement or job resume accompanies
this source change. The two recovery jobs remain paused while their current
source contains unsupported encrypted edits and their cached versions are stale.
Rollback preserves the consumer's existing unavailable-edit ledger.

Focused verification: 44 EVO tests, TypeScript and changed-file lint, plus real
PostgreSQL preservation of all image fields for a JSON null source. Independent
source review, exact candidate lab and immutable production readback remain gates.


### Exact provider contact precedence for history import

History now uses the exact account-scoped WhatsApp identifier before the unique PN phone fallback, matching live provider ingress. A same-phone Telegram contact remains intact, including its documents and message authors; contact merge, deletion and identifier rewrites are excluded. Duplicate exact identifiers, foreign provider identifiers, inconsistent PN phones and existing binding/contact-inbox conflicts still refuse. This does not itself authorize cross-contact consolidation or reparent conversations.

Validation: five whole-resolver cases on an owned Unix-only PostgreSQL17 fixture, including the old two-contact refusal, exact WA selection with both contacts/authors/documents unchanged, duplicate exact/foreign fallback refusals and normal missing-contact creation. Portable regression: `node tests/provider-history-contact-pg.cjs /tmp/historycontact246-OWNED/socket` (requires an exclusively owned synthetic schema and fixture user; refuses TCP/other socket paths). The ROOT release remains PR → owned lab → immutable main readback.

## Authenticated retained-history edits and explicit semantic gaps (2026-10-06)

Cached recovery authenticates encrypted MESSAGE_EDIT plaintext against a unique
same-instance original and exact inner target, author, peer and direction.
Ordering/current-source checks refuse newer or ambiguous native edits before a
write. The existing CW edit endpoint receives an optional locked content CAS;
no older recovery edit may overwrite a different current edited body. Original
native key, UTC, ciphertext and attachment/media remain intact; document-caption
deltas never replace attachments. NULL edited text can preserve an existing
nonempty matching target with an explicitly unresolved unavailable-body gap.
Known pins/polls remain unsupported UI semantics with durable original payload
and version in the coordinated history worker; unknown records still stop.
No dependency, provider send, live routing, permissions or implicit resume change.

Reapply around chatwoot-cached-history-record.ts, chatwoot-encrypted-history-edit.ts,
chatwoot-import-helper.ts and ChatwootService.syncStoredHistoryRecoveryBatch.
Rollback first pauses coordinated recovery; retained official gap rows survive.
Verification: `npx tsx --test tests/chatwoot-authenticated-history-edit.test.ts
 tests/chatwoot-unavailable-image-edit.test.ts tests/chatwoot-provider-edit.test.ts`,
`npx tsc --noEmit --incremental false`, normal ESLint on those four runtime files,
and exact synthetic shared-lab/immutable readback. The matching history schema4
and optional CW CAS must be accepted before activating recovery outcomes.

### Authenticated edit wrapper metadata

Retained encrypted MESSAGE_EDIT recovery accepts an optional authenticated
`messageContextInfo` containing only a canonical 32-byte `messageSecret`.
This wrapper metadata is validated and discarded: the recovered body keeps the
original message context, key, UTC and attachments. Extra message bodies, unknown
metadata, malformed lengths, invalid authentication, different targets, authors,
directions or unsafe ordering still refuse. No provider sends, dependencies,
live ingress behavior, source acknowledgements or automatic resume are changed.

Reapply in `chatwoot-encrypted-history-edit.ts`; rollback restores its strict
single-body refusal and leaves retained source/gap data intact. Focused checks:
`npx tsx --test tests/chatwoot-authenticated-history-edit.test.ts`,
`npx tsc --noEmit --incremental false`, normal ESLint on the helper, and an exact
candidate network-isolated synthetic lab before immutable production readback.


### Missing retained PDF document edit payload

Cached recovery explicitly preserves a NULL edited document only when the existing public destination is unique for its source/account/inbox/direction, authenticated peer and bound message/display IDs, with exactly one file attachment backed by nonempty PDF blob metadata. It emits the existing unresolved payload-unavailable outcome, keeps original content/context/media and never claims the edit or blob content was recovered. Unknown types, non-NULL malformed documents and ambiguous targets still stop the whole batch. No provider sends, routing change, dependency upgrade or migration.

Source: `chatwoot-cached-history-record.ts`, `chatwoot-import-helper.ts`, and `chatwoot.service.ts` under `src/api/integrations/chatbot/chatwoot/`. Reapply these focused branches after upstream changes to recovery classification/edit reconciliation; reverting restores safe refusal. Deploy the matching official cache document gap validator before acknowledging this new outcome. Focused regression: `node node_modules/tsx/dist/cli.mjs --test --test-name-pattern="NULL edited PDF" tests/chatwoot-authenticated-history-edit.test.ts`.

Native source-bound pointer IDs remain mandatory: absent or stale pointers refuse. A saved storage existence check alone never establishes native-pointer eligibility or recovered edit content.


### Typed album-container preservation (259)

Recovery recognizes only bounded incoming group image albums (1–13 declared JPEG images, no videos). Before any batch effect it validates the complete current same-instance association set, unique native keys, authoritative outer participant/direction and each existing scoped CW pointer/binding/media destination. Full native and destination snapshots are checked again before accounting. Nested sender-relative `fromMe` bits remain raw; no normalization policy, media availability or restored album UX is asserted. Unknown variants/missing/extra/conflicting dependencies refuse; no parent bubble/import/edit/media write or provider send occurs.

The official history schema5 adds only `recovery_album_gaps`; prior schema4 tables/data remain. A skipped preserve-only outcome stores the exact parent and dependency proof as an unresolved gap, atomically with version-CAS processed bookkeeping. New source versions invalidate ACK. Existing SQLite backup, jobs/leases/cache/other gaps are retained. Deploy new history schema5 before activating EFO album support, through exact PR→synthetic lab→main→immutable readback. Rollback must preserve the new table/gaps; older readers cannot claim schema5 compatibility. Do not replay ambiguous effects.

Source areas: EFO `chatwoot-history-album.ts`, `chatwoot-cached-history-record.ts`, `chatwoot.service.ts`; history `cache/album-preservation.ts`, `cache/sqlite-cache-store.ts`, `evolution/evolution-client.ts`. Focused checks: EFO `node --import tsx --test tests/chatwoot-album-preservation.test.ts` and `node node_modules/typescript/bin/tsc --noEmit`; history `node node_modules/vitest/vitest.mjs run test/album-preservation.test.ts` and `node node_modules/typescript/bin/tsc --noEmit`. Runtime lint: EFO normal ESLint on the three named runtime files. No dependency/provider upgrade.


### Explicit ignored provider edit preservation (260)

Owner-authorized recovery skips unavailable encrypted edits and preserves the latest known original when edit content/order conflicts. This never applies rejected identity metadata: the original native instance/key/peer/business direction and unique public current account/inbox destination with exact native pointers remain mandatory. Source/ordering snapshots and destination versions are recorded; missing/ambiguous targets, source drift, unknown failures and uncertain writes still stop. No message/media/provider send or reaction changes occur for an ignored edit.

The official cache schema6 adds only `recovery_ignored_edit_gaps`, atomically recording the raw source version and typed dependency proof with ordinary version-CAS bookkeeping. New source versions remain eligible for recheck. An ignored edit is not reported as applied or fully recovered. Deploy schema6 before the matching EFO outcome; rollback preserves gap tables and existing jobs/cache/state. Source areas: EFO `chatwoot-ignored-history-edit.ts`, import helper and recovery service; history `cache/ignored-edit-preservation.ts`, SQLite store and Evolution outcome validator. Checks include scoped preservation/identity/unknown-error tests, whole batch conflict/source drift regressions, durable gap/repeated batch/stale ACK/migration tests, TypeScript and exact synthetic candidate lab.


### Confirmed multipart callback source binding (260)

A successful conditional multipart callback retains part zero as the public message source. Later acknowledged parts can bind their native rows to that same message only when the locked outgoing message holds the complete exact acknowledged part set: every frozen part key, index, count and source must match, with the public source still equal to part zero. The callback supplies this proof only after its existing provider-delivery acknowledgement validator passes. Ordinary source matching, tenant/inbox/peer routing locks and claimed-conversation checks remain in force; absent, incomplete or conflicting receipts refuse before a native binding write. No enqueue, provider resend, message import, deletion or media/content update is added.

Reapply the optional acknowledged-parts argument in `chatwoot.service.ts` and `chatwoot-canonical-message-binding.ts`, using `chatwoot-delivery-status.ts` receipt validation. Rollback restores safe later-part refusal; keep sent operation state and callback evidence. Focused synthetic checks: `node node_modules/tsx/dist/cli.mjs --test tests/chatwoot-confirm-multipart-binding.test.ts tests/chatwoot-multipart-history.test.ts`; normal ESLint on the three runtime files and exact candidate lab before immutable activation.

## Provider source-key recovery index (2026-10-06)

- Publish a separately operated PostgreSQL 16 nonunique partial source-key index and runbook. Exact instance plus `key->>'id'` lookup retains every duplicate version and NULL mapping; it does not change any message, sender, recovery marker, source schema consumer or live routing policy.
- Source areas: `docs/operations/native-source-key-index.sql` and its runbook. The existing three edit-target statements and application files remain unchanged.
- Reapply the operator-only serial/autocommit, key-size/continuity and no-retry contract; never add this index to automatic startup migration. Invalid or unknown index outcomes require inspection, not automatic replacement.
- Validate on synthetic PostgreSQL 16.15: full-row conservation, OR/UNION equivalence, exact catalogue/conditioned plans and duplicate versions. Runtime identity and recovery eligibility remain independent.


### Cached-media recovery UTC timestamp verification (263)

The cached-media tagged preflight and import postimage queries compare PostgreSQL's persisted UTC epoch with the native message timestamp at whole-second precision. A `timestamp without time zone` returned by node-pg otherwise inherits the process timezone and can reject correct stored media in a non-UTC deployment. Both checks require a finite numeric epoch before flooring; a different native second still refuses. This changes read verification only: no global date parser, timezone configuration, stored timestamp, permissions, source identity, provider send or recovery acknowledgement is changed.

Reapply the two query projections and comparisons in `chatwoot.service.ts` when upstream changes cached-media verification. Keep native descriptor/digest/size, peer/inbox/direction/cardinality and authenticated physical storage proof guards. Rollback restores strict safe refusal without changing historical messages or cache data. Focused regression: `TZ=America/Sao_Paulo node node_modules/tsx/dist/cli.mjs --test --test-name-pattern="literal whole250|tagged document" tests/chatwoot-cached-media.test.ts`; the real pg timestamp parser, fractional seconds, wrong seconds/nonfinite epochs, tagged replay and import postimage are covered. Run normal runtime ESLint, the test-only parser override, TypeScript checks and an exact synthetic candidate lab before immutable readback.


### Retained reaction-removal control typing (263)

History recovery recognizes the native protobuf reaction-removal representations with absent or NULL reaction text as the existing `reaction_control` category. The native target key/id/peer shape and allowed wrapper keys still apply; numeric/object/boolean text, missing targets and contradictory message bodies refuse. This aligns retained controls with Baileys' nullable optional field and the existing live removal interpretation. It does not apply a reaction, import a message or prove recovery identity: the original whole-batch source/direction/version checks and durable known-control outcome remain required.

Reapply the bounded reaction text condition in `chatwoot-cached-history-record.ts`; rollback restores strict safe refusal and retains all source/cache outcomes. No provider sends, routing, schema, migrations or manual markers change. Focused regression: `node node_modules/tsx/dist/cli.mjs --test tests/chatwoot-retained-control-formats.test.ts`, runtime ESLint and the test-only parser override, TypeScript and exact synthetic candidate lab before immutable readback.


## Retained native history formats (2026-10-06)

- Recovery classifies native nullable reaction removals and exact protocol metadata controls without inventing visible content. Known sender-key, device and reply sidecars preserve pin/encrypted/album classification; album child and destination preservation proofs remain mandatory.
- Native hydrated templates retain title/body/footer and template metadata. The supported interactive CTA template retains its body/action data and verifies its header video through the same bounded owned cached-media path as associated video wrappers. Contacts retain the complete native vCard. All native rows and cache versions remain unchanged. Owned media is reused first. Only the supported native video wrappers/header may use one necessary descriptor-bound GET (fixed WhatsApp host, no redirect/reupload/retry, five-second abort, exact full SHA/length); every media byte is verified before writes. Unsupported/corrupt results stop the batch.
- A same-native declared text-type conflict records strict ignored-edit preservation of the current uniquely bound original. Unavailable retained audio edits prove the existing public audio attachment and all original pointers; neither case applies the unavailable/conflicting edit. The schema6 history consumer validates the matching proof/categories separately.
- Scope: cached history classification, import/display helpers and cached-media descriptors. No provider send, dependency, global parser, database migration or runtime capacity change. Reapply these guards with the matching history validator and current immutable source map.
- Focused validation covers nullable protobuf reactions, exact control shapes and malformed negatives, two edit preservation paths, native templates/wrappers and original whole250 silent media import/replay/postimage guards. Production source/image/readback, current receiver and full source/destination proofs remain separate.

The retained encrypted-edit preservation path accepts a native LID phone alias only when the native `remoteJidAlt` agrees with the current scoped WhatsApp conversation binding and its contact/inbox relation. The original native key, peer, and full native/destination version hashes remain intact; foreign or absent bindings refuse preservation.


### Missing native JPEG cache authority (264)

A current native plain `imageMessage` with JPEG MIME may use the existing necessary, bounded descriptor download when its unique same-instance `Media` relation is absent. Owned cached media remains the first choice; a corrupt or unavailable owned object does not trigger a provider fallback. The native key/direction and full plaintext SHA-256/length are mandatory, with the existing fixed HTTPS WhatsApp host, no redirects/reupload/retry, five-second abort, 8 MiB file and 16 MiB batch limits. All missing media is verified before any edit, source guard, import or processed outcome. Unknown kinds/MIME, malformed descriptors, incorrect bytes and uncertain results stop. No socket operation, provider send, read acknowledgement, cache mutation, dependency or schema change is added.

Reapply only `chatwoot-cached-media.ts` and its service callback; rollback restores missing-image refusal. Focused synthetic JPEG tests cover the missing-row path, native envelope retention, cache-first/no-fallback, corrupt SHA/length, host/kind/MIME refusal and the existing deadline. Exact candidate lab and immutable runtime readback remain required before recovery.


### Native media pointer and installed SDK transport (264)

Necessary retained-media reads select a validated canonical `https://mmg.whatsapp.net` URL from the current native `directPath` when present, before making a request. A malformed native path refuses; the stored native URL is used only when no direct path is present. This is one pointer selection, without retrying another pointer on HTTP or byte failure. The complete persisted native envelope, media key, plaintext SHA/length, cache-first policy and whole-batch preflight remain unchanged.

The installed Baileys downloader drops its supplied signal and redirect options. Its default recovery path therefore reads one bounded ciphertext through a scoped Undici agent with certificate validation, no redirects, a five-second abort and an encrypted-byte bound, then supplies those bytes through an isolated in-memory dispatcher to the original Baileys decryptor. No global fetch mutation, dependency update, socket reupload, send, read acknowledgement or cache write is added. Wrong bytes, unavailable pointers and uncertain reads stop before history writes. Reapply only this helper and its focused tests; rollback restores safe refusal. Verify actual installed-SDK decryption, HTTP/redirect/overflow/hash negatives, native envelope retention, real abort delivery, and existing JPEG/video/cache-first preflight tests in the exact synthetic candidate lab before immutable readback.


### Album container-only preservation with retained protocol companions (266)

A selected, authenticated image-only album may share its native key with an earlier context-only protocol row. Recovery retains the complete selected album and every same-key native row in a distinct version2 `container_only` proof, when all companions have the exact known empty-thread/canonical32-byte-secret context shape and matching instance, key, peer and direction. Supplied participant fields must match; absent fields remain absent in the raw proof. Another visible payload, later companion, missing selected version, excess cardinality or any native rotation refuses.

This disposition preserves the raw container as an unsupported versioned gap. Declared image counts do not assert that children were queried, present, imported or complete, and the proof carries no fabricated destination IDs. Ordinary children keep their existing independent import/source/version/media guards. The original version1 complete-child proof remains unchanged for a unique native parent, including all destination requirements. Reapply `chatwoot-history-album.ts` together with the matching History schema7 album-proof validator; existing gap rows and reasons remain intact without a migration. Focused tests cover exact protocol companions, visible/identity/ordering/malformed negatives, final native rotation and the existing version1 proof. Exact synthetic lab and immutable source/runtime readback precede recovery.


### Preserve unavailable retained Word document edits (266)

A NULL retained document edit may preserve its uniquely bound existing PDF or Word (`application/msword`) attachment. The existing single document attachment/file relation, positive durable blob/key, public direction, peer, complete native pointers and undeleted destination checks remain mandatory. Unknown MIME, ambiguous or absent destinations and malformed pointers refuse. This keeps the complete existing content and attachment intact, applies no edit, and uses the existing version-bound unavailable-payload disposition; ordinary missing media is never skipped. No History contract, schema, provider request or destination write is added. Reapply only the document preservation predicate together with its focused regression; exact synthetic lab and immutable source/runtime readback precede recovery.


### Missing native PDF cache authority (267)

A plain native `documentMessage` with exact `application/pdf` MIME may use the existing bounded necessary download only when its same-instance Media relation is absent. Its current native key, direction, media key, plaintext length/SHA and selected native version remain mandatory; recovery retains the full source envelope and caption. Owned media stays first, and an unavailable or corrupt owned object never falls back to a provider request.

The single validated native pointer is read through the existing five-second TLS/redirect/size bounded transport. Native encrypted SHA and Document MAC authenticate those same ciphertext bytes before the original Baileys Document decryptor; full plaintext length and SHA remain required before any history write. No alternate pointer, retry, socket, send, read acknowledgement, cache mutation, dependency or schema change is added. Other missing document MIME/kinds refuse. Reapply only the cached-media helper with the focused native-PDF/cache-first/whole250/default-SDK crypto/abort regression; exact synthetic candidate lab and immutable runtime readback remain separate requirements.

### Native unavailable NULL text originals

- Extend the existing versioned unavailable-original edit evidence to authenticated `EDITED` native `conversation` and `extendedTextMessage` records whose payload is NULL and whose native Chatwoot pointers are all NULL. A unique native owner, exact EDITED-update provenance, stable source/order hashes, and complete scoped destination absence remain required. Keep the image proof and existing destination preservation paths; ordinary, available, empty-object, unknown, ambiguous, or rotated records cannot enter this disposition.
- For a NULL text edit with an existing destination, accept a native LID phone alias only when the same immutable native `remoteJidAlt` agrees with the current scoped WhatsApp binding and contact, and the conversation contact-inbox matches. Preserve the full native representation and current nonempty public destination; no phone-only association or source rewrite is introduced.

### Typed retained keep-in-chat bookkeeping and recovery import diagnostics (269)

Retained native `keepInChatMessage` records use the installed protobuf keep/undo enum, exact complete target key, bounded native timestamp and existing strict device metadata shape. They are acknowledged through the existing `known_metadata_control` outcome without changing Chatwoot messages, attachments or the provider's saved keep state. Unknown enum values, malformed identity/timestamps and contradictory visible bodies remain unsupported.

Explicit recovery SQL imports now propagate only a fixed phase and bounded PostgreSQL code, constraint and routine identifiers when their existing catch rejects a batch. SQL, token values and customer text are excluded from the returned diagnostic. Buffered live-history behavior, SQL/locking limits and all native/source/version/ACK checks remain unchanged. The retained album classifier test now reflects the already deployed explicit container-only opaque metadata policy; album runtime code is unchanged.

### Remaining retained formats (269)

Recovery accepts authenticated zero-count album headers only through the explicit version-2 container-only audit, with full source and same-key row fingerprints and no child-completeness claim. NULL EDITED contact and album bodies use the existing versioned ignored-edit disposition; all current native source/update proofs remain mandatory and no destination preservation is asserted.

Known protocol history bundles/notices are metadata controls with exact typed descriptors and bounded retained sidecars; their payloads are neither downloaded nor written as customer messages. Hydrated/interactive JPEG templates retain their body and URL-button text plus native header image. Plain buttons retain body, footer and response labels without executing actions. Lottie sticker wrappers retain the original WAS file as a document attachment with a native-source fingerprint; the same bounded native download authenticates encrypted SHA and Image/Sticker MAC before SDK decryption and verifies native plaintext size/SHA. Existing source scope, identity, direction, version, cache-first authority, 32 MiB bounds and official ACK paths remain mandatory. Unknown contradictory outer payloads still refuse.

## Group recovery and native message lookup performance (2026-10-07)

The authenticated `POST /chat/requestGroupHistory/:instance` accepts a native
group JID, a bounded count (1–500), and optionally a native anchor message ID
belonging to that instance. Current native group membership is checked. Without
an anchor, it requests recent history before the current timestamp using the
optional protobuf cursor. Group ingestion must be enabled, and the existing Baileys
primary-device history request is used. No customer message is sent and no
local checkpoint or source payload is fabricated; returned primary history
uses the normal cache, idempotent importer and canonical conversation binding.
Request acknowledgement is not evidence that the primary returned history.

The additive concurrent PostgreSQL Message index matches Prisma's JSONB `#>`
source-key lookup and timestamp ordering, avoiding an instance-wide scan that
the existing text `->>` expression index cannot serve. Retain the old index.
Rollback can keep this additive index; the group request endpoint has no
automatic callers. Preserve these paths during upstream reapply.

## Participating WhatsApp group conversations (2026-10-07)

- Authenticated `chatwoot/syncGroups/:instance` defaults to dry-run and reads the existing socket's current participating groups. The current owner must match a native participant phone/LID; each group resolves only in the provider's verified bound inbox. Existing conversations/statuses are reused, and missing group contacts/conversations are created through the canonical resolver. No message, unread state, source identity, attachment or provider send is synthesized.
- Connection-open, group-upsert and participant events schedule coalesced background reconciliation. All service instances share a two-operation limit and per-instance serialization; live message handlers never await roster work. New live messages keep the existing peer resolver and deduplication.
- Keep these event hooks alongside the protected provider conversation contract when rebasing. Rollback removes automatic discovery/endpoint; already-created valid group conversations remain usable and cannot be deleted by rollback. Known group-ignore settings still explicitly disable ingestion.
- Validation: participating-groups synthetic tests include two inboxes for one group, reuse, owner/inbox conflicts, no customer-send path and bounded primary-history requests. Recovery remains a separate guarded operation after actual primary history is received.

Roster creation requires Chatwoot whatsapp_group_roster_contract_version=1.
Contact and canonical conversation requests carry the authenticated native
bridge plus history-import/inbox headers, suppressing live callbacks; roster
contact creation does not write labels. Deploy the Chatwoot capability before
EVO; unsupported runtimes refuse safely and leave live ingress unchanged.

## 2026-10-07 bounded roster lookup

Participating group discovery reuses one bounded account/inbox/native-peer SQL read for destination contacts and conversations when the existing import connection is available. Duplicate contacts/conversations or conflicting canonical bindings stop the operation. Native owner/membership and the registered silent capability remain required. Missing destinations still use the protected canonical API with fresh identity checks; no SQL writes, messages, read-state updates or provider sends. Without the import connection, retain the existing HTTP reader. Exact synthetic PostgreSQL checks cover cross-account/inbox isolation and duplicate identities.
