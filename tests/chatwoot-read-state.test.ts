import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHATWOOT_READ_STATE_HEADER,
  buildExternalReadRequest,
  buildWhatsAppReadCursor,
  selectWhatsAppOwnerReadTimestamps,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-read-state';

test('selects only self-device group reads and keeps the latest timestamp', () => {
  const timestamps = selectWhatsAppOwnerReadTimestamps([
    {
      key: { remoteJid: '120363@g.us', id: 'incoming-1', fromMe: false },
      receipt: { readTimestamp: 100, userJid: 'owner@s.whatsapp.net' },
    },
    {
      key: { remoteJid: '120363@g.us', id: 'incoming-2', fromMe: false },
      receipt: { readTimestamp: 120, userJid: 'owner@s.whatsapp.net' },
    },
    {
      key: { remoteJid: '120363@g.us', id: 'outgoing-1', fromMe: true },
      receipt: { readTimestamp: 130, userJid: 'participant@s.whatsapp.net' },
    },
    {
      key: { remoteJid: 'contact@s.whatsapp.net', id: 'incoming-3', fromMe: false },
      receipt: { readTimestamp: 140, userJid: 'owner@s.whatsapp.net' },
    },
  ]);

  assert.deepEqual(timestamps, { '120363@g.us': 120 });
});

test('builds a stable WhatsApp cursor and dedicated-token-only request', () => {
  const sourceCursor = buildWhatsAppReadCursor({
    instanceId: 'instance-1',
    remoteJid: '120363@g.us',
    readTimestamp: 120,
    chatwootMessageId: 99,
  });
  const request = buildExternalReadRequest({
    baseUrl: 'https://cw.example/',
    accountId: 1,
    conversationId: 42,
    messageId: 99,
    sourceCursor,
    token: 'dedicated-token',
  });

  assert.equal(sourceCursor, 'wa-read:instance-1:120363@g.us:120:99');
  assert.equal(request.url, 'https://cw.example/api/v1/accounts/1/conversations/42/external_read');
  assert.deepEqual(request.headers, { [CHATWOOT_READ_STATE_HEADER]: 'dedicated-token' });
  assert.equal('api_access_token' in request.headers, false);
  assert.deepEqual(request.data, {
    message_id: 99,
    source: 'whatsapp',
    source_cursor: sourceCursor,
  });
});
