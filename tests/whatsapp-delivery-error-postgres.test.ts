import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

test(
  'exact additive PostgreSQL migration preserves legacy rows and Prisma persists native NACK codes',
  {
    skip: process.env.WHATSAPP_DELIVERY_ERROR_POSTGRES_TEST !== '1',
  },
  async () => {
    const uri = new URL(process.env.DATABASE_CONNECTION_URI!);
    assert.equal(uri.hostname, 'postgres');
    assert.equal(uri.pathname, '/evolution_dev');
    const schema = `task067_${randomUUID().replaceAll('-', '')}`;
    const raw = new Client({ connectionString: uri.toString() });
    uri.searchParams.set('schema', schema);
    const db = new PrismaClient({ datasources: { db: { url: uri.toString() } } });
    await raw.connect();
    try {
      await raw.query(`CREATE SCHEMA "${schema}"`);
      await raw.query(`SET search_path TO "${schema}", public`);
      await raw.query('CREATE TABLE "MessageUpdate" (LIKE public."MessageUpdate" INCLUDING ALL)');
      await raw.query('ALTER TABLE "MessageUpdate" DROP COLUMN IF EXISTS "providerErrorCode"');
      await raw.query(`INSERT INTO "MessageUpdate" ("id","keyId","remoteJid","fromMe","status","messageId","instanceId")
      VALUES ('old','OLD','synthetic@g.us',true,'SERVER_ACK','synthetic-message','synthetic-instance')`);
      const migration = fs.readFileSync(
        'prisma/postgresql-migrations/20261019060000_message_update_provider_error_code/migration.sql',
        'utf8',
      );
      await raw.query(migration);
      const legacy = await db.messageUpdate.findUniqueOrThrow({ where: { id: 'old' } });
      assert.equal(legacy.providerErrorCode, null);
      assert.equal(legacy.status, 'SERVER_ACK');
      const row = await db.messageUpdate.create({
        data: {
          keyId: 'NEW',
          remoteJid: 'synthetic@g.us',
          fromMe: true,
          status: 'ERROR',
          providerErrorCode: '479',
          messageId: 'synthetic-message',
          instanceId: 'synthetic-instance',
        },
      });
      assert.equal((await db.messageUpdate.findUniqueOrThrow({ where: { id: row.id } })).providerErrorCode, '479');
      // Old application writes don't know the new nullable field and remain valid.
      await raw.query('UPDATE "MessageUpdate" SET "status"=$1 WHERE id=$2', ['SERVER_ACK', row.id]);
      assert.equal((await db.messageUpdate.findUniqueOrThrow({ where: { id: row.id } })).providerErrorCode, '479');
      assert.equal(await db.messageUpdate.count(), 2);
    } finally {
      await db.$disconnect();
      await raw.query('ROLLBACK');
      await raw.query('SET search_path TO public');
      await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await raw.end();
    }
  },
);
