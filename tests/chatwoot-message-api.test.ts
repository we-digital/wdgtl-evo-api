import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  getExactChatwootMessage,
  isChatwootOutgoingMessageType,
  unwrapChatwootPayload,
  updateChatwootMessageJson,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-message-api';

test('uses the bounded exact-message endpoint and application/json provider-delivery wire shape', async () => {
  const captured: Array<{ method?: string; url?: string; contentType?: string; token?: string; body: string }> = [];
  const exactSnapshot = {
    contract_version: 1,
    account_id: 7,
    inbox_id: 58,
    conversation_id: 42,
    message_id: 314,
    message_type: 1,
    message_type_name: 'outgoing',
    deleted: false,
    destination: '628123',
    contact_inbox_source_id: 'source-1',
    route: { inbox_name: 'WA - Test', channel_type: 'Channel::Api', binding: { version: 2 } },
  };
  const acknowledgement = {
    id: 314,
    status: 'sent',
    source_id: 'WAID:part-0',
    provider_delivery: {
      contract_version: 1,
      acknowledged: true,
      message_confirmed: true,
      part_key: 'part-0',
      part_index: 0,
      part_count: 1,
      acknowledged_part_count: 1,
      source_ids: [{ part_key: 'part-0', part_index: 0, source_id: 'WAID:part-0' }],
    },
  };
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      captured.push({
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        token: request.headers['api-access-token'] as string,
        body,
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ meta: { scoped: true }, payload: request.method === 'GET' ? exactSnapshot : acknowledgement }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const config = {
      basePath: `http://127.0.0.1:${address.port}`,
      with_credentials: true,
      credentials: 'include' as const,
      headers: { 'api-access-token': 'test-token' },
    };
    const read = await getExactChatwootMessage(config, 7, 58, 42, 314);
    const patch = {
      status: 'sent',
      source_id: 'WAID:part-0',
      external_error: null,
      provider_delivery: { part_key: 'part-0', part_index: 0, part_count: 1 },
    };
    const updated = await updateChatwootMessageJson(config, 7, 42, 314, patch);

    assert.deepEqual(unwrapChatwootPayload(read), exactSnapshot);
    assert.equal(isChatwootOutgoingMessageType(exactSnapshot.message_type), true);
    assert.deepEqual(unwrapChatwootPayload(updated), acknowledgement);
    assert.deepEqual(captured, [
      {
        method: 'GET',
        url: '/api/v1/accounts/7/inboxes/58/conversations/42/messages/314',
        contentType: undefined,
        token: 'test-token',
        body: '',
      },
      {
        method: 'PATCH',
        url: '/api/v1/accounts/7/conversations/42/messages/314',
        contentType: 'application/json',
        token: 'test-token',
        body: JSON.stringify(patch),
      },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
