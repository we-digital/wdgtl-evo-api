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
// pg_column_size reads the stored size without detoasting; '{}' is 8 bytes.
const scope = `state = 'confirmed' AND "confirmedAt" IS NOT NULL AND "confirmedAt" < $1::timestamp AND pg_column_size(payload) > 16`;

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

  // Walk the primary key once; each batch is its own short transaction.
  // payloadHash, result and state stay.
  let done = 0;
  let last = '';
  let batches = 0;
  const started = Date.now();
  for (;;) {
    const ids = await c.query(
      `SELECT id FROM "ChatwootInboundDelivery" WHERE id > $1 ORDER BY id LIMIT $2`, [last, batch]);
    if (ids.rowCount === 0) break;
    last = ids.rows[ids.rowCount - 1].id;
    const r = await c.query(
      `UPDATE "ChatwootInboundDelivery" SET payload = '{}'::jsonb WHERE id = ANY($2::text[]) AND ${scope}`,
      [cutoff, ids.rows.map((x) => x.id)]);
    done += r.rowCount;
    if (++batches % 25 === 0) console.log(JSON.stringify({ cleared: done, batches, seconds: Math.round((Date.now() - started) / 1000) }));
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  console.log(JSON.stringify({ cleared: done, batches, seconds: Math.round((Date.now() - started) / 1000) }));

  // Throttle the manual VACUUM (default cost delay 0) on the shared cluster.
  await c.query(`SET statement_timeout = '60min'`);
  await c.query(`SET vacuum_cost_delay = '5ms'`);
  const t = Date.now();
  await c.query(`VACUUM (ANALYZE) "ChatwootInboundDelivery"`);
  const { rows: [after] } = await c.query(
    `SELECT pg_size_pretty(pg_total_relation_size('"ChatwootInboundDelivery"')) AS total`);
  console.log(JSON.stringify({ vacuumMs: Date.now() - t, tableTotalAfter: after.total }));
  await c.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
