# Inbound delivery payload retention

`ChatwootInboundDelivery` keeps the frozen provider payload of every inbound
message (`payload` jsonb). On 2026-11-16 the table was 7.6 GB for 256k rows,
7.2 GB of it TOAST. That makes it the biggest object in evolution_db and a main
cause of cache pressure on the shared cluster.

A payload is only needed while the row can still be delivered or recovered:

- the delivery worker leases `pending` / `history_pending` rows;
- recovery reads `RECOVERY_STATES` = `pending`, `history_pending`, `failed`;
- an `ignored` row is reopened by comparing `payloadHash`, not the payload;
- a `confirmed` row only returns its `result` (`chatwoot-inbound-queue.ts`), and a
  repeated enqueue upserts it with `update: {}`.

So the payload of a `confirmed` row is dead weight once it is confirmed. The
script clears it to `'{}'::jsonb`: the column is `NOT NULL`, so no schema change
is needed. `payloadHash`, `result`, `state` and the timestamps stay. Rows in
any other state are never touched.

## Scope

`state = 'confirmed'`, `confirmedAt` older than `RETENTION_DAYS` (default 7,
minimum 7), payload not already `{}`.

Dry-run on 2026-11-16 09:08 UTC with this script: **199,350 rows, 5.7 GB of
payload** (5,993,291,602 bytes of compressed column size) out of about 255k
confirmed rows. The table total was 7.7 GB. Other states (461
`already_present`, 448 `ignored`, 2 `history_pending`) are out of scope.

## Run

Dry-run, read-only:

```bash
ssh deploy-ci@<bbc-evo> 'docker exec -i -w /evolution evo-api node -' < docs/operations/inbound-payload-retention.js
```

Apply only after the owner confirms the scope. Pick a quiet hour and agree it with the deploy
coordinator. Add `-e RETENTION_APPLY=yes` to `docker exec`. It clears in
batches of 1000 with a 200 ms pause, then runs `VACUUM (ANALYZE)`.

Plain VACUUM makes the freed TOAST pages reusable, and hot reads stop touching
them. It does not shrink the files on disk: new payloads reuse the space, so the
table stops growing. Returning the ~6 GB to the cluster needs `VACUUM FULL`
(exclusive lock, blocks the delivery worker) or pg_repack. That is a separate
decision.

A recurring job (for example a daily run from the existing scheduler) can follow
once the one-shot run has been observed.
