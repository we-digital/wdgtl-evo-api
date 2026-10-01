# we:Digital Evolution API fork

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
