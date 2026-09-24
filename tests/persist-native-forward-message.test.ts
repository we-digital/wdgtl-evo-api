import assert from 'node:assert/strict';
import test from 'node:test';

import { persistNativeForwardMessage } from '../src/api/integrations/channel/whatsapp/persist-native-forward-message';
import { BaileysStartupService } from '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service';

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

for (const repositoryFailure of ['read', 'create'] as const) {
  test(`retains the provider acknowledgment when post-transport repository ${repositoryFailure} fails`, async () => {
    let providerSends = 0;
    const wa: any = Object.create(BaileysStartupService.prototype);
    wa.instance = { id: 'instance-1', name: 'test-instance' };
    wa.logger = { error() {} };
    wa.configService = {
      get: () => ({ SAVE_DATA: { NEW_MESSAGE: true } }),
    };
    wa.prepareMessage = (message: any) => message;
    wa.client = {
      sendMessage: async (_jid: string, _content: unknown, options: { messageId?: string }) => {
        providerSends += 1;
        return {
          key: { id: options.messageId, remoteJid: '120363000000000000@g.us', fromMe: true },
          message: { conversation: 'forwarded' },
          messageTimestamp: 1,
        };
      },
    };
    wa.prismaRepository = {
      message: {
        findFirst: async () => {
          if (repositoryFailure === 'read') throw new Error('repository read failed');
          return null;
        },
        create: async () => {
          throw new Error('repository create failed');
        },
      },
    };

    const result = await wa.nativeForwardMessage(
      '120363000000000000@g.us',
      { key: { id: 'SOURCE-1' }, message: { conversation: 'source' } },
      { messageId: 'WDNATIVEFORWARD0001' },
    );

    assert.equal(result.key.id, 'WDNATIVEFORWARD0001');
    assert.equal(providerSends, 1);
  });
}

test('rejects before transport when the durable queue fence cannot be established', async () => {
  let providerSends = 0;
  const wa: any = Object.create(BaileysStartupService.prototype);
  wa.instance = { id: 'instance-1', name: 'test-instance' };
  wa.logger = { error() {} };
  wa.configService = { get: () => ({ SAVE_DATA: { NEW_MESSAGE: false } }) };
  wa.client = {
    sendMessage: async () => {
      providerSends += 1;
      return null;
    },
  };

  await assert.rejects(
    wa.nativeForwardMessage(
      '120363000000000000@g.us',
      { key: { id: 'SOURCE-1' }, message: { conversation: 'source' } },
      {
        messageId: 'WDNATIVEFORWARD0002',
        beforeTransport: async () => {
          throw new Error('transport fence failed');
        },
      },
    ),
    /transport fence failed/,
  );
  assert.equal(providerSends, 0);
});
