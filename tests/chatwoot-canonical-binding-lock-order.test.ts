import assert from 'node:assert/strict';
import test from 'node:test';

import { withCanonicalChatwootMessageBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-canonical-message-binding';

// Chatwoot locks peer (advisory, inside provider_message_conversation_route)
// -> conversation -> message. The mapping writer runs on the same database and
// must never hold the message row lock while it waits for the peer lock.
function fakePool(options: { conversationAfterLock?: number } = {}) {
  const events: string[] = [];
  let peerLocked = false;
  const client = {
    query: async (sql: string) => {
      events.push(sql);
      if (/provider_message_conversation_route/.test(sql) && !/JOIN conversations/.test(sql)) {
        peerLocked = true;
        return { rows: [{ id: 40, provider_message_conversation_route: 40 }] };
      }
      if (/FROM messages m/.test(sql)) {
        return { rows: [{ id: 40, display_id: 7, inbox_id: 3, source_id: 'contact-source' }] };
      }
      if (/FROM messages WHERE id=/.test(sql)) {
        if (/FOR SHARE/.test(sql)) assert.ok(peerLocked, 'message row locked before the peer lock');
        const conversationId = peerLocked && options.conversationAfterLock ? options.conversationAfterLock : 40;
        return {
          rows: [
            {
              conversation_id: conversationId,
              source_id: null,
              message_type: 1,
              private: false,
              additional_attributes: {},
            },
          ],
        };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client } as any, events };
}

const scope = {
  accountId: 1,
  inboxId: 3,
  messageId: 70,
  whatsappMessageId: 'WD-A',
  acknowledgedParts: [{ partKey: 'p', partIndex: 0, partCount: 1, sourceId: 'WD-A' }],
};

test('the mapping writer takes the peer lock before locking the message row', async () => {
  const { pool, events } = fakePool();
  const result = await withCanonicalChatwootMessageBinding(pool, scope as any, async (binding) => binding);
  assert.equal(result.conversationId, 7);
  const peer = events.findIndex((sql) => /provider_message_conversation_route\(\$1,\$2,\$3\)$/.test(sql.trim()));
  const rowLock = events.findIndex((sql) => /FROM messages WHERE id=.*FOR SHARE/.test(sql));
  assert.ok(peer >= 0 && rowLock > peer, events.join('\n'));
  assert.equal(events.at(-1), 'COMMIT');
});

test('a message moved by a merge before the peer lock is refused for a retry', async () => {
  const { pool, events } = fakePool({ conversationAfterLock: 41 });
  await assert.rejects(
    withCanonicalChatwootMessageBinding(pool, scope as any, async () => assert.fail('must not write')),
    /moved while locking/,
  );
  assert.equal(events.at(-1), 'ROLLBACK');
});
