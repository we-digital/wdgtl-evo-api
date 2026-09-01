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
  and displays `Evo : BBC` as the browser page title.
- **Source areas:** `manager/dist/index.html` and the bundled Manager assets
  under `manager/dist/`.
- **Flags/schema:** no application flag, API contract, or database schema
  change.
- **Upstream reapply/conflicts:** an upstream Manager rebuild can replace the
  committed `dist` output. Reapply the exact page title after every Manager
  upgrade and confirm that no bundled script overrides `document.title`.
- **Rollback:** restore the upstream `<title>` value; the Manager runtime and
  API are otherwise unchanged.
- **Focused regression:** assert exactly one `<title>Evo : BBC</title>` in the
  built Manager, package the immutable image, deploy to staging, and verify the
  browser title on both login and authenticated Manager routes.

## Upstream maintenance

Keep upstream Git history and reapply the fork as ordinary reviewable commits.
After every reviewed upstream merge, compare `.github/workflows`, run the local
policy checker, and preserve only the explicitly reviewed packaging workflow.
Do not revive upstream Docker Hub publishers, CodeQL, dependency review, or PR
quality jobs as part of conflict resolution.
