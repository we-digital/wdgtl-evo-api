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
  message after the fact.
- **Source areas:**
  `src/api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope.ts`,
  `chatwoot-auto-reply-binding.ts`, `outbound-provenance.ts`, and
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
  auto-reply, while ordinary message delivery remains available.
- **Focused regression:** run `npm run test:unit --
  tests/chatwoot-ingress-scope.test.ts tests/chatwoot-auto-reply-binding.test.ts
  tests/outbound-provenance.test.ts`, `npm run lint:check`, and `npm run build`;
  staging canary must prove direct/text, direct/media, group, broadcast,
  unknown, wrong-instance auto-reply rejection, stored provenance, a failed
  provider delivery, missing route, cross-instance/inbox replay,
  receiver-fingerprint mismatch, and explicit relink before production
  promotion.

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
- **Source areas:** `chatwoot-outbound-queue.ts`,
  `chatwoot-outbound-prisma-store.ts`, `chatwoot.service.ts`, the Chatwoot
  router/controller startup wiring, `chatwoot-transport-options.ts`, Baileys'
  existing message-ID option and `media-message-metadata.ts`,
  provider Prisma schemas/migrations, and
  `docs/operations/chatwoot-outbound-delivery.md`.
- **Flags/schema:** `CHATWOOT_OUTBOUND_ASYNC_ENABLED` and
  `CHATWOOT_OUTBOUND_ASYNC_DRAIN_ONLY` default to false. The
  additive `ChatwootOutboundOperation` table and claim-generation fence are present in PostgreSQL,
  PgBouncer and MySQL schemas; migrations exist for PostgreSQL and MySQL.
- **Upstream reapply/conflicts:** preserve the database transition immediately
  before the first Baileys transport call, the deterministic message ID on
  text/audio/media, persisted authenticated admission during socket outages,
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
  tests/outbound-provenance.test.ts tests/chatwoot-history-sync.test.ts`,
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
