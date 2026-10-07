import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { captureMissingPlaintextEditOriginal } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ignored-history-edit';

function source(extended = false) {
  return {
    id: 'native-edit',
    instanceId: 'native-instance',
    key: { id: 'edit', remoteJid: '120363123456@g.us', fromMe: false },
    messageType: 'protocolMessage',
    messageTimestamp: 1700000000,
    status: 'DELIVERY_ACK',
    message: {
      protocolMessage: {
        type: 14,
        key: { id: 'original', remoteJid: '120363123456@g.us', fromMe: false },
        timestampMs: { low: -807049216, high: 395, unsigned: false },
        editedMessage: extended
          ? {
              extendedTextMessage: {
                text: 'synthetic edited text',
                contextInfo: { mentionedJid: [] },
                endCardTiles: [],
              },
            }
          : { conversation: 'synthetic edited text' },
      },
      messageContextInfo: { threadId: [], messageSecret: Buffer.alloc(32, 1).toString('base64') },
    },
  } as any;
}

test('known plaintext edit has truthful version-bound missing-original disposition', async () => {
  for (const extended of [false, true]) {
    const envelope = source(extended);
    assert.equal(classifyCachedHistoryRecord(envelope, false), 'plaintext_edit');
    const proof = await captureMissingPlaintextEditOriginal(
      envelope,
      {
        findUnique: async (args) => {
          assert.deepEqual(args, { where: { id: envelope.id } });
          return envelope;
        },
        findMany: async (args) => {
          assert.deepEqual(args, {
            where: { instanceId: envelope.instanceId, key: { path: ['id'], equals: 'original' } },
          });
          return [];
        },
      },
      1,
      42,
    );
    assert.equal(proof.version, 4);
    assert.equal(proof.kind, 'ignored_missing_plaintext_original');
    assert.equal(proof.disposition, 'ignored_unavailable_edit');
    assert.equal(proof.destinationState, 'unqualified');
    assert.equal(proof.nativeTargetState, 'missing');
    assert.equal(proof.targetCandidatesNativeJSON, '[]');
    assert.equal(proof.targetCandidatesNativeSHA256, createHash('sha256').update('[]').digest('hex'));
    assert.equal(proof.sourceNativeVersionSHA256, createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
    assert.equal('destinationAbsent' in proof, false);
  }
});

test('available original is not an ignored edit; ambiguity and source rotation stop', async () => {
  const envelope = source();
  const original = { ...envelope, id: 'native-original', key: { ...envelope.key, id: 'original' } };
  assert.equal(
    await captureMissingPlaintextEditOriginal(
      envelope,
      {
        findUnique: async () => envelope,
        findMany: async () => [original],
      },
      1,
      42,
    ),
    undefined,
  );
  await assert.rejects(
    captureMissingPlaintextEditOriginal(
      envelope,
      {
        findUnique: async () => envelope,
        findMany: async () => [original, { ...original, id: 'duplicate-native' }],
      },
      1,
      42,
    ),
    /ambiguous/,
  );
  await assert.rejects(
    captureMissingPlaintextEditOriginal(
      envelope,
      {
        findUnique: async () => ({ ...envelope, messageTimestamp: envelope.messageTimestamp + 1 }),
        findMany: async () => [],
      },
      1,
      42,
    ),
    /rotated/,
  );
});

test('revokes, unknown fields, mixed payloads and wrong target peer/direction cannot become ignored edits', async () => {
  const changes = [
    (s: any) => {
      s.message.protocolMessage.type = 0;
    },
    (s: any) => {
      s.message.protocolMessage.type = 99;
    },
    (s: any) => {
      s.message.protocolMessage.key.remoteJid = '120363999999@g.us';
    },
    (s: any) => {
      s.message.protocolMessage.key.fromMe = true;
    },
    (s: any) => {
      s.message.protocolMessage.key.id = s.key.id;
    },
    (s: any) => {
      s.message.protocolMessage.unrecognized = true;
    },
    (s: any) => {
      s.message.protocolMessage.editedMessage = { conversation: '' };
    },
    (s: any) => {
      s.message.protocolMessage.editedMessage = { conversation: 'text', imageMessage: {} };
    },
    (s: any) => {
      s.message.protocolMessage.timestampMs = { low: 0, high: -1, unsigned: false };
    },
    (s: any) => {
      s.message.imageMessage = {};
    },
  ];
  for (const mutate of changes) {
    const envelope = source();
    mutate(envelope);
    assert.throws(() => classifyCachedHistoryRecord(envelope, false));
    await assert.rejects(
      captureMissingPlaintextEditOriginal(
        envelope,
        {
          findUnique: async () => {
            assert.fail('invalid envelope provenance read');
          },
          findMany: async () => {
            assert.fail('invalid envelope target query');
          },
        },
        1,
        42,
      ),
    );
  }
});
