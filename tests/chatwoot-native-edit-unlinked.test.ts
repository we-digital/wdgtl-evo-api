process.env.CHATWOOT_AVATAR_SYNC = 'off';

import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';

const GROUP = '120363000000000000@g.us';
const instance = { instanceName: 'p-mila', instanceId: 'inst-1' } as any;
const body = {
  id: 70,
  content: 'edited text',
  account: { id: 1 },
  inbox: { id: 3 },
  conversation: { id: 7 },
};
const origin = { accountId: 1, inboxId: 3, conversationId: 7, messageId: 70 };
const op = (changes: Record<string, any> = {}) => ({
  instanceId: 'inst-1',
  chatwootMessageId: 70,
  plannedWhatsappMessageId: 'WD-TEXT',
  whatsappMessageId: 'WD-TEXT',
  state: 'callback_pending',
  partIndex: 0,
  partCount: 1,
  ...changes,
  payload: { chatId: GROUP, text: 'original', origin, ...(changes.payload || {}) },
});
const row = (id: string, changes: Record<string, any> = {}) => ({
  key: { id, remoteJid: GROUP, fromMe: true, ...changes },
});

function serviceWith(options: { mapped?: any; operations: () => any[]; rows: Record<string, any>; sentIds?: any }) {
  const service = Object.create(ChatwootService.prototype) as any;
  service.nativeEditTransportWaitMs = 600;
  service.logger = { verbose() {}, warn() {}, error() {}, info() {} };
  service.prismaRepository = {
    message: {
      findFirst: async ({ where }: any) => {
        if (where.chatwootMessageId !== undefined) return options.mapped ?? null;
        return options.rows[where.key.equals] ?? null;
      },
    },
  };
  service.outboundStore = {
    retainedOperations: async () => options.operations(),
    findSentMessageId: async (operation: any) => options.sentIds?.[operation.plannedWhatsappMessageId] ?? null,
  };
  const edits: any[] = [];
  const waInstance = {
    updateMessage: async (data: any) => {
      edits.push(data);
      return { key: data.key };
    },
  };
  return { service, edits, waInstance };
}

test('an edit before the delivery callback links the row uses the id the queue sent', async () => {
  const { service, edits, waInstance } = serviceWith({
    operations: () => [op()],
    rows: { 'WD-TEXT': row('WD-TEXT') },
  });
  const result = await service.trySendNativeEdit(waInstance, GROUP, body, instance);
  assert.equal(result?.key?.id, 'WD-TEXT');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, 'edited text');
  assert.equal(edits[0].key.id, 'WD-TEXT');
});

test('a linked row still wins over the queue', async () => {
  const { service, edits, waInstance } = serviceWith({
    mapped: row('WD-LINKED'),
    operations: () => assert.fail('queue must not be read when the row is linked'),
    rows: {},
  });
  await service.trySendNativeEdit(waInstance, GROUP, body, instance);
  assert.equal(edits[0].key.id, 'WD-LINKED');
});

test('a multi-part send edits the part that carries the text', async () => {
  const { service, edits, waInstance } = serviceWith({
    operations: () => [
      op({ plannedWhatsappMessageId: 'WD-IMG', whatsappMessageId: 'WD-IMG', partCount: 2, payload: { text: null } }),
      op({ plannedWhatsappMessageId: 'WD-CAP', whatsappMessageId: null, partIndex: 1, partCount: 2 }),
    ],
    rows: { 'WD-IMG': row('WD-IMG'), 'WD-CAP': row('WD-CAP') },
    sentIds: { 'WD-CAP': 'WD-CAP' },
  });
  await service.trySendNativeEdit(waInstance, GROUP, body, instance);
  assert.equal(edits[0].key.id, 'WD-CAP');
});

test('an edit while the part is still being sent waits for the send', async () => {
  let reads = 0;
  const { service, edits, waInstance } = serviceWith({
    operations: () =>
      ++reads < 3 ? [op({ state: 'sending', whatsappMessageId: null })] : [op({ state: 'callback_pending' })],
    rows: { 'WD-TEXT': row('WD-TEXT') },
  });
  await service.trySendNativeEdit(waInstance, GROUP, body, instance);
  assert.equal(edits[0].key.id, 'WD-TEXT');
  assert.ok(reads >= 3);
});

test('no edit without a matching sent part: other chat, other conversation, deleted, never sent', async () => {
  const cases = [
    { operations: () => [op({ payload: { chatId: '999@g.us' } })], rows: { 'WD-TEXT': row('WD-TEXT') } },
    {
      operations: () => [op({ payload: { origin: { ...origin, conversationId: 8 } } })],
      rows: { 'WD-TEXT': row('WD-TEXT') },
    },
    { operations: () => [op({ state: 'delete_pending' })], rows: { 'WD-TEXT': row('WD-TEXT') } },
    { operations: () => [op({ state: 'sending', whatsappMessageId: null })], rows: {} },
    { operations: () => [op()], rows: { 'WD-TEXT': row('WD-TEXT', { fromMe: false }) } },
    { operations: () => [op()], rows: { 'WD-TEXT': row('WD-TEXT', { remoteJid: '999@g.us' }) } },
    { operations: () => [], rows: {} },
  ];
  for (const options of cases) {
    const { service, edits, waInstance } = serviceWith(options as any);
    assert.equal(await service.trySendNativeEdit(waInstance, GROUP, body, instance), null);
    assert.equal(edits.length, 0);
  }
});
