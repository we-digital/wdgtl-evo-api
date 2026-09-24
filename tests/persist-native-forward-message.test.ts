import assert from 'node:assert/strict';
import test from 'node:test';

import { persistNativeForwardMessage } from '../src/api/integrations/channel/whatsapp/persist-native-forward-message';

test('persists a native forward before Chatwoot binding lookup', async () => {
  const calls: string[] = [];
  const created = { id: 'stored' };
  const repository = {
    message: {
      findFirst: async () => {
        calls.push('find');
        return null;
      },
      create: async ({ data }) => {
        calls.push('create');
        assert.equal(data.key.id, 'WA-FORWARD-1');
        return created;
      },
    },
  };

  const result = await persistNativeForwardMessage({
    repository,
    instanceId: 'instance-1',
    messageRaw: { key: { id: 'WA-FORWARD-1' } },
  });

  assert.equal(result, created);
  assert.deepEqual(calls, ['find', 'create']);
});

test('reuses a provider row already persisted by a concurrent upsert', async () => {
  let finds = 0;
  const existing = { id: 'existing' };
  const repository = {
    message: {
      findFirst: async () => {
        finds += 1;
        return finds === 1 ? null : existing;
      },
      create: async () => {
        throw new Error('concurrent insert');
      },
    },
  };

  const result = await persistNativeForwardMessage({
    repository,
    instanceId: 'instance-1',
    messageRaw: { key: { id: 'WA-FORWARD-2' } },
  });

  assert.equal(result, existing);
  assert.equal(finds, 2);
});

test('rejects an unobservable native forward result', async () => {
  const repository = {
    message: {
      findFirst: async () => null,
      create: async () => null,
    },
  };

  await assert.rejects(
    persistNativeForwardMessage({ repository, instanceId: 'instance-1', messageRaw: { key: {} } }),
    /empty message key/,
  );
});
