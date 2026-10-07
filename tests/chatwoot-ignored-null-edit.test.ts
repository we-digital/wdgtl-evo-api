import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import {
  ignoredNullEditProof,
  isKnownUnavailableNullEdit,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ignored-history-edit';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
const source = (type = 'imageMessage'): any => ({
  id: 'native',
  instanceId: 'owner',
  messageType: type,
  status: 'EDITED',
  message: null,
  key: { id: 'key', remoteJid: '123@g.us', fromMe: false },
  messageTimestamp: 1700000000,
  chatwootMessageId: 50,
  chatwootInboxId: 9,
  chatwootConversationId: 8,
});
const state = (s: any): any => ({
  sourceRows: [s],
  targetUpdates: [{ instanceId: s.instanceId, messageId: s.id, status: 'EDITED' }],
  competitors: [],
});
for (const type of ['conversation', 'extendedTextMessage', 'imageMessage', 'documentMessage', 'audioMessage']) {
  test(`known NULL ${type} is explicitly ignored with self-source proof, no destination claim`, async () => {
    const s = source(type);
    const snapshot = JSON.stringify(s);
    const p = ignoredNullEditProof(s, state(s), 1, 9);
    assert.equal(p.version, 2);
    assert.equal(p.disposition, 'ignored_unavailable_edit');
    assert.equal(p.destinationState, 'unqualified');
    assert.equal(p.targetSourceId, p.sourceId);
    assert.equal(p.targetNativeId, p.sourceNativeId);
    assert.equal('destinationAbsent' in p, false);
    assert.equal('destinationMessageId' in p, false);
    assert.equal(JSON.stringify(s), snapshot);
    const old = postgresClient.getChatwootConnection;
    let calls = 0;
    const sqls: string[] = [];
    try {
      for (const rows of [
        [],
        [{ id: 51, private: false }],
        [
          { id: 50, private: false },
          { id: 52, private: false },
        ],
      ]) {
        postgresClient.getChatwootConnection = (() => ({
          connect: async () => ({
            query: async (sql: string) => {
              sqls.push(sql);
              return { rows: sql.startsWith('SELECT') ? rows : [] };
            },
            release() {},
          }),
        })) as any;
        const result = await chatwootImport.reconcileProviderHistoryEdits(
          [s],
          9,
          { accountId: '1' } as any,
          {} as any,
          false,
          undefined,
          async (current) => {
            assert.deepEqual(current, s);
            ignoredNullEditProof(current, state(current), 1, 9);
            calls++;
          },
        );
        assert.equal(result.size, 0);
        assert.equal(sqls.at(-1), 'COMMIT');
      }
      assert.equal(calls, 3);
      assert.equal(
        sqls.some((x) => /^(INSERT|UPDATE|DELETE)/.test(x)),
        false,
      );
    } finally {
      postgresClient.getChatwootConnection = old;
    }
  });
}
test('available, ordinary, unknown, empty object and invalid native identity never enter ignored NULL proof', () => {
  for (const patch of [
    { message: {} },
    { message: { conversation: 'available' } },
    { status: 'DELIVERY_ACK' },
    { messageType: 'unknown' },
    { id: '' },
    { instanceId: '' },
    { messageTimestamp: 0 },
    { key: { id: 'x', remoteJid: 'p', fromMe: 'false' } },
  ]) {
    const s = { ...source(), ...patch };
    assert.equal(isKnownUnavailableNullEdit(s), false);
    assert.throws(() => ignoredNullEditProof(s, state(s), 1, 9));
  }
  const s = source();
  for (const x of [
    { ...state(s), targetUpdates: [] },
    { ...state(s), sourceRows: [{ ...s, messageTimestamp: 1 }] },
    { ...state(s), sourceRows: [s, s] },
    { ...state(s), competitors: [s] },
    { ...state(s), targetUpdates: [{ instanceId: 'foreign', messageId: s.id, status: 'EDITED' }] },
  ])
    assert.throws(() => ignoredNullEditProof(s, x, 1, 9));
});
test('qualified existing original still preserves and unknown SQL failure never invokes ignored callback', async () => {
  const old = postgresClient.getChatwootConnection;
  let ignored = 0;
  const s = source('conversation');
  const target = {
    id: 50,
    display_id: 8,
    private: false,
    content: 'last known',
    message_type: 0,
    provider_peer: s.key.remoteJid,
    content_attributes: {},
  };
  try {
    postgresClient.getChatwootConnection = (() => ({
      connect: async () => ({
        query: async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [target] : [] }),
        release() {},
      }),
    })) as any;
    const result = await chatwootImport.reconcileProviderHistoryEdits(
      [s],
      9,
      { accountId: '1' } as any,
      {} as any,
      false,
      undefined,
      async () => {
        ignored++;
      },
    );
    assert.equal(result.get('WAID:key'), 'preserved_existing_source_payload_unavailable');
    assert.equal(ignored, 0);
    postgresClient.getChatwootConnection = (() => ({
      connect: async () => ({
        query: async () => {
          throw new Error('transport unknown');
        },
        release() {},
      }),
    })) as any;
    await assert.rejects(() =>
      chatwootImport.reconcileProviderHistoryEdits(
        [s],
        9,
        { accountId: '1' } as any,
        {} as any,
        false,
        undefined,
        async () => {
          ignored++;
        },
      ),
    );
    assert.equal(ignored, 0);
  } finally {
    postgresClient.getChatwootConnection = old;
  }
});
