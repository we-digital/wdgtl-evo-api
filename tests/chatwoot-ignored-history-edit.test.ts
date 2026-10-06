import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import {
  assertIgnoredEditOriginalIdentity,
  ignoredHistoryEditFailure,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ignored-history-edit';

function fixture(fromMe = false) {
  const original: any = {
    id: 'native-original',
    instanceId: 'synthetic',
    key: { id: 'original', remoteJid: 'synthetic@g.us', fromMe },
    message: { conversation: 'last known' },
    chatwootMessageId: 314,
    chatwootInboxId: 99,
    chatwootConversationId: 40,
  };
  const envelope: any = {
    id: 'native-edit',
    instanceId: 'synthetic',
    key: { id: 'edit', remoteJid: 'synthetic@g.us', fromMe },
    message: {
      secretEncryptedMessage: {
        secretEncType: 2,
        targetMessageKey: { id: 'original', remoteJid: 'rejected@g.us', fromMe: !fromMe },
      },
    },
  };
  const target = {
    id: 314,
    message_type: fromMe ? 1 : 0,
    private: false,
    content: 'last known',
    content_attributes: {},
    display_id: 40,
    provider_peer: 'synthetic@g.us',
    message_snapshot: { content: 'last known', sender_id: 17 },
    attachments: [{ attachment: { id: 18 }, blob: { key: 'retained-blob', byte_size: 123 } }],
  };
  return { original, envelope, target };
}

test('rejected claimed metadata cannot change original identity; actual peer/direction/instance conflicts still stop', () => {
  const { original, envelope } = fixture();
  assert.doesNotThrow(() => assertIgnoredEditOriginalIdentity(envelope, original));
  for (const change of [
    { instanceId: 'foreign' },
    { key: { ...envelope.key, fromMe: true } },
    { key: { ...envelope.key, remoteJid: 'foreign@g.us' } },
  ])
    assert.throws(() => assertIgnoredEditOriginalIdentity({ ...envelope, ...change }, original));
  assert.equal(
    ignoredHistoryEditFailure(new Error('Retained encrypted edit has unknown protobuf data')),
    'unavailable',
  );
  assert.equal(ignoredHistoryEditFailure(new Error('Retained encrypted edit target identity differs')), 'conflicting');
  assert.equal(ignoredHistoryEditFailure(new Error('network unavailable')), undefined);
  assert.equal(ignoredHistoryEditFailure(new TypeError('programming failure')), undefined);
});

test('preservation records full current original versions without writes or downloads in both directions', async () => {
  const previous = postgresClient.getChatwootConnection;
  try {
    for (const fromMe of [false, true]) {
      const { original, envelope, target } = fixture(fromMe);
      const before = JSON.stringify({ original, envelope, target });
      const queries: string[] = [];
      postgresClient.getChatwootConnection = (() => ({
        query: async (sql: string, args: unknown[]) => {
          queries.push(sql);
          assert.deepEqual(args, [1, 99, ['WAID:original', 'original']]);
          return { rows: [target] };
        },
      })) as any;
      const proof = await chatwootImport.captureIgnoredHistoryEdit(
        envelope,
        original,
        99,
        { accountId: '1' } as any,
        'conflicting',
        'retained_edit_order_conflict',
      );
      assert.equal(proof.targetNativeId, original.id);
      assert.equal(proof.peer, original.key.remoteJid);
      assert.equal(proof.direction, fromMe ? 'outgoing' : 'incoming');
      assert.match(proof.nativeVersionSHA256, /^[a-f0-9]{64}$/);
      assert.match(proof.destinationVersionSHA256, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify({ original, envelope, target }), before);
      assert.equal(queries.length, 1);
      assert.match(queries[0], /c.inbox_id = \$2/);
      assert.equal(
        queries.some((sql) => /^\s*(UPDATE|INSERT|DELETE)/.test(sql)),
        false,
      );
    }
  } finally {
    postgresClient.getChatwootConnection = previous;
  }
});

test('missing/ambiguous/cross-peer/wrong-direction/deleted/private/stale-pointer/blobless originals refuse preservation', async () => {
  const previous = postgresClient.getChatwootConnection;
  const { original, envelope, target } = fixture();
  try {
    for (const rows of [
      [],
      [target, target],
      [{ ...target, provider_peer: 'foreign@g.us' }],
      [{ ...target, message_type: 1 }],
      [{ ...target, content_attributes: { deleted: true } }],
      [{ ...target, private: true }],
      [{ ...target, id: 315 }],
      [{ ...target, display_id: 41 }],
      [{ ...target, attachments: [{ blob: null }] }],
      [{ ...target, content: '', attachments: [] }],
    ]) {
      postgresClient.getChatwootConnection = (() => ({ query: async () => ({ rows }) })) as any;
      await assert.rejects(() =>
        chatwootImport.captureIgnoredHistoryEdit(
          envelope,
          original,
          99,
          { accountId: '1' } as any,
          'unavailable',
          'Retained encrypted edit content is unsupported',
        ),
      );
    }
  } finally {
    postgresClient.getChatwootConnection = previous;
  }
});
