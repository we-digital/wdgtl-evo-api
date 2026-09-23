import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactReplyToIds,
  extractWhatsappReplyStanzaId,
  stripChatwootWhatsappSourceId,
  toChatwootWhatsappSourceId,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-reply-context';

test('extracts stanzaId from extendedTextMessage contextInfo', () => {
  assert.equal(
    extractWhatsappReplyStanzaId({
      message: {
        extendedTextMessage: {
          text: 'reply',
          contextInfo: { stanzaId: 'ABC123' },
        },
      },
    }),
    'ABC123',
  );
});

test('extracts stanzaId from imageMessage and other media content keys', () => {
  assert.equal(
    extractWhatsappReplyStanzaId({
      message: {
        imageMessage: {
          caption: 'photo reply',
          contextInfo: { stanzaId: 'IMG99' },
        },
      },
    }),
    'IMG99',
  );
});

test('extracts stanzaId from top-level contextInfo used by some upserts', () => {
  assert.equal(
    extractWhatsappReplyStanzaId({
      contextInfo: { stanzaId: 'TOP1' },
      message: { conversation: 'hi' },
    }),
    'TOP1',
  );
});

test('extracts stanzaId from view-once / ephemeral wrappers', () => {
  assert.equal(
    extractWhatsappReplyStanzaId({
      message: {
        viewOnceMessage: {
          message: {
            imageMessage: {
              contextInfo: { stanzaId: 'VO1' },
            },
          },
        },
      },
    }),
    'VO1',
  );
  assert.equal(
    extractWhatsappReplyStanzaId({
      message: {
        ephemeralMessage: {
          message: {
            extendedTextMessage: {
              text: 'hi',
              contextInfo: { stanzaId: 'EPH1' },
            },
          },
        },
      },
    }),
    'EPH1',
  );
});

test('returns null when there is no reply context', () => {
  assert.equal(extractWhatsappReplyStanzaId({ message: { conversation: 'plain' } }), null);
  assert.equal(extractWhatsappReplyStanzaId(null), null);
});

test('compacts null reply ids', () => {
  assert.deepEqual(
    compactReplyToIds({ in_reply_to: null, in_reply_to_external_id: null }),
    {},
  );
  assert.deepEqual(
    compactReplyToIds({ in_reply_to: 42, in_reply_to_external_id: 'WAID:X' }),
    { in_reply_to: 42, in_reply_to_external_id: 'WAID:X' },
  );
});

test('normalizes Chatwoot Evolution WAID source ids', () => {
  assert.equal(toChatwootWhatsappSourceId('ABC123'), 'WAID:ABC123');
  assert.equal(toChatwootWhatsappSourceId('WAID:ABC123'), 'WAID:ABC123');
  assert.equal(toChatwootWhatsappSourceId('  '), null);
  assert.equal(stripChatwootWhatsappSourceId('WAID:ABC123'), 'ABC123');
  assert.equal(stripChatwootWhatsappSourceId('ABC123'), 'ABC123');
});
