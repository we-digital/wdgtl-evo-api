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

test('ignores an API contact-inbox UUID and uses a validated sender identifier', () => {
  assert.equal(
    resolveWhatsappReactionRemoteJid({
      conversation: {
        contact_inbox: { source_id: '0c911285-2964-4a5a-8ac4-b76fcb21f002' },
        meta: { sender: { identifier: '628123456789@lid' } },
      },
    }),
    '628123456789@lid',
  );
});

test('rejects an API contact-inbox UUID without a valid WhatsApp identity', () => {
  assert.equal(
    resolveWhatsappReactionRemoteJid({
      conversation: {
        contact_inbox: { source_id: '0c911285-2964-4a5a-8ac4-b76fcb21f002' },
        meta: { sender: { identifier: 'opaque-contact', phone_number: 'not-a-phone' } },
      },
    }),
    null,
  );
});

test('rejects unsupported jid domains instead of forwarding them to Baileys', () => {
  assert.equal(
    resolveWhatsappReactionRemoteJid({
      conversation: { contact_inbox: { source_id: '628123456789@example.com' } },
    }),
    null,
  );
});

test('rejects a reconstructed inbound group key without the original participant', () => {
  assert.equal(
    resolveWhatsappReactionKey({
      sourceId: 'WAID:MSG99',
      messageType: 'incoming',
      body: {
        conversation: {
          contact_inbox: { source_id: '0c911285-2964-4a5a-8ac4-b76fcb21f002' },
          meta: { sender: { identifier: '120363012345678901@g.us' } },
        },
      },
    }),
    null,
  );
});

test('preserves complete stored inbound group keys with PN and LID participants', () => {
  for (const participant of ['628123456789@s.whatsapp.net', '15551234567890@lid']) {
    assert.deepEqual(
      resolveWhatsappReactionKey({
        storedKey: {
          id: 'GROUP-MSG',
          remoteJid: '120363012345678901@g.us',
          fromMe: false,
          participant,
        },
      }),
      {
        id: 'GROUP-MSG',
        remoteJid: '120363012345678901@g.us',
        fromMe: false,
        participant,
      },
    );
  }
});

test('rejects an incomplete stored inbound group key', () => {
  assert.equal(
    resolveWhatsappReactionKey({
      storedKey: {
        id: 'GROUP-MSG',
        remoteJid: '120363012345678901@g.us',
        fromMe: false,
      },
    }),
    null,
  );
  assert.equal(
    resolveWhatsappReactionKey({
      storedKey: {
        id: 'GROUP-MSG',
        remoteJid: '120363012345678901@g.us',
        fromMe: false,
        participant: '120363012345678901@g.us',
      },
    }),
    null,
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
