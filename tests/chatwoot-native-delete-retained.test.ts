process.env.CHATWOOT_AVATAR_SYNC = 'off';

import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { ChatwootOutboundPrismaStore } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-prisma-store';

// A staff delete of a message the outbound queue still retains used to queue a
// deletion, wake the worker and delete natively in the same request. When the
// probe removed the native rows first, the worker waited for them forever
// (AwaitingExactWhatsappMessage) and held the chat's outbound lane.
const GROUP = '120363000000000000@g.us';
const instance = { instanceName: 'p-mila', instanceId: 'inst-1' } as any;
const body = { id: 70, account: { id: 1 }, inbox: { id: 3 }, conversation: { id: 7 } };
const op = (id: string, sentId: string | null, sendAttempts = 1) =>
  ({
    id,
    whatsappMessageId: sentId,
    plannedWhatsappMessageId: sentId || id,
    sendAttempts,
    payload: { chatId: GROUP },
  }) as any;

function service(options: { mapped?: any; closed?: boolean }) {
  const s = Object.create(ChatwootService.prototype) as any;
  const calls = { revoked: [] as string[], completed: 0, removedRows: 0, woke: 0 };
  s.prismaRepository = {
    message: {
      findFirst: async () => options.mapped ?? null,
      deleteMany: async () => {
        calls.removedRows++;
        return { count: 1 };
      },
    },
  };
  s.outboundStore = {
    findSentMessageId: async () => null,
    completeNativeDeletion: async () => {
      calls.completed++;
      return options.closed ?? true;
    },
  };
  s.outboundQueue = { wake: () => calls.woke++ };
  const waInstance = {
    client: {
      sendMessage: async (_jid: string, content: any) => {
        calls.revoked.push(content.delete.id);
      },
    },
  };
  return { s, calls, waInstance };
}

test('a mapped multi-part delete revokes every sent part and closes the queued deletions', async () => {
  const mapped = {
    key: { id: 'WD-A', remoteJid: GROUP, fromMe: true },
    chatwootInboxId: 3,
    chatwootConversationId: 7,
  };
  const { s, calls, waInstance } = service({ mapped });
  const result = await s.deleteRetainedNatively(
    waInstance,
    instance,
    body,
    [op('o1', 'WD-A'), op('o2', 'WD-B')],
    GROUP,
  );
  assert.deepEqual(result, { message: 'deleted' });
  assert.deepEqual(calls.revoked, ['WD-A', 'WD-B']);
  assert.equal(calls.completed, 1);
  assert.equal(calls.removedRows, 1);
  assert.equal(calls.woke, 0, 'the worker must not race the probe');
});

test('rows stay for a worker that already holds a part', async () => {
  const mapped = { key: { id: 'WD-A', remoteJid: GROUP, fromMe: true }, chatwootInboxId: 3, chatwootConversationId: 7 };
  const { s, calls, waInstance } = service({ mapped, closed: false });
  await s.deleteRetainedNatively(waInstance, instance, body, [op('o1', 'WD-A')], GROUP);
  assert.equal(calls.removedRows, 0);
});

test('an unlinked delete revokes the sent ids and closes the queued deletions', async () => {
  const { s, calls, waInstance } = service({});
  await s.deleteRetainedNatively(waInstance, instance, body, [op('o1', 'WD-A')], GROUP);
  assert.deepEqual(calls.revoked, ['WD-A']);
  assert.equal(calls.completed, 1);
  assert.equal(calls.woke, 0);
});

test('a never-sent message is left to the queue', async () => {
  const { s, calls, waInstance } = service({});
  await s.deleteRetainedNatively(waInstance, instance, body, [op('o1', null, 0)], GROUP);
  assert.deepEqual(calls.revoked, []);
  assert.equal(calls.completed, 0);
  assert.equal(calls.woke, 1);
});

test('completeNativeDeletion closes only unleased pending deletions and reports what stays open', async () => {
  const rows = [
    { id: 'o1', state: 'delete_pending', leaseOwner: null },
    { id: 'o2', state: 'delete_pending', leaseOwner: 'worker-1' },
  ];
  const repository: any = {
    chatwootOutboundOperation: {
      updateMany: async ({ where, data }: any) => {
        for (const row of rows) {
          if (where.id.in.includes(row.id) && row.state === where.state && row.leaseOwner === where.leaseOwner) {
            Object.assign(row, data);
          }
        }
        return { count: 1 };
      },
      count: async ({ where }: any) =>
        rows.filter((row) => where.id.in.includes(row.id) && row.state !== where.state.not).length,
    },
  };
  const store = new ChatwootOutboundPrismaStore(repository, {} as any);
  assert.equal(await store.completeNativeDeletion([{ id: 'o1' }, { id: 'o2' }] as any, new Date()), false);
  assert.equal(rows[0].state, 'deleted');
  assert.equal(rows[1].state, 'delete_pending');
  rows[1].leaseOwner = null;
  assert.equal(await store.completeNativeDeletion([{ id: 'o1' }, { id: 'o2' }] as any, new Date()), true);
});
