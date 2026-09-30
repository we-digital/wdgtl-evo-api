import assert from 'node:assert/strict';
import test from 'node:test';

test('WhatsApp edits update the original in both directions without creating a duplicate or rebinding it', async (t) => {
  const serverModulePath = require.resolve('../src/api/server.module.ts');
  const previous = require.cache[serverModulePath];
  require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  t.after(() => {
    if (previous) require.cache[serverModulePath] = previous;
    else delete require.cache[serverModulePath];
  });
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service = Object.create(ChatwootService.prototype) as any;
  service.waMonitor = { waInstances: { synthetic: {} } };
  service.clientCw = async () => ({ client: {}, provider: { accountId: '1', ignoreJids: [] } });
  service.logger = {
    info() {},
    warn() {},
    error(error: Error) {
      throw error;
    },
  };
  service.createMessage = async () => {
    assert.fail('An edit must not create a message');
  };
  const requests: any[] = [];
  service.privilegedChatwootRequest = async (_provider: unknown, request: unknown) => {
    requests.push(request);
  };
  for (const fromMe of [false, true]) {
    const original = { chatwootConversationId: 40, chatwootMessageId: 314, key: { id: 'provider-id', fromMe } };
    service.getMessageByKeyId = async () => original;
    for (const event of ['messages.edit', 'send.message.update']) {
      await service.eventWhatsapp(
        event,
        { instanceName: 'synthetic', instanceId: 'instance-1' },
        {
          key: { id: 'provider-id', remoteJid: 'synthetic@s.whatsapp.net' },
          editedMessage: { conversation: '  edited text  ' },
        },
      );
      const request = requests.at(-1);
      assert.equal(request.path, '/api/v1/accounts/1/conversations/40/messages/314/edit');
      assert.deepEqual(request.data, {
        content: '  edited text  ',
        source_id: 'WAID:provider-id',
        message_type: fromMe ? 'outgoing' : 'incoming',
        skip_native: true,
        provider_source: 'whatsapp',
      });
      assert.equal(original.chatwootMessageId, 314);
    }
  }
  assert.equal(requests.length, 4);
});

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';

test('backfill applies a retained edit and checks persistence before accepting an existing source', async () => {
  const original = postgresClient.getChatwootConnection;
  let content = 'before';
  let edited = false;
  let calls = 0;
  try {
    postgresClient.getChatwootConnection = (() => ({
      query: async () => ({
        rows: [{ id: 314, message_type: 0, display_id: 40, content, content_attributes: JSON.stringify({ edited }) }],
      }),
    })) as any;
    const stored = {
      key: { id: 'provider-id', fromMe: false },
      message: { conversation: 'after' },
      status: 'READ',
    } as any;
    const evolution = {
      applyWhatsappProviderEdit: async (_provider: unknown, target: any) => {
        calls++;
        content = target.content;
        edited = true;
      },
    } as any;
    await chatwootImport.reconcileProviderHistoryEdits([stored], 99, { accountId: '1' } as any, evolution);
    assert.equal(content, 'after');
    await chatwootImport.reconcileProviderHistoryEdits([stored], 99, { accountId: '1' } as any, evolution);
    assert.equal(calls, 1);
    content = 'stale';
    evolution.applyWhatsappProviderEdit = async () => {};
    await assert.rejects(
      chatwootImport.reconcileProviderHistoryEdits([stored], 99, { accountId: '1' } as any, evolution),
      /not persisted/,
    );
  } finally {
    postgresClient.getChatwootConnection = original;
  }
});
