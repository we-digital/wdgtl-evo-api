import assert from 'node:assert/strict';
import test from 'node:test';

import postgresql from 'pg';

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';

// Runs the history contact import against a real Postgres (EVO_TEST_PG_URL), with
// the slice of the Chatwoot schema the import touches.
const url = process.env.EVO_TEST_PG_URL;

async function schema(pool: postgresql.Pool) {
  await pool.query(`
    DROP TABLE IF EXISTS taggings, tags, labels, contacts;
    CREATE TABLE contacts (
      id bigserial PRIMARY KEY, name text, phone_number text, account_id integer NOT NULL,
      identifier text, created_at timestamp NOT NULL, updated_at timestamp NOT NULL);
    CREATE UNIQUE INDEX uniq_identifier_per_account_contact ON contacts (identifier, account_id);
    CREATE TABLE labels (id bigserial PRIMARY KEY, title text, color text, show_on_sidebar boolean,
      account_id integer, created_at timestamp, updated_at timestamp);
    CREATE TABLE tags (id serial PRIMARY KEY, name text UNIQUE, taggings_count integer DEFAULT 0);
    CREATE TABLE taggings (id serial PRIMARY KEY, tag_id integer, taggable_type text, taggable_id bigint,
      context text, created_at timestamp);
    INSERT INTO contacts (name, phone_number, account_id, identifier, created_at, updated_at) VALUES
      ('Merged by number', '+620000000001', 1, 'telegram:1001', NOW(), NOW()),
      ('Old name', '+620000000002', 1, '620000000002@s.whatsapp.net', NOW(), NOW()),
      ('Other account', '+620000000003', 2, 'telegram:1003', NOW(), NOW());
  `);
}

test(
  'history contact import never adds a second contact for a number another contact holds',
  { skip: !url },
  async (t) => {
    const pool = new postgresql.Pool({ connectionString: url });
    const original = postgresClient.getChatwootConnection;
    t.after(async () => {
      postgresClient.getChatwootConnection = original;
      await pool.end();
    });
    await schema(pool);
    postgresClient.getChatwootConnection = (() => pool) as any;

    const instance = { instanceName: 'synthetic', instanceId: 'synthetic' };
    chatwootImport.deleteHistoryMessages(instance);
    chatwootImport.addHistoryContacts(instance, [
      { remoteJid: '620000000001@s.whatsapp.net', pushName: 'Same number as a Telegram contact' },
      { remoteJid: '620000000002@s.whatsapp.net', pushName: 'New name' },
      { remoteJid: '620000000003@s.whatsapp.net', pushName: 'Number held only in another account' },
      { remoteJid: '620000000004@s.whatsapp.net', pushName: 'Brand new' },
      { remoteJid: '120000000000000001@g.us', pushName: 'Team' },
    ] as any);

    await chatwootImport.importHistoryContacts(instance, { accountId: 1, nameInbox: 'synthetic' } as any);

    const contacts = (
      await pool.query(`SELECT identifier, name, phone_number FROM contacts WHERE account_id = 1 ORDER BY identifier`)
    ).rows;
    assert.deepEqual(contacts, [
      { identifier: '120000000000000001@g.us', name: 'Team (GROUP)', phone_number: null },
      { identifier: '620000000002@s.whatsapp.net', name: 'Old name', phone_number: '+620000000002' },
      {
        identifier: '620000000003@s.whatsapp.net',
        name: 'Number held only in another account',
        phone_number: '+620000000003',
      },
      { identifier: '620000000004@s.whatsapp.net', name: 'Brand new', phone_number: '+620000000004' },
      { identifier: 'telegram:1001', name: 'Merged by number', phone_number: '+620000000001' },
    ]);
    const tagged = (
      await pool.query(
        `SELECT c.identifier FROM taggings t JOIN contacts c ON c.id = t.taggable_id
       WHERE t.taggable_type = 'Contact' AND t.context = 'labels' ORDER BY 1`,
      )
    ).rows.map((row) => row.identifier);
    assert.deepEqual(tagged, [
      '120000000000000001@g.us',
      '620000000002@s.whatsapp.net',
      '620000000003@s.whatsapp.net',
      '620000000004@s.whatsapp.net',
    ]);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM taggings WHERE taggable_id IS NULL`)).rows[0].n, 0);
  },
);
