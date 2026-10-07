import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileNativeEventBinding } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-native-event-binding';

const peer = '120363000000001@g.us';
const native = () => ({ id: 'native-1', instanceId: 'instance-1', key: { id: 'SOURCE1', remoteJid: peer, fromMe: false },
  message: { conversation: 'Synthetic' }, messageType: 'conversation', messageTimestamp: 1700000000,
  chatwootMessageId: null, chatwootInboxId: null, chatwootConversationId: null, chatwootContactInboxSourceId: null } as any);
function fixture(options: any = {}) {
  const source = { ...native(), ...options.source };
  const stored = structuredClone(source); const writes: any[] = []; const events: string[] = [];
  const target = { conversation_id: 900, source_id: 'WAID:SOURCE1', message_type: source.key.fromMe ? 1 : 0,
    private: false, ...options.target };
  const aliases = options.aliases || [{ id: 101 }];
  const pool = {
    query: async (sql: string) => ({ rows: sql.includes('provider_conversation_bindings') ? [{ peer: options.peer || peer }] :
      sql.startsWith('SELECT source_id') ? [target] : aliases }),
    connect: async () => ({ release() {}, query: async (sql: string) => {
      events.push(sql);
      if (sql.startsWith('SELECT conversation_id')) return { rows: [target] };
      if (sql.includes('SELECT public.provider_message_conversation_route')) return { rows: [{ id: 900 }] };
      if (sql.startsWith('SELECT id FROM messages')) return { rows: aliases };
      if (sql.startsWith('SELECT c.id')) return { rows: [{ id: 900, display_id: 37, inbox_id: 42, source_id: 'ci' }] };
      if (sql.includes('SELECT b.peer')) return { rows: [{ peer: options.peer || peer }] };
      return { rows: [] };
    } }),
  };
  const prisma = { message: { findFirst: async () => options.after ? { ...stored, ...options.after } : stored },
    $transaction: async (work: any) => work({ $queryRaw: async () => [{ ...stored, ...options.locked }],
      message: { updateMany: async (query: any) => { writes.push(query); Object.assign(stored, query.data); return { count: 1 }; } } }) };
  return { source, stored, writes, events, run: () => reconcileNativeEventBinding(pool as any, prisma as any, source, 1, 42) };
}

test('NULL mapping uses exact current native source and canonical scoped public alias; only native pointers change', async () => {
  const f = fixture(); const before = structuredClone(f.source);
  const result = await f.run();
  assert.equal(result.chatwootMessageId, 101); assert.equal(result.chatwootConversationId, 37);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(result.message, before.message); assert.deepEqual(result.key, before.key);
  assert.equal(result.messageTimestamp, before.messageTimestamp);
  assert.ok(f.events.some((sql) => sql.includes('FOR SHARE')));
  assert.ok(f.events.every((sql) => !/^(INSERT|UPDATE|DELETE)/i.test(sql)));
});
for (const [label, options] of [
  ['ambiguous alias', { aliases: [{ id: 101 }, { id: 102 }] }],
  ['foreign peer', { peer: '120363000000099@g.us' }],
  ['wrong direction', { target: { message_type: 1 } }],
  ['private destination', { target: { private: true } }],
  ['non-null wrong pointer', { source: { chatwootMessageId: 999 } }],
  ['source version rotation under lock', { locked: { message: { conversation: 'edited' } } }],
] as const) test(`lazy mapping refuses ${label} without any native update`, async () => {
  const f = fixture(options); await assert.rejects(f.run()); assert.equal(f.writes.length, 0);
});
test('independent reread rejects source rotation after pointer-only mapping', async () => {
  const f = fixture({ after: { messageTimestamp: 1700000100 } });
  await assert.rejects(f.run(), /changed after reconciliation/);
});
test('already complete mapping is qualified read-only', async () => {
  const f = fixture({ source: { chatwootMessageId: 101, chatwootInboxId: 42, chatwootConversationId: 37, chatwootContactInboxSourceId: 'ci' } });
  await f.run(); assert.equal(f.writes.length, 0);
});
for (const prefixed of [false, true]) test(`acknowledged multipart outgoing target keeps owner and sorted part set (WAID=${prefixed})`, async () => {
  const id = (value: string) => prefixed ? `WAID:${value}` : value;
  const attributes = { we_digital_api_inbox_status: { confirmed_status: 'sent', provider_delivery: {
    contract_version: 1, part_count: 2, confirmed: true, status: 'sent', acknowledgements: {
      second: { part_index: 1, source_id: id('SECOND') }, first: { part_index: 0, source_id: id('FIRST') },
    },
  } } };
  const f = fixture({ source: { key: { ...native().key, id: 'SECOND', fromMe: true }, chatwootMessageId: 101,
    chatwootInboxId: 42, chatwootConversationId: 37, chatwootContactInboxSourceId: 'ci' },
    target: { source_id: id('FIRST'), additional_attributes: attributes } });
  await f.run(); assert.equal(f.writes.length, 0);
});
