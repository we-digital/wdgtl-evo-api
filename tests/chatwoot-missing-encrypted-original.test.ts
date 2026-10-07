import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { captureMissingEncryptedEditOriginal } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ignored-history-edit';

const envelope: any = {
  id: 'native-envelope',
  instanceId: 'owned-instance',
  messageTimestamp: 110,
  key: { id: 'envelope', remoteJid: '123456@g.us', fromMe: false },
  messageType: 'secretEncryptedMessage',
  message: {
    secretEncryptedMessage: {
      secretEncType: 2,
      targetMessageKey: { id: 'original', remoteJid: '123456@g.us', fromMe: true },
      encIv: Buffer.alloc(12, 8).toString('base64'),
      encPayload: Buffer.alloc(24, 7).toString('base64'),
    },
  },
};

test('zero native originals is a source-only ignored audit, with exact indexed selectors and all raw fields retained', async () => {
  const queries: any[] = [];
  const repository = {
    findUnique: async (args: any) => {
      queries.push(args);
      return structuredClone(envelope);
    },
    findMany: async (args: any) => {
      queries.push(args);
      return [];
    },
  };
  const proof = await captureMissingEncryptedEditOriginal(envelope, repository, 1, 39);
  assert.deepEqual(queries, [
    { where: { id: envelope.id } },
    { where: { instanceId: envelope.instanceId, key: { path: ['id'], equals: 'original' } } },
  ]);
  assert.equal(proof?.version, 3);
  assert.equal(proof?.targetCandidatesNativeJSON, '[]');
  assert.equal(proof?.sourceNativeJSON, JSON.stringify(envelope));
  assert.equal(proof?.sourceNativeVersionSHA256, createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
  assert.equal(proof?.targetSourceId, 'WAID:original');
  assert.equal(proof?.direction, 'incoming');
  assert.equal('targetNativeId' in proof!, false);
  assert.equal(
    Object.keys(proof!).some((key) => key.startsWith('destinationMessage')),
    false,
  );
});

test('available one follows original flow; ambiguity and any source rotation stop', async () => {
  for (const count of [0, 1, 2]) {
    const repository = { findUnique: async () => envelope, findMany: async () => Array(count).fill({ id: 'target' }) };
    if (count === 2)
      await assert.rejects(captureMissingEncryptedEditOriginal(envelope, repository, 1, 39), /ambiguous/);
    else assert.equal(Boolean(await captureMissingEncryptedEditOriginal(envelope, repository, 1, 39)), count === 0);
  }
  for (const changed of [
    { ...envelope, instanceId: 'foreign' },
    { ...envelope, messageTimestamp: 111 },
    { ...envelope, key: { ...envelope.key, fromMe: true } },
    { ...envelope, message: { ...envelope.message, extra: 'changed' } },
  ])
    await assert.rejects(
      captureMissingEncryptedEditOriginal(
        envelope,
        {
          findUnique: async () => changed,
          findMany: async () => [],
        },
        1,
        39,
      ),
      /rotated/,
    );
});

test('wrong source payload, malformed target and receiver authority never get ignored', async () => {
  for (const changed of [
    { ...envelope, messageType: 'conversation' },
    { ...envelope, messageTimestamp: 0 },
    {
      ...envelope,
      message: { secretEncryptedMessage: { ...envelope.message.secretEncryptedMessage, secretEncType: 1 } },
    },
    {
      ...envelope,
      message: {
        secretEncryptedMessage: { ...envelope.message.secretEncryptedMessage, targetMessageKey: { id: 'original' } },
      },
    },
  ])
    await assert.rejects(
      captureMissingEncryptedEditOriginal(
        changed,
        {
          findUnique: async () => changed,
          findMany: async () => [],
        },
        1,
        39,
      ),
    );
  for (const id of [0, -1, 1.5])
    await assert.rejects(
      captureMissingEncryptedEditOriginal(
        envelope,
        {
          findUnique: async () => envelope,
          findMany: async () => [],
        },
        1,
        id,
      ),
    );
});
