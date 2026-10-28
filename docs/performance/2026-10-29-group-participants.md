# EVO: request-local group participant lookup

Baseline: `33494d5ca661a775751568f60909fdc1dae33273`.
Scope: one native `findParticipants` method, 12 added / 3 removed runtime lines.

The old enrichment scans Contact rows for every participant; the candidate
indexes JIDs once and checks at most three known aliases per participant. The
minimum returned-row index preserves the old first-match behavior. The same
instance-scoped native Prisma query now selects only its three consumed fields.
No schema/index, dependency, cross-request cache, provider send, transport retry,
session or Signal recovery change. The response and cache-write input are equal.

## Host synthetic evidence

`tests/group-participant-lookup.test.ts` extracts and executes the actual service
method. The baseline is the unchanged file from the named commit. All metadata,
database and cache calls are synthetic. Eleven alternating-order samples each:

- 1 participant / 2 contacts: median CPU 0.015 → 0.011ms; no material small-case claim.
- 32 participants / 64 contacts: median CPU 0.032 → 0.028ms; no material small-case claim.
- 1,024 participants / 2,048 contacts: median CPU **11.839 → 0.413ms** (~28.7x).
  Baseline samples: 17.995/11.561/14.500/12.401/12.169/11.711/11.698/10.899/11.839/11.569/19.718ms.
  Candidate: 0.631/0.568/0.435/0.389/0.413/0.380/0.441/0.379/0.386/0.342/0.617ms.
- Large-roster Contact JID property reads: **1,048,576 → 4,096** (256x fewer).
- Synthetic full vs selected Contact JSON: 421 → 154 bytes (small),
  13,529 → 4,941 bytes (32), 437,929 → 160,597 bytes (large).
  These are serialized synthetic row objects, not measured database wire bytes.

Every complete response matches the baseline, including 20 additional
adversarial alias/contact-order cases. Tests also independently assert the
instance filter, selected columns, null/empty field precedence, absent aliases,
provider fields/order and unchanged PN cache writes. No customer data is used.
The timed path excludes database/mock filtering; it measures the literal method's
CPU plus identical synthetic metadata/cache overhead, not network, real Prisma,
HTTP endpoint latency, production throughput or p95. The new map uses O(contacts)
temporary memory; it is discarded after the request.

## Reproduce and release boundary

Default focused command: `npx tsx --test tests/group-participant-lookup.test.ts`.
For comparison, export the exact baseline source with `git show` into the active
task's private SSD scratch directory; set `EVO_GROUP_LOOKUP_BASELINE_SOURCE` to
that file and run the same test. The opt-in third test prints all samples.
No test database or provider credentials are required.

Host tests and evidence alone are not release acceptance. Main must run the
exact current-main merge candidate's focused tests/build in the shared lab,
qualify native Prisma selection there, then perform the PR/main immutable image
release and independent readback. No real-provider send is needed for this read
change. Reapply the small indexed lookup/projection on upstream updates only
while the old repeated scan remains; preserve first-row alias behavior. Revert
the method or restore the previous immutable application image to roll back;
there is no migration or retained state to undo.

## Shared-lab follow-up

The exact runtime candidate was also executed in the shared lab's isolated EVO
one-off container: 42 focused checks passed, 5 unrelated opt-in database cases
were skipped. The comparison benchmark was enabled and all outputs remained
equal. A separate real native Prisma/PostgreSQL transaction created two synthetic
instances with a colliding peer, ran the actual method against the transaction
client, verified only the three selected columns and correct instance name, then
rolled back and independently verified no fixture instances remained. No EVO
server, sessions, provider worker or external send was started.

Linux TypeScript checking and production-entrypoint bundling passed. The first
build attempt hit V8's approximately 380MiB heap under the default 768MiB test
container limit; the same candidate passed in a task-only 2GiB container with a
1.5GiB heap. No shared or production service resource settings changed. Bundle
output was redirected to task scratch; translation-copy packaging and real
WhatsApp transport are outside this focused build. Immutable production packaging
and runtime readback remain separate release gates.
