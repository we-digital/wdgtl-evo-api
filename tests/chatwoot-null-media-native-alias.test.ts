import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
for (const messageType of ['documentMessage', 'audioMessage']) {
  test(`NULL ${messageType} preserves exact native LID phone alias with scoped original proof`, async () => {
    const previous = postgresClient.getChatwootConnection;
    const message: any = {
      id: 'native',
      instanceId: 'owned',
      status: 'EDITED',
      messageType,
      message: null,
      key: { id: 'source', remoteJid: '12345@lid', remoteJidAlt: '123456789@s.whatsapp.net', fromMe: false },
      chatwootMessageId: 31,
      chatwootInboxId: 9,
      chatwootConversationId: 4,
    };
    const target: any = {
      id: 31,
      display_id: 4,
      private: false,
      message_type: 0,
      provider_peer: message.key.remoteJidAlt,
      bound_peer: message.key.remoteJidAlt,
      contact_inbox_matches: true,
      contact_inbox_snapshot: { id: 8 },
      binding_snapshot: { provider: 'whatsapp', peer: message.key.remoteJidAlt },
      content_attributes: '{}',
      has_preservable_document: true,
      has_audio: true,
    };
    const cases = [
      null,
      { binding_snapshot: null },
      { bound_peer: 'foreign@s.whatsapp.net' },
      { binding_snapshot: { provider: 'telegram' } },
      { provider_peer: 'foreign@s.whatsapp.net' },
      { contact_inbox_matches: false },
      { contact_inbox_snapshot: null },
      { private: true },
      { id: 32 },
      { display_id: 5 },
      { message_type: 1 },
      { content_attributes: { deleted: true } },
      { has_preservable_document: false, has_audio: false },
    ];
    try {
      for (const [i, change] of cases.entries()) {
        const row = { ...target, ...change };
        const queries: string[] = [];
        const before = JSON.stringify({ message, row });
        postgresClient.getChatwootConnection = (() => ({
          connect: async () => ({
            query: async (sql: string, args?: any[]) => {
              queries.push(sql);
              if (sql.includes('SELECT m.id')) {
                assert.deepEqual(args, [1, 9, ['WAID:source', 'source']]);
                assert.match(sql, /ci.contact_id = contact.id AND ci.inbox_id = c.inbox_id/);
                assert.match(sql, /b.content_type IN \('application\/pdf', 'application\/msword'\)/);
                return { rows: [row] };
              }
              return { rows: [] };
            },
            release() {},
          }),
        })) as any;
        const run = () =>
          chatwootImport.reconcileProviderHistoryEdits(
            [message],
            9,
            { accountId: '1' } as any,
            { applyWhatsappProviderEdit: async () => assert.fail('No unavailable edit is applied') } as any,
          );
        if (i < 2) {
          assert.equal((await run()).get('WAID:source'), 'preserved_existing_source_payload_unavailable');
          assert.equal(queries.at(-1), 'COMMIT');
        } else {
          await assert.rejects(run);
          assert.equal(queries.at(-1), 'ROLLBACK');
        }
        assert.equal(JSON.stringify({ message, row }), before);
        assert.equal(
          queries.some((s) => /^\s*(UPDATE|INSERT|DELETE)/.test(s)),
          false,
        );
      }
      for (const changed of [
        { key: { ...message.key, remoteJidAlt: undefined } },
        { key: { ...message.key, remoteJidAlt: 'foreign@s.whatsapp.net' } },
        { chatwootInboxId: 10 },
        { chatwootMessageId: null },
        { chatwootConversationId: null },
        { message: {} },
      ]) {
        postgresClient.getChatwootConnection = (() => ({
          connect: async () => ({
            query: async (sql: string) => ({ rows: sql.includes('SELECT m.id') ? [target] : [] }),
            release() {},
          }),
        })) as any;
        await assert.rejects(() =>
          chatwootImport.reconcileProviderHistoryEdits(
            [{ ...message, ...changed }],
            9,
            { accountId: '1' } as any,
            {} as any,
          ),
        );
      }
      postgresClient.getChatwootConnection = (() => ({
        connect: async () => ({
          query: async (sql: string) => ({ rows: sql.includes('SELECT m.id') ? [target, target] : [] }),
          release() {},
        }),
      })) as any;
      await assert.rejects(() =>
        chatwootImport.reconcileProviderHistoryEdits([message], 9, { accountId: '1' } as any, {} as any),
      );
    } finally {
      postgresClient.getChatwootConnection = previous;
    }
  });
}
