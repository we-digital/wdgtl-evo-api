import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatwootReplyReferences,
  compactReplyToIds,
  extractWhatsappReplyQuotedMessage,
  extractWhatsappReplyStanzaId,
  whatsappReplyQuoteSnapshotText,
  stripChatwootWhatsappSourceId,
  toChatwootWhatsappSourceId,
  whatsappMessageText,
  whatsappQuotedMessageContent,
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

test('extracts selected WhatsApp quote text from wrapped reply context', () => {
  const reply = {
    message: {
      ephemeralMessage: {
        message: {
          extendedTextMessage: {
            text: 'answer',
            contextInfo: {
              stanzaId: 'EPH2',
              quotedMessage: { extendedTextMessage: { text: 'выбранный 🌍 фрагмент' } },
            },
          },
        },
      },
    },
  };

  assert.deepEqual(extractWhatsappReplyQuotedMessage(reply), {
    extendedTextMessage: { text: 'выбранный 🌍 фрагмент' },
  });
  assert.equal(whatsappMessageText(extractWhatsappReplyQuotedMessage(reply)), 'выбранный 🌍 фрагмент');
  assert.equal(
    whatsappReplyQuoteSnapshotText(reply, { conversation: 'полное исходное сообщение' }),
    'выбранный 🌍 фрагмент',
  );
  assert.equal(whatsappReplyQuoteSnapshotText(reply, { conversation: 'выбранный 🌍 фрагмент' }), null);
  assert.equal(whatsappReplyQuoteSnapshotText(reply, null), 'выбранный 🌍 фрагмент');
  assert.equal(
    whatsappReplyQuoteSnapshotText(reply, {
      conversation: 'parent text edited after the reply',
    }),
    'выбранный 🌍 фрагмент',
  );
});

test('replaces only quoted WhatsApp content while retaining whole-reply compatibility', () => {
  const original = { imageMessage: { caption: 'full caption', url: 'https://example.invalid/media' } };
  assert.equal(whatsappQuotedMessageContent(original), original);
  assert.deepEqual(whatsappQuotedMessageContent(original, 'selected caption'), {
    conversation: 'selected caption',
  });
});

test('compacts null reply ids', () => {
  assert.deepEqual(compactReplyToIds({ in_reply_to: null, in_reply_to_external_id: null }), {});
  assert.deepEqual(compactReplyToIds({ in_reply_to: 42, in_reply_to_external_id: 'WAID:X' }), {
    in_reply_to: 42,
    in_reply_to_external_id: 'WAID:X',
  });
  assert.deepEqual(compactReplyToIds({ in_reply_to: 42, in_reply_to_external_id: 'WAID:X', quote_text: 'часть' }), {
    in_reply_to: 42,
    in_reply_to_external_id: 'WAID:X',
    quote_text: 'часть',
  });
});

test('normalizes Chatwoot Evolution WAID source ids', () => {
  assert.equal(toChatwootWhatsappSourceId('ABC123'), 'WAID:ABC123');
  assert.equal(toChatwootWhatsappSourceId('WAID:ABC123'), 'WAID:ABC123');
  assert.equal(toChatwootWhatsappSourceId('  '), null);
  assert.equal(stripChatwootWhatsappSourceId('WAID:ABC123'), 'ABC123');
  assert.equal(stripChatwootWhatsappSourceId('ABC123'), 'ABC123');
});

test('retains both Chatwoot and provider reply identities for durable quote lookup', () => {
  assert.deepEqual(
    chatwootReplyReferences({
      in_reply_to: '42',
      in_reply_to_external_id: 'WAID:ABC123',
      quote_text: 'selected',
    }),
    { chatwootMessageId: 42, whatsappMessageId: 'ABC123', quoteText: 'selected' },
  );
  assert.deepEqual(chatwootReplyReferences({ in_reply_to: 'bad', in_reply_to_external_id: '' }), {});
});
