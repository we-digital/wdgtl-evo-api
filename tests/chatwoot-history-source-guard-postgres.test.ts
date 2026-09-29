import assert from 'node:assert/strict';
import test from 'node:test';

import { activateChatwootHistorySourceGuards } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-source-guard';
import { Pool } from 'pg';

const databaseUrl = process.env.CHATWOOT_HISTORY_GUARD_TEST_DATABASE_URL;

test(
  'enforces guarded history source uniqueness for both arrival orders, updates, and an in-flight writer',
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const reset = async () => {
      await pool.query('DROP TABLE IF EXISTS evolution_history_source_guards CASCADE');
      await pool.query('DROP TABLE IF EXISTS messages CASCADE');
      await pool.query(`
        CREATE TABLE messages (
          id BIGSERIAL PRIMARY KEY,
          inbox_id BIGINT NOT NULL,
          source_id TEXT
        )`);
    };
    const count = async (sourceId: string) => {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM messages
          WHERE inbox_id = 110
            AND source_id = ANY($1::text[])`,
        [[sourceId, sourceId.slice(5)]],
      );
      return Number(result.rows[0].count);
    };
    const expectDuplicate = async (operation: Promise<unknown>) => {
      await assert.rejects(operation, (error: { code?: string; constraint?: string }) => {
        assert.equal(error.code, '23505');
        assert.equal(error.constraint, 'evolution_history_source_guard_unique');
        return true;
      });
    };

    try {
      await reset();
      await activateChatwootHistorySourceGuards(pool, 110, ['history-first']);
      await pool.query("INSERT INTO messages (inbox_id, source_id) VALUES (110, 'WAID:history-first')");
      await expectDuplicate(
        pool.query("INSERT INTO messages (inbox_id, source_id) VALUES (110, 'history-first')"),
      );
      assert.equal(await count('WAID:history-first'), 1);

      await reset();
      await activateChatwootHistorySourceGuards(pool, 110, ['live-first']);
      await pool.query("INSERT INTO messages (inbox_id, source_id) VALUES (110, 'live-first')");
      await expectDuplicate(
        pool.query("INSERT INTO messages (inbox_id, source_id) VALUES (110, 'WAID:live-first')"),
      );
      assert.equal(await count('WAID:live-first'), 1);

      await reset();
      await activateChatwootHistorySourceGuards(pool, 110, ['source-update']);
      await pool.query("INSERT INTO messages (inbox_id, source_id) VALUES (110, 'WAID:source-update')");
      const unbound = await pool.query(
        "INSERT INTO messages (inbox_id, source_id) VALUES (110, NULL) RETURNING id",
      );
      await expectDuplicate(
        pool.query("UPDATE messages SET source_id = 'source-update' WHERE id = $1", [unbound.rows[0].id]),
      );
      assert.equal(await count('WAID:source-update'), 1);

      await reset();
      let releaseActivation!: () => void;
      let reportLock!: () => void;
      const activationMayContinue = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      const activationLocked = new Promise<void>((resolve) => {
        reportLock = resolve;
      });
      const wrappedPool = {
        connect: async () => {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query: async (sql: string, params?: unknown[]) => {
              const result = await client.query(sql, params);
              if (sql === 'LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE') {
                reportLock();
                await activationMayContinue;
              }
              return result;
            },
          };
        },
      } as unknown as Pool;
      const activation = activateChatwootHistorySourceGuards(wrappedPool, 110, ['in-flight']);
      await activationLocked;
      const liveInsert = pool.query(
        "INSERT INTO messages (inbox_id, source_id) VALUES (110, 'in-flight')",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseActivation();
      await activation;
      await liveInsert;
      await expectDuplicate(
        pool.query("INSERT INTO messages (inbox_id, source_id) VALUES (110, 'WAID:in-flight')"),
      );
      assert.equal(await count('WAID:in-flight'), 1);
    } finally {
      await pool.end();
    }
  },
);
