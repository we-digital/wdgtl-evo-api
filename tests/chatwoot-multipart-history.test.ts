import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledgedMultipartSourceIds } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import { Message } from '@prisma/client';

const receipt = () => ({
  we_digital_api_inbox_status: {
    confirmed_status: 'sent',
    provider_delivery: {
      contract_version: 1,
      part_count: 2,
      acknowledgements: {
        first: { part_index: 0, source_id: 'A' },
        second: { part_index: 1, source_id: 'B' },
      },
    },
  },
});
const message = (id: string) =>
  ({ key: { id, fromMe: true }, chatwootMessageId: 123, chatwootInboxId: 7, chatwootConversationId: 9 }) as Message;

for (const serialized of [false, true]) {
  test(`actual history reconciles both confirmed attachment sources without rebinding the canonical bubble (serialized=${serialized})`, async () => {
    const original = postgresClient.getChatwootConnection;
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const attrs = receipt();
    try {
      postgresClient.getChatwootConnection = (() => ({
        connect: async () => ({
          query: async (sql: string, params: unknown[] = []) => {
            queries.push({ sql, params });
            if (sql.trim().startsWith('SELECT id, inbox_id'))
              return {
                rows: [
                  {
                    id: 123,
                    inbox_id: 7,
                    conversation_id: 9,
                    message_type: 1,
                    source_id: 'WAID:A',
                    additional_attributes: serialized ? JSON.stringify(attrs) : attrs,
                  },
                ],
              };
            if (sql.startsWith('SELECT id FROM messages')) return { rows: [{ id: 123 }] };
            return { rows: [], rowCount: 1 };
          },
          release: () => undefined,
        }),
      })) as any;
      assert.deepEqual(
        await chatwootImport.reconcileOutboundHistoryBindings([message('A'), message('B')], 7),
        new Set(['WAID:A', 'WAID:B']),
      );
      assert.ok(!queries.some((x) => /UPDATE|INSERT|DELETE/.test(x.sql.split(' FOR UPDATE')[0])));
      assert.equal(queries.at(-1)?.sql, 'COMMIT');
    } finally {
      postgresClient.getChatwootConnection = original;
    }
  });
}

test('malformed, incomplete and contradictory delivery receipts fail closed', () => {
  const incomplete = receipt();
  delete (incomplete.we_digital_api_inbox_status.provider_delivery.acknowledgements as any).second;
  const index = receipt();
  index.we_digital_api_inbox_status.provider_delivery.acknowledgements.second.part_index = 0;
  const duplicate = receipt();
  duplicate.we_digital_api_inbox_status.provider_delivery.acknowledgements.second.source_id = 'WAID:A';
  const failed = receipt();
  failed.we_digital_api_inbox_status.confirmed_status = 'failed';
  for (const attrs of [incomplete, index, duplicate, failed, '{bad', null])
    assert.equal(acknowledgedMultipartSourceIds(attrs, 'A'), null);
  assert.equal(acknowledgedMultipartSourceIds(receipt(), 'B'), null);
});

test('actual multipart history still rejects an independent owner of any acknowledged part', async () => {
  const original = postgresClient.getChatwootConnection;
  const statements: string[] = [];
  try {
    postgresClient.getChatwootConnection = (() => ({
      connect: async () => ({
        query: async (sql: string) => {
          statements.push(sql);
          if (sql.trim().startsWith('SELECT id, inbox_id'))
            return {
              rows: [
                {
                  id: 123,
                  inbox_id: 7,
                  conversation_id: 9,
                  message_type: 1,
                  source_id: 'WAID:A',
                  additional_attributes: receipt(),
                },
              ],
            };
          if (sql.startsWith('SELECT id FROM messages')) return { rows: [{ id: 123 }, { id: 124 }] };
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      }),
    })) as any;
    await assert.rejects(
      chatwootImport.reconcileOutboundHistoryBindings([message('B')], 7),
      /conflicting source owners/,
    );
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.ok(!statements.some((sql) => sql.startsWith('UPDATE')));
  } finally {
    postgresClient.getChatwootConnection = original;
  }
});
