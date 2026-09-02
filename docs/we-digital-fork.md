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
  versioned `content_attributes.we_digital_ingress` object with provider
  `evo_whatsapp` and scope `direct`, `group`, `broadcast`, or `unknown`. Text
  and multipart media paths use the same helper. Unknown identities fail
  closed; a LID is direct only when its alternate JID is a confirmed
  `@s.whatsapp.net` identity. Newly created Chatwoot API inboxes also receive
  provider/version markers in channel `additional_attributes`. When WhatsApp
  delivery fails, EVO updates that exact Chatwoot message to `failed` before
  writing the existing private diagnostic note; this preserves the original
  auto-reply intent/cooldown while exposing a correlatable failure outcome.
  Chatwoot auto replies must also carry a versioned delivery binding with the
  exact EVO instance and Chatwoot inbox. EVO rejects missing, stale, foreign,
  or mismatched bindings before calling Baileys and marks the exact Chatwoot
  message failed. Successful Chatwoot and public `sendText` calls persist a
  privacy-safe origin and request ID in the stored message `contextInfo`, so a
  server send is distinguishable from an unbound linked-device `fromMe`
  message after the fact.
- **Source areas:**
  `src/api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope.ts`,
  `chatwoot-auto-reply-binding.ts`, `outbound-provenance.ts`, and
  the message/inbox creation paths and correlated delivery-failure update in
  `chatwoot.service.ts`.
- **Flags/schema:** no EVO feature flag or database schema change. Ingress,
  delivery binding, and outbound provenance are additive metadata; Chatwoot
  owns its separately gated automatic-reply behavior.
- **Upstream reapply/conflicts:** preserve the helper call on both JSON text
  and multipart media forwarding paths when upstream changes Chatwoot payload
  construction. Never infer direct scope from contact names or Chatwoot
  conversation shape.
- **Rollback:** deploying the prior immutable EVO image removes the additive
  marker. Chatwoot then classifies new messages as unclassified and must not
  auto-reply, while ordinary message delivery remains available.
- **Focused regression:** run `npm run test:unit --
  tests/chatwoot-ingress-scope.test.ts tests/chatwoot-auto-reply-binding.test.ts
  tests/outbound-provenance.test.ts`, `npm run lint:check`, and `npm run build`;
  staging canary must prove direct/text, direct/media, group, broadcast,
  unknown, wrong-instance auto-reply rejection, stored provenance, and a
  failed provider delivery before production promotion.

## Upstream maintenance

Keep upstream Git history and reapply the fork as ordinary reviewable commits.
After every reviewed upstream merge, compare `.github/workflows`, run the local
policy checker, and preserve only the explicitly reviewed packaging workflow.
Do not revive upstream Docker Hub publishers, CodeQL, dependency review, or PR
quality jobs as part of conflict resolution.
