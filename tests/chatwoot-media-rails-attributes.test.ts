import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';

test('media postimage accepts the full Rails JSON store object or single encoding and refuses malformed or changed attributes', async (t) => {
  const modulePath = require.resolve('../src/api/server.module.ts');
  const previousModule = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {},
    children: [],
    paths: [],
  } as NodeModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Install the inert server boundary before loading the service.
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service = Object.create(ChatwootService.prototype) as any;
  const originalPool = postgresClient.getChatwootConnection;
  t.after(() => {
    postgresClient.getChatwootConnection = originalPool;
    if (previousModule) require.cache[modulePath] = previousModule;
    else delete require.cache[modulePath];
  });
  const bytes = Buffer.from('synthetic-JPEG-bytes');
  const digest = createHash('sha256').update(bytes).digest();
  const message = {
    id: 'native-image',
    key: { id: 'image', fromMe: false, remoteJid: 'synthetic@s.whatsapp.net' },
    messageType: 'imageMessage',
    messageTimestamp: 1700000000,
    message: { imageMessage: { mimetype: 'image/jpeg' } },
  };
  const attributes = {
    provider_history_native: { message_id: message.id, from_me: false, remote_jid: message.key.remoteJid },
    we_digital_ingress: { synthetic: { values: [1, false, null], text: 'preserved' } },
    external_created_at: 1700000000,
  };
  const row = {
    id: 7,
    message_type: 0,
    private: false,
    account_id: 1,
    inbox_id: 99,
    conversation_account: 1,
    conversation_inbox: 99,
    conversation_id: 123,
    display_id: 345,
    byte_size: bytes.length,
    content: 'caption',
    content_attributes: attributes as unknown,
    attachment_meta: { whatsapp_history_sha256: digest.toString('hex'), whatsapp_history_media_type: 'image' },
    content_type: 'image/jpeg',
    filename: 'synthetic.jpeg',
    checksum: createHash('md5').update(bytes).digest('base64'),
    created_at_epoch: 1700000000.123,
  };
  let queries = 0;
  postgresClient.getChatwootConnection = (() => ({
    query: async (sql: string, params: unknown[]) => {
      queries++;
      assert.equal(sql.includes('WHERE m.inbox_id=$1 AND m.source_id=ANY($2::text[])'), true);
      assert.deepEqual(params, [99, ['WAID:image', 'image']]);
      return { rows: [row] };
    },
  })) as any;
  const expected = { conversationId: 123, displayId: 345, content: 'caption', attributes };
  const descriptor = { filename: row.filename, mimetype: row.content_type, size: bytes.length, digest };
  const verify = () =>
    service.verifyRecoveryMediaDestination(message, { accountId: '1' }, 99, descriptor, bytes, expected);
  for (const representation of [attributes, JSON.stringify(attributes)]) {
    row.content_attributes = representation;
    const before = structuredClone(representation);
    await verify();
    assert.deepEqual(row.content_attributes, before);
  }
  for (const invalid of [
    null,
    [],
    'null',
    '[]',
    '{invalid',
    JSON.stringify(JSON.stringify(attributes)),
    { ...attributes, provider_history_native: { ...attributes.provider_history_native, from_me: true } },
    JSON.stringify({
      ...attributes,
      we_digital_ingress: { synthetic: { values: [1, true, null], text: 'preserved' } },
    }),
  ]) {
    row.content_attributes = invalid;
    await assert.rejects(verify(), /cached_media_import_postimage_unconfirmed/);
  }
  row.content_attributes = JSON.stringify(attributes);
  row.created_at_epoch++;
  await assert.rejects(verify(), /cached_media_import_postimage_unconfirmed/);
  assert.equal(queries, 11);
});
