import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveWhatsappReactionKey,
  resolveWhatsappReactionRemoteJid,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-reaction-key';

test('prefers stored Baileys key when present', () => {
  assert.deepEqual(
    resolveWhatsappReactionKey({
      storedKey: {
        id: 'ABC',
        remoteJid: '6281@s.whatsapp.net',
        fromMe: true,
      },
      sourceId: 'WAID:OTHER',
    }),
    {
      id: 'ABC',
      remoteJid: '6281@s.whatsapp.net',
      fromMe: true,
      participant: undefined,
    },
  );
});

test('falls back to WAID source_id + contact inbox jid', () => {
  assert.deepEqual(
    resolveWhatsappReactionKey({
      sourceId: 'WAID:MSG99',
      messageType: 'incoming',
      body: {
        conversation: {
          contact_inbox: { source_id: '628123456789@s.whatsapp.net' },
        },
      },
    }),
    {
      id: 'MSG99',
      remoteJid: '628123456789@s.whatsapp.net',
      fromMe: false,
      participant: undefined,
    },
  );
});

test('builds jid from phone number when needed', () => {
  assert.equal(
    resolveWhatsappReactionRemoteJid({
      conversation: { meta: { sender: { phone_number: '+62 812-345' } } },
    }),
    '62812345@s.whatsapp.net',
  );
});

test('returns null when id or jid cannot be resolved', () => {
  assert.equal(resolveWhatsappReactionKey({ sourceId: 'WAID:ONLY' }), null);
  assert.equal(
    resolveWhatsappReactionKey({
      body: { conversation: { contact_inbox: { source_id: '6281@s.whatsapp.net' } } },
    }),
    null,
  );
});
