import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { createHistoryDatabaseScope } from '../src/api/integrations/chatbot/chatwoot/utils/history-database-scope';
import {
  historySourceFingerprint,
  withLockedHistoryDependencies,
} from '../src/api/integrations/chatbot/chatwoot/utils/history-memory-budget';

for (const waitAt of ['lookup', 'destination'])
  for (const mutation of ['update', 'delete'])
    test(
      `real soft deadline during ${waitAt} retains donor locks until destination rollback (${mutation})`,
      { skip: process.env.HISTORY_MEMORY_POSTGRES_TEST !== '1' },
      async () => {
        const uri = process.env.DATABASE_CONNECTION_URI!;
        assert.equal(new URL(uri).hostname, 'postgres');
        const prisma = new PrismaClient();
        const pool = new Pool({ connectionString: uri, max: 1 });
        const marker = 'task050-expiry-' + randomUUID();
        const instance = await prisma.instance.create({
          data: { name: marker, connectionStatus: 'close', integration: 'SYNTHETIC_DISABLED' },
        });
        try {
          const source = await prisma.message.create({
            data: {
              instanceId: instance.id,
              key: { id: marker, remoteJid: '628100000001@s.whatsapp.net', fromMe: false },
              messageTimestamp: 1700000000,
              pushName: 'original donor',
              messageType: 'conversation',
              source: 'web',
              message: { conversation: 'synthetic only' },
            },
          });
          await pool.query('CREATE TEMP TABLE task050_guard_destination(name text)');
          const settings = async () =>
            (
              await pool.query(
                "SELECT current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle",
              )
            ).rows[0];
          const before = await settings();
          let donorStayedLocked = false;
          await assert.rejects(
            withLockedHistoryDependencies(
              uri,
              marker,
              [source.id],
              async (rows) => {
                assert.equal(historySourceFingerprint(rows[0]), historySourceFingerprint(source));
              },
              async (signal) => {
                const scope = createHistoryDatabaseScope(pool, signal);
                try {
                  const client = waitAt === 'destination' ? await scope.database.connect() : null;
                  if (client) {
                    await client.query('BEGIN');
                    await client.query('INSERT INTO task050_guard_destination(name) VALUES ($1)', [source.pushName]);
                  }
                  const pending = client ? client.query('SELECT pg_sleep(0.40)') : delay(400);
                  await delay(180); // cross the configured100ms deadline, without releasing native locks
                  assert.equal(signal.aborted, true);
                  await assert.rejects(
                    prisma.$transaction(async (tx) => {
                      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='80ms'");
                      if (mutation === 'update')
                        await tx.message.update({ where: { id: source.id }, data: { pushName: 'rotated donor' } });
                      else await tx.message.delete({ where: { id: source.id } });
                    }),
                    /lock timeout|canceling statement|55P03/,
                  );
                  donorStayedLocked = true;
                  await pending;
                  if (client) {
                    try {
                      await client.query('COMMIT');
                    } finally {
                      await client.query('ROLLBACK');
                      client.release();
                    }
                  } else
                    await scope.database.query('INSERT INTO task050_guard_destination(name) VALUES ($1)', [
                      source.pushName,
                    ]);
                  return 1;
                } finally {
                  await scope.close();
                }
              },
              { deadlineMs: 100 },
            ),
            /deadline|aborted/,
          );
          assert.equal(donorStayedLocked, true);
          assert.equal(Number((await pool.query('SELECT count(*) FROM task050_guard_destination')).rows[0].count), 0);
          assert.deepEqual(await settings(), before, 'Shared pool settings must be restored');
          await prisma.message.update({ where: { id: source.id }, data: { pushName: 'after guard settled' } });
          assert.equal(
            (await prisma.message.findUnique({ where: { id: source.id } }))?.pushName,
            'after guard settled',
          );
        } finally {
          await prisma.instance.delete({ where: { id: instance.id } });
          await pool.end();
          await prisma.$disconnect();
        }
      },
    );
