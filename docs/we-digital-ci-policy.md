# we:Digital GitHub Actions policy

GitHub Actions in this fork is only trusted packaging and deployment
transport. Code quality remains an agent responsibility and is verified
locally before a source change is pushed.

## Allowed automation

Exactly one workflow may exist: `.github/workflows/build-and-deploy.yaml`.
It may run only for pushes to `main` and `staging`, or by explicit manual
dispatch. It may build or safely reuse an immutable GHCR image and dispatch its
exact branch, 40-character source SHA, tag, and digest to
`we-digital/bbc-devops`.

The workflow must not run for pull requests, schedules, tags, documentation,
policy, test-only, or workflow-only changes. It must not contain lint, tests,
security scans, dependency review, maintenance, issue automation, or upstream
image publication.

Deployment-side source validation, fixed destination checks, bootstrap,
isolation, and runtime smoke checks remain mandatory in bbc-devops.

## Local quality contract

Before push, the responsible agent identifies the changed runtime areas and
runs their focused tests, lint/type checks, migration/schema checks, and local
image build when relevant. Fork-specific changes update
`docs/we-digital-fork.md` in the same commit. Stage runtime verification is
required before production promotion.

## Upstream update guard

After merging a reviewed upstream commit and before push:

```sh
git diff --name-status <reviewed-upstream-commit>...HEAD -- .github/workflows
bash .github/check-we-digital-actions-policy.sh
git diff --check
```

Remove every unexpected upstream workflow. Do not expand the allowlist by
default. A reviewed change to the allowed workflow requires an intentional
refresh of its Git blob hash in `.github/we-digital-actions-allowlist.txt` and
an update to this policy and the fork ledger in the same commit.

The local checker is deliberately not a GitHub Actions job: an upstream merge
cannot activate extra automation merely by adding a workflow file.

## Exact runtime reuse and cache

The workflow computes `BUILD_INPUT_SHA` from the Dockerfile, lockfiles, exact
directories copied into the production image, and the reviewed packaging
workflow. A successful build publishes both the immutable branch-plus-commit
tag and a policy-versioned `runtime-v1-<BUILD_INPUT_SHA>` lookup tag.

On a later commit with identical production inputs, the workflow validates the
lookup image's repository, policy label, input hash, digest, and `linux/amd64`
manifest, then creates the new immutable commit tag without running Docker
build. The OCI revision remains the SHA that originally built those identical
runtime bytes; the downstream deployment contract separately carries and
validates the current branch and source SHA.

Any missing or ambiguous lookup falls back to a full build. An existing
commit-specific tag that fails provenance validation is a hard failure and is
never overwritten. Versioned registry caches are written per branch and read
from both `main` and `staging`; cache tags are never deployment inputs.
