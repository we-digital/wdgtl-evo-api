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

test('ignored encrypted LID edit requires authenticated native phone alias plus exact scoped binding and contact inbox', async () => {
  const previous = postgresClient.getChatwootConnection;
  const original: any = {
    ...message,
    messageType: 'conversation',
    message: { conversation: 'original' },
    key: { id: 'source', remoteJid: '12345@lid', remoteJidAlt: '123456789@s.whatsapp.net', fromMe: false },
  };
  const envelope: any = {
    ...original,
    id: 'edit',
    key: { ...original.key, id: 'edit' },
    message: { secretEncryptedMessage: { secretEncType: 2, targetMessageKey: { id: 'source' } } },
  };
  const row = {
    ...target,
    provider_peer: original.key.remoteJidAlt,
    bound_peer: original.key.remoteJidAlt,
    contact_inbox_matches: true,
    binding_snapshot: { peer: original.key.remoteJidAlt },
    contact_inbox_snapshot: { id: 8 },
  };
  const before = JSON.stringify({ original, envelope, row });
  try {
    for (const changed of [
      null,
      { bound_peer: 'foreign@s.whatsapp.net' },
      { provider_peer: 'foreign@s.whatsapp.net' },
      { contact_inbox_matches: false },
      { binding_snapshot: null },
      { contact_inbox_snapshot: null },
    ]) {
      postgresClient.getChatwootConnection = (() => ({
        query: async (sql: string) => {
          assert.match(sql, /pc.inbox_id = c.inbox_id AND pc.provider = 'whatsapp'/);
          assert.match(sql, /ci.contact_id = contact.id AND ci.inbox_id = c.inbox_id/);
          assert.doesNotMatch(sql, /^\s*(UPDATE|INSERT|DELETE)/);
          return { rows: [{ ...row, ...changed }] };
        },
      })) as any;
      const run = () =>
        chatwootImport.captureIgnoredHistoryEdit(
          envelope,
          original,
          9,
          { accountId: '1' } as any,
          'conflicting',
          'Retained encrypted edit target identity differs',
        );
      if (changed === null) {
        const proof = await run();
        assert.equal(proof.peer, original.key.remoteJid);
        assert.equal(proof.targetNativeId, original.id);
        assert.equal(JSON.stringify({ original, envelope, row }), before);
      } else await assert.rejects(run, /unique current scoped/);
    }
    for (const alias of [undefined, 'foreign@s.whatsapp.net', '12345@lid']) {
      postgresClient.getChatwootConnection = (() => ({ query: async () => ({ rows: [row] }) })) as any;
      await assert.rejects(
        () =>
          chatwootImport.captureIgnoredHistoryEdit(
            envelope,
            { ...original, key: { ...original.key, remoteJidAlt: alias } },
            9,
            { accountId: '1' } as any,
            'conflicting',
            'Retained encrypted edit target identity differs',
          ),
        /unique current scoped/,
      );
    }
  } finally {
    postgresClient.getChatwootConnection = previous;
  }
});
