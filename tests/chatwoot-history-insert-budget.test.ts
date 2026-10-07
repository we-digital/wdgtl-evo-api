import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';

function messages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `native-${index}`,
    instanceId: 'synthetic-instance',
    key: { id: `source-${index}`, remoteJid: '120363123456@g.us', fromMe: index % 2 === 0 },
    messageType: 'conversation',
    message: { conversation: `synthetic text ${index}` },
    messageTimestamp: 1700000000 + index,
  })) as any[];
}

async function withImportFixture(pool: any, run: (source: any[]) => Promise<void>) {
  const importer = chatwootImport as any;
  const names = [
    'getChatwootUser',
    'getExistingSourceIds',
    'getImportableHistoryMessages',
    'selectOrCreateFksFromChatwoot',
  ];
  const originals = new Map(names.map((name) => [name, importer[name]]));
  const connection = postgresClient.getChatwootConnection;
  const source = messages(121);
  importer.getChatwootUser = async () => ({ user_type: 'User', user_id: 8 });
  importer.getExistingSourceIds = async () => new Set();
  importer.getImportableHistoryMessages = () => new Map(source.map((row) => [row, row.message.conversation]));
  importer.selectOrCreateFksFromChatwoot = async () =>
    new Map([['120363123456@g.us', { conversation_id: '501', contact_id: '601' }]]);
  postgresClient.getChatwootConnection = () => pool;
  try {
    await run(source);
  } finally {
    postgresClient.getChatwootConnection = connection;
    for (const [name, original] of originals) importer[name] = original;
  }
}

async function importSource(source: any[]) {
  return chatwootImport.importHistoryMessages(
    { instanceName: 'synthetic-instance' } as any,
    {} as any,
    { id: 42 } as any,
    { accountId: '1' } as any,
    { messages: source },
  );
}

test('121 messages use bounded statements under one locked transaction and retain the five-second deadline', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let released = false;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.startsWith('INSERT INTO messages')) return { rowCount: (params.length - 2) / 8 };
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  await withImportFixture({ connect: async () => client }, async (source) => {
    assert.equal(await importSource(source), 121);
  });
  const inserts = calls.filter((call) => call.sql.startsWith('INSERT INTO messages'));
  assert.deepEqual(
    inserts.map((call) => (call.params.length - 2) / 8),
    [50, 50, 21],
  );
  assert.equal(calls.filter((call) => call.sql.startsWith('BEGIN')).length, 1);
  assert.equal(calls.filter((call) => call.sql === 'COMMIT').length, 1);
  assert.equal(calls.filter((call) => call.sql === 'ROLLBACK').length, 0);
  assert.equal(calls.find((call) => call.sql.startsWith('SET LOCAL')).sql.includes("statement_timeout='5s'"), true);
  assert.equal(
    calls.find((call) => call.sql.includes('pg_advisory_xact_lock')).params[0],
    'provider-history-import:1:42',
  );
  assert.equal(calls[calls.length - 1].sql, 'COMMIT');
  assert.equal(released, true);
  const sources = inserts.flatMap((call) =>
    call.params.filter((value) => typeof value === 'string' && value.startsWith('WAID:')),
  );
  assert.equal(new Set(sources).size, 121);
});

test('a later cancelled statement rolls back the complete source batch and reports no committed import', async () => {
  const sqlCalls: string[] = [];
  let inserts = 0;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      sqlCalls.push(sql);
      if (sql.startsWith('INSERT INTO messages')) {
        if (++inserts === 3)
          throw Object.assign(new Error('statement timeout'), { code: '57014', routine: 'ProcessInterrupts' });
        return { rowCount: (params.length - 2) / 8 };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  await withImportFixture({ connect: async () => client }, async (source) => {
    await assert.rejects(importSource(source), /phase=message_insert code=57014/);
  });
  assert.equal(sqlCalls.filter((sql) => sql === 'COMMIT').length, 0);
  assert.equal(sqlCalls.filter((sql) => sql === 'ROLLBACK').length, 1);
});

test(
  'isolated PostgreSQL executes bounded SQL exactly once and rolls back earlier chunks on a later insert error',
  {
    skip: !process.env.BBC_RECOVERY_SYNTHETIC_PG_SOCKET,
  },
  async () => {
    const pool = new pg.Pool({
      host: process.env.BBC_RECOVERY_SYNTHETIC_PG_SOCKET,
      port: Number(process.env.BBC_RECOVERY_SYNTHETIC_PG_PORT || 55470),
      database: process.env.BBC_RECOVERY_SYNTHETIC_PG_DATABASE || 'postgres',
      max: 1,
    });
    const client = await pool.connect();
    await client.query(`CREATE TEMP TABLE messages (
    id bigserial PRIMARY KEY, content text, processed_message_content text,
    account_id bigint, inbox_id bigint, conversation_id bigint, message_type integer,
    private boolean, content_type integer, sender_type text, sender_id bigint,
    source_id text, created_at timestamptz, updated_at timestamptz, content_attributes jsonb,
    UNIQUE(inbox_id,source_id))`);
    client.release();
    const wrappedPool = {
      connect: async () => {
        const active = await pool.connect();
        return {
          query: async (sql: string, params?: unknown[]) =>
            sql.includes('SELECT to_regclass') ? { rows: [] } : active.query(sql, params),
          release: () => active.release(),
        };
      },
    };
    try {
      await withImportFixture(wrappedPool, async (source) => {
        assert.equal(await importSource(source), 121);
        const rows = await pool.query('SELECT * FROM pg_temp.messages ORDER BY created_at');
        assert.equal(rows.rowCount, 121);
        for (const [index, row] of rows.rows.entries()) {
          assert.equal(row.source_id, `WAID:source-${index}`);
          assert.equal(row.message_type, index % 2 === 0 ? 1 : 0);
          assert.equal(row.sender_type, index % 2 === 0 ? 'User' : 'Contact');
          assert.equal(row.content, `synthetic text ${index}`);
          assert.equal(row.account_id, '1');
          assert.equal(row.inbox_id, '42');
        }
        assert.equal(await importSource(source), 0);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pg_temp.messages')).rows[0].n, 121);
        await pool.query('TRUNCATE pg_temp.messages');
        await pool.query(`ALTER TABLE pg_temp.messages ADD CONSTRAINT synthetic_last_chunk_fail
        CHECK (source_id <> 'WAID:source-115')`);
        await assert.rejects(importSource(source), /phase=message_insert code=23514/);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pg_temp.messages')).rows[0].n, 0);
      });
    } finally {
      await pool.end();
    }
  },
);
