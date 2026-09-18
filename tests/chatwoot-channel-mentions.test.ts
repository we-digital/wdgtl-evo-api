import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWhatsappGroupParticipantSnapshots,
  channelMentionsFromAttributes,
  extractWhatsappMentionJids,
  normalizeWhatsappJid,
  stripWhatsappMentionMarkdown,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-channel-mentions';

test('normalizes bare digits and jids', () => {
  assert.equal(normalizeWhatsappJid('628123456789'), '628123456789@s.whatsapp.net');
  assert.equal(normalizeWhatsappJid('628123456789@s.whatsapp.net'), '628123456789@s.whatsapp.net');
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
  assert.equal(stripWhatsappMentionMarkdown(content), 'hi @Alice');
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
