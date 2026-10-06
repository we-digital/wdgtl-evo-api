import assert from 'node:assert/strict';
import test from 'node:test';

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';

const source: any = {
  id: 'synthetic-word',
  instanceId: 'synthetic',
  status: 'EDITED',
  messageType: 'documentMessage',
  message: null,
  key: { id: 'word-key', remoteJid: 'synthetic@g.us', fromMe: false },
  chatwootMessageId: 31,
  chatwootInboxId: 9,
  chatwootConversationId: 4,
};
const target = {
  id: 31,
  display_id: 4,
  private: false,
  message_type: 0,
  provider_peer: 'synthetic@g.us',
  content: 'preserved original',
  content_attributes: JSON.stringify({ in_reply_to: 3 }),
  has_preservable_document: true,
};

test('NULL Word edit preserves the existing original and uses only the proven PDF/Word MIME set', async () => {
  const previous = postgresClient.getChatwootConnection;
  const before = JSON.stringify({ source, target });
  const queries: string[] = [];
  try {
    postgresClient.getChatwootConnection = (() => ({
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: sql.includes('SELECT m.id') ? [target] : [] };
        },
        release() {},
      }),
    })) as any;
    const proof = await chatwootImport.reconcileProviderHistoryEdits(
      [source],
      9,
      { accountId: '1' } as any,
      { applyWhatsappProviderEdit: () => assert.fail('Unavailable edit must not write or send') } as any,
    );
    assert.equal(proof.get('WAID:word-key'), 'preserved_existing_source_payload_unavailable');
    assert.match(queries[1], /a\.file_type = 3 AND b\.content_type IN \('application\/pdf', 'application\/msword'\)/);
    assert.match(queries[1], /COUNT\(\*\).*attachments a WHERE a\.message_id = m\.id\) = 1/);
    assert.match(queries[1], /asa\.name = 'file'/);
    assert.match(queries[1], /b\.byte_size > 0 AND length\(b\.key\) > 0/);
    assert.equal(queries.at(-1), 'COMMIT');
    assert.equal(JSON.stringify({ source, target }), before);
    assert.equal(
      queries.some((sql) => /^\s*(UPDATE|INSERT|DELETE)/.test(sql)),
      false,
    );
  } finally {
    postgresClient.getChatwootConnection = previous;
  }
});

test('unproved document MIME or blob, cardinality and identity errors still refuse', async () => {
  const previous = postgresClient.getChatwootConnection;
  try {
    for (const rows of [
      [],
      [target, target],
      ...[
        { has_preservable_document: false },
        { private: true },
        { content_attributes: JSON.stringify({ deleted: true }) },
        { provider_peer: 'foreign@g.us' },
        { message_type: 1 },
        { id: 32 },
        { display_id: 5 },
      ].map((delta) => [{ ...target, ...delta }]),
    ]) {
      const queries: string[] = [];
      postgresClient.getChatwootConnection = (() => ({
        connect: async () => ({
          query: async (sql: string) => {
            queries.push(sql);
            return { rows: sql.includes('SELECT m.id') ? rows : [] };
          },
          release() {},
        }),
      })) as any;
      await assert.rejects(() =>
        chatwootImport.reconcileProviderHistoryEdits(
          [source],
          9,
          { accountId: '1' } as any,
          { applyWhatsappProviderEdit: () => assert.fail('No write') } as any,
        ),
      );
      assert.equal(queries.at(-1), 'ROLLBACK');
    }
    for (const field of ['chatwootMessageId', 'chatwootInboxId', 'chatwootConversationId']) {
      postgresClient.getChatwootConnection = (() => ({
        connect: async () => ({
          query: async (sql: string) => ({ rows: sql.includes('SELECT m.id') ? [target] : [] }),
          release() {},
        }),
      })) as any;
      await assert.rejects(() =>
        chatwootImport.reconcileProviderHistoryEdits(
          [{ ...source, [field]: null }],
          9,
          { accountId: '1' } as any,
          {} as any,
        ),
      );
    }
  } finally {
    postgresClient.getChatwootConnection = previous;
  }
});

test('ordinary missing documents remain ordinary and unavailable documents need retained EDITED provenance', () => {
  assert.throws(() => classifyCachedHistoryRecord({ messageType: 'documentMessage', message: null }, false));
  assert.equal(
    classifyCachedHistoryRecord(
      { messageType: 'documentMessage', message: { documentMessage: { mimetype: 'application/msword' } } },
      false,
    ),
    'ordinary',
  );
  assert.equal(classifyCachedHistoryRecord(source, true), 'unavailable_document_edit');
});
