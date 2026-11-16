// Clear frozen payloads on confirmed ChatwootInboundDelivery rows older than
// RETENTION_DAYS. See inbound-payload-retention.md. Run on the EVO host:
//   docker exec -i -w /evolution evo-api node - < inbound-payload-retention.js
// Dry-run by default (read-only counts). Apply only with
//   docker exec -i -e RETENTION_APPLY=yes -w /evolution evo-api node - < …
// Prints counts and sizes only, never row contents.
const { Client } = require('pg');

const days = Number(process.env.RETENTION_DAYS || 7);
const batch = Number(process.env.RETENTION_BATCH || 1000);
const pauseMs = Number(process.env.RETENTION_PAUSE_MS || 200);
const apply = process.env.RETENTION_APPLY === 'yes';
if (!Number.isInteger(days) || days < 7) throw new Error('RETENTION_DAYS must be an integer >= 7');

// confirmedAt is timestamp without time zone in UTC. Keep the cutoff as text:
// a JS Date round-trip shifts it by the container's TZ (evo-api runs -03).
const scope = `state = 'confirmed' AND "confirmedAt" IS NOT NULL AND "confirmedAt" < $1::timestamp AND payload <> '{}'::jsonb`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_CONNECTION_URI, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query(`SET application_name = 'bbc-inbound-payload-retention'`);
  await c.query(`SET statement_timeout = '120s'`);
  await c.query(`SET lock_timeout = '2s'`);
  const { rows: [{ cutoff }] } = await c.query(
    `SELECT ((now() AT TIME ZONE 'utc') - make_interval(days => $1))::text AS cutoff`, [days]);

  const { rows: [plan] } = await c.query(
    `SELECT count(*)::int AS rows, coalesce(sum(pg_column_size(payload)), 0)::bigint AS bytes,
            pg_size_pretty(coalesce(sum(pg_column_size(payload)), 0)::bigint) AS size
       FROM "ChatwootInboundDelivery" WHERE ${scope}`, [cutoff]);
  const { rows: [table] } = await c.query(
    `SELECT pg_size_pretty(pg_total_relation_size('"ChatwootInboundDelivery"')) AS total`);
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', days, cutoff, ...plan, tableTotal: table.total }));
  if (!apply) return c.end();

  // Batches keep each transaction short; payloadHash, result and state stay.
  let done = 0;
  for (;;) {
    const r = await c.query(
      `UPDATE "ChatwootInboundDelivery" SET payload = '{}'::jsonb
        WHERE id IN (SELECT id FROM "ChatwootInboundDelivery" WHERE ${scope} LIMIT $2)`,
      [cutoff, batch]);
    done += r.rowCount;
    if (r.rowCount === 0) break;
    if (done % (batch * 20) === 0) console.log(JSON.stringify({ cleared: done }));
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  console.log(JSON.stringify({ cleared: done }));

  await c.query(`SET statement_timeout = '30min'`);
  const t = Date.now();
  await c.query(`VACUUM (ANALYZE) "ChatwootInboundDelivery"`);
  const { rows: [after] } = await c.query(
    `SELECT pg_size_pretty(pg_total_relation_size('"ChatwootInboundDelivery"')) AS total`);
  console.log(JSON.stringify({ vacuumMs: Date.now() - t, tableTotalAfter: after.total }));
  await c.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
