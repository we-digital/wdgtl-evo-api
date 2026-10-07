import assert from 'node:assert/strict';
import test from 'node:test';
import { findNativeMessageByKey, selectUniqueNativeKeyMessage } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-native-message-key';

const row = (overrides: any = {}) => ({ id: 'native-1', instanceId: 'instance-1',
  key: { id: 'COLLISION', remoteJid: '120363000000001@g.us', fromMe: false },
  message: { conversation: 'Synthetic content' }, messageType: 'conversation', messageTimestamp: 1700000000,
  chatwootMessageId: null, chatwootInboxId: null, chatwootConversationId: null, chatwootContactInboxSourceId: null,
  ...overrides } as any);
const complete = () => row({ chatwootMessageId: 101, chatwootInboxId: 42, chatwootConversationId: 37,
  chatwootContactInboxSourceId: 'ci-source' });

test('scoped native SQL selects the exact peer and direction, unscoped collisions return null', async () => {
  const first = row();
  const foreignPeer = row({ id: 'other-peer', key: { ...first.key, remoteJid: '120363000000002@g.us' } });
  const outgoing = row({ id: 'outgoing', key: { ...first.key, fromMe: true } });
  const prisma = { $queryRaw: async (sql: any) => {
    assert.match(sql.text, /LIMIT 33/);
    assert.deepEqual(sql.values.slice(0, 2), ['instance-1', 'COLLISION']);
    return [first, foreignPeer, outgoing].filter((value) =>
      (!sql.text.includes("key->>'remoteJid'") || value.key.remoteJid === sql.values[2]) &&
      (!sql.text.includes("key->>'fromMe'") || String(value.key.fromMe) === sql.values[3]));
  } };
  assert.equal(await findNativeMessageByKey(prisma as any, 'instance-1', 'COLLISION'), null);
  assert.equal(await findNativeMessageByKey(prisma as any, 'instance-1', 'COLLISION', first.key), first);
  assert.equal(await findNativeMessageByKey(prisma as any, 'instance-1', 'COLLISION', outgoing.key), outgoing);
  assert.equal(await findNativeMessageByKey(prisma as any, 'instance-1', 'COLLISION', { remoteJid: '' }), null);
  assert.equal(await findNativeMessageByKey(prisma as any, 'instance-1', 'COLLISION', { fromMe: 'false' }), null);
});

test('identical receives retain timestamps and prefer consistent bound copy', () => {
  const a = row(); const b = complete(); b.messageTimestamp += 2;
  const before = structuredClone([a, b]);
  assert.equal(selectUniqueNativeKeyMessage([a, b]), b);
  assert.deepEqual([a, b], before);
  assert.equal(selectUniqueNativeKeyMessage([b, row({ chatwootMessageId: 999 })]), null);
  assert.equal(selectUniqueNativeKeyMessage([a, row({ message: { conversation: 'different' } })]), null);
  assert.equal(selectUniqueNativeKeyMessage(Array(33).fill(a)), null);
});

test('one bound text can be read through known passive receive metadata without admitting that copy for writes', () => {
  const bound = complete(); bound.key = { ...bound.key, participant: '14155552671@s.whatsapp.net', addressingMode: 'pn' };
  const old = row({ messageTimestamp: bound.messageTimestamp - 2,
    message: { conversation: 'Synthetic content', messageContextInfo: { threadId: 'synthetic', messageSecret: { type: 'Buffer', data: [1, 2] } } } });
  const before = structuredClone([bound, old]);
  assert.equal(selectUniqueNativeKeyMessage([old, bound]), bound);
  assert.deepEqual([bound, old], before);
  for (const incompatible of [
    row({ message: { conversation: 'other', messageContextInfo: { threadId: 'synthetic' } } }),
    row({ message: { conversation: 'Synthetic content', messageContextInfo: { quotedMessage: {} } } }),
    row({ key: { ...bound.key, participant: '14155550000@s.whatsapp.net' } }),
    row({ message: old.message, chatwootInboxId: 999 }),
  ]) assert.equal(selectUniqueNativeKeyMessage([bound, incompatible]), null);
  assert.equal(selectUniqueNativeKeyMessage([old, row({ key: bound.key })]), null);
  assert.equal(selectUniqueNativeKeyMessage([bound, { ...bound, id: 'second-bound', message: old.message }]), null);
});
