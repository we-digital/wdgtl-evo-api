import assert from 'node:assert/strict';
import test from 'node:test';

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import {
  assertIgnoredEditOriginalIdentity,
  CONFLICTING_TEXT_EDIT_REJECTION,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ignored-history-edit';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';

const message: any = {
  id: 'native',
  instanceId: 'synthetic',
  status: 'EDITED',
  messageType: 'conversation',
  key: { id: 'source', remoteJid: 'synthetic@g.us', fromMe: false },
  message: { extendedTextMessage: { text: 'conflicting retained edit' } },
  chatwootMessageId: 31,
  chatwootInboxId: 9,
  chatwootConversationId: 4,
};
const target = {
  id: 31,
  display_id: 4,
  private: false,
  message_type: 0,
  provider_peer: message.key.remoteJid,
  content: 'latest known original',
  content_attributes: {},
  message_snapshot: { content: 'latest known original' },
  attachments: [],
};

test('same-native declared-type conflict retains full original versions without applying its text', async () => {
  const originalPool = postgresClient.getChatwootConnection;
  const queries: string[] = [];
  const before = JSON.stringify({ message, target });
  try {
    postgresClient.getChatwootConnection = (() => ({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [target] };
      },
    })) as any;
    const proof = await chatwootImport.captureIgnoredHistoryEdit(
      message,
      message,
      9,
      { accountId: '1' } as any,
      'conflicting',
      CONFLICTING_TEXT_EDIT_REJECTION,
    );
    assert.equal(proof.editRepresentation, 'same_native_type_conflict');
    assert.equal(proof.editNativeId, proof.targetNativeId);
    assert.equal(proof.editSourceId, proof.targetSourceId);
    assert.equal(proof.rejection, CONFLICTING_TEXT_EDIT_REJECTION);
    assert.equal(queries.length, 1);
    assert.equal(
      queries.some((sql) => /^\s*(UPDATE|INSERT|DELETE)/.test(sql)),
      false,
    );
    assert.equal(JSON.stringify({ message, target }), before);
    assert.throws(() =>
      assertIgnoredEditOriginalIdentity(message, { ...message, message: { extendedTextMessage: { text: 'rotated' } } }),
    );
    assert.throws(() => assertIgnoredEditOriginalIdentity({ ...message, status: 'SERVER_ACK' }, message));
    await assert.rejects(
      () =>
        chatwootImport.captureIgnoredHistoryEdit(
          message,
          message,
          9,
          { accountId: '1' } as any,
          'unavailable',
          CONFLICTING_TEXT_EDIT_REJECTION,
        ),
      /representation differs/,
    );
  } finally {
    postgresClient.getChatwootConnection = originalPool;
  }
});

test('unavailable audio edit requires a unique live public audio destination with complete original pointers', async () => {
  const originalPool = postgresClient.getChatwootConnection;
  const audio = { ...message, messageType: 'audioMessage', message: null };
  try {
    for (const changed of [
      null,
      { has_audio: false },
      { provider_peer: 'foreign@g.us' },
      { private: true },
      { message_type: 1 },
      { id: 32 },
      { display_id: 5 },
      { content_attributes: { deleted: true } },
    ]) {
      const queries: string[] = [];
      const rows = changed === null ? [{ ...target, has_audio: true }] : [{ ...target, has_audio: true, ...changed }];
      postgresClient.getChatwootConnection = (() => ({
        connect: async () => ({
          query: async (sql: string) => {
            queries.push(sql);
            return { rows: sql.includes('SELECT m.id') ? rows : [] };
          },
          release() {},
        }),
      })) as any;
      const run = () =>
        chatwootImport.reconcileProviderHistoryEdits(
          [audio],
          9,
          { accountId: '1' } as any,
          { applyWhatsappProviderEdit: async () => assert.fail('No edit is applied to unavailable audio') } as any,
        );
      if (changed === null) {
        assert.equal((await run()).get('WAID:source'), 'preserved_existing_source_payload_unavailable');
        assert.equal(queries.at(-1), 'COMMIT');
      } else {
        await assert.rejects(run);
        assert.equal(queries.at(-1), 'ROLLBACK');
      }
      assert.match(queries[1], /file_type = 1/);
      assert.match(queries[1], /b.byte_size > 0 AND length\(b.key\) > 0/);
      assert.equal(
        queries.some((sql) => /^\s*(UPDATE|INSERT|DELETE)/.test(sql)),
        false,
      );
    }
  } finally {
    postgresClient.getChatwootConnection = originalPool;
  }
});
