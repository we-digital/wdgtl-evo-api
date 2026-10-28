import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertWhatsappMentionParticipants,
  buildWhatsappGroupParticipantSnapshots,
  channelMentionsFromAttributes,
  extractWhatsappMentionJids,
  formatIncomingWhatsappMentions,
  normalizeWhatsappJid,
  stripWhatsappMentionMarkdown,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-channel-mentions';

test('normalizes bare digits and jids', () => {
  assert.equal(normalizeWhatsappJid('628123456789'), '628123456789@s.whatsapp.net');
  assert.equal(normalizeWhatsappJid('628123456789@s.whatsapp.net'), '628123456789@s.whatsapp.net');
  assert.equal(normalizeWhatsappJid('628123456789:4@s.whatsapp.net'), '628123456789@s.whatsapp.net');
  assert.equal(normalizeWhatsappJid(''), '');
});

test('extracts mention jids from content_attributes and markdown', () => {
  const jid = '628111@s.whatsapp.net';
  const encoded = encodeURIComponent(jid);
  const content = `hi [@Alice](mention://whatsapp/${encoded}/Alice)`;
  const jids = extractWhatsappMentionJids({
    content,
    content_attributes: {
      channel_mentions: [{ provider: 'whatsapp', id: jid, display: '@Alice' }],
    },
  });
  assert.deepEqual(jids, [jid]);
  assert.equal(stripWhatsappMentionMarkdown(content), 'hi @628111');
});

test('channelMentionsFromAttributes drops nullish and incomplete entries', () => {
  const mentions = channelMentionsFromAttributes({
    channel_mentions: [
      null,
      { provider: 'whatsapp' },
      { provider: 'whatsapp', id: '628222@s.whatsapp.net', display: '@Bob' },
      'noise',
    ],
  });
  assert.deepEqual(mentions, [
    { provider: 'whatsapp', id: '628222@s.whatsapp.net', display: '@Bob' },
  ]);
});

test('buildWhatsappGroupParticipantSnapshots skips empty ids', () => {
  const snapshots = buildWhatsappGroupParticipantSnapshots([
    { id: '', name: 'skip' },
    { id: '628333', name: 'Carol', phoneNumber: '+62 8333' },
  ]);
  assert.deepEqual(snapshots, [
    { id: '628333@s.whatsapp.net', name: 'Carol', phone: '628333' },
  ]);
});

test('formats only exact provider-mentioned participants as structured Chatwoot mentions', () => {
  const participants = [
    { id: '628111@s.whatsapp.net', name: 'Alice', phone: '628111' },
    { id: '628222@s.whatsapp.net', name: 'Bob', phone: '628222' },
  ];

  assert.equal(
    formatIncomingWhatsappMentions('hello @628111 and @628222', ['628111@s.whatsapp.net'], participants),
    'hello [@Alice](mention://whatsapp/628111%40s.whatsapp.net/Alice) and @628222',
  );
  assert.equal(
    formatIncomingWhatsappMentions('hello @999999', ['999999@s.whatsapp.net'], participants),
    'hello @999999',
  );
  assert.equal(
    formatIncomingWhatsappMentions('keep @6281119 intact', ['628111@s.whatsapp.net'], participants),
    'keep @6281119 intact',
  );
});

test('matches a phone mention to a LID roster participant and emits the roster identity', () => {
  assert.equal(
    formatIncomingWhatsappMentions(
      'hello @628111',
      ['628111@s.whatsapp.net'],
      [{ id: '1555000111@lid', name: 'Alice', phone: '628111' }],
    ),
    'hello [@Alice](mention://whatsapp/1555000111%40lid/Alice)',
  );
});

test('does not invent a phone number from an unknown LID', () => {
  assert.deepEqual(buildWhatsappGroupParticipantSnapshots([{ id: '1555111@lid' }]), [
    { id: '1555111@lid', name: 'WhatsApp participant' },
  ]);
});

test('matches native LID and PN tokens without changing unmentioned numbers', () => {
  const roster = [{ id: '1555111@lid', name: 'Alice', phone: '628111' }];
  const markup = '[@Alice](mention://whatsapp/1555111%40lid/Alice)';
  assert.equal(formatIncomingWhatsappMentions('@1555111 @628111 @15551119', ['1555111@lid'], roster), `${markup} ${markup} @15551119`);
});

test('rejects staff tokens and validates current group membership including known PN aliases', () => {
  assert.throws(() => stripWhatsappMentionMarkdown('[@Staff](mention://user/1/Staff)'), /Only WhatsApp/);
  assert.throws(() => assertWhatsappMentionParticipants(['1555111@lid'], []), /current group participant/);
  assert.doesNotThrow(() => assertWhatsappMentionParticipants(['628111@s.whatsapp.net'], [{ id: '1555111@lid', phoneNumber: '628111@s.whatsapp.net' }]));
  assert.throws(() => assertWhatsappMentionParticipants(['777@g.us'], [{ id: '777@g.us' }]), /current group participant/);
});

test('serializes matching LID text and native mentionedJid through real Baileys without transport', async () => {
  const { generateWAMessageContent } = await import('baileys');
  const content = 'Hi [@Alice](mention://whatsapp/1555111%40lid/Alice)';
  const wire = await generateWAMessageContent({ text: stripWhatsappMentionMarkdown(content), mentions: extractWhatsappMentionJids({ content }) }, {});
  assert.equal(wire.extendedTextMessage?.text, 'Hi @1555111');
  assert.deepEqual(wire.extendedTextMessage?.contextInfo?.mentionedJid, ['1555111@lid']);
});
