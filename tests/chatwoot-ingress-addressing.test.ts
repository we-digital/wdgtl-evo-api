import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatwootIngressAttributes,
  chatwootIngressLinkedAccountAddressing,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';

const own = ['628111:12@s.whatsapp.net', '900111:3@lid'];
const group = (message: Record<string, unknown>, fromMe = false) => ({
  key: { remoteJid: '120363@g.us', fromMe, id: 'M1', participant: '62899@s.whatsapp.net' },
  message,
});
const text = (contextInfo: Record<string, unknown>) => ({ extendedTextMessage: { text: 'hi', contextInfo } });

test('an @mention of our number or LID addresses the linked account', () => {
  assert.deepEqual(
    chatwootIngressLinkedAccountAddressing(group(text({ mentionedJid: ['628111@s.whatsapp.net'] })), own),
    { mentions_linked_account: true, replies_to_linked_account: false },
  );
  assert.equal(
    chatwootIngressLinkedAccountAddressing(group(text({ mentionedJid: ['900111@lid'] })), own)?.mentions_linked_account,
    true,
  );
  assert.equal(
    chatwootIngressLinkedAccountAddressing(group(text({ mentionedJid: ['62777@s.whatsapp.net'] })), own)
      ?.mentions_linked_account,
    false,
  );
});

test('a reply quoting our message addresses the linked account, a reply to someone else does not', () => {
  const ours = group(text({ stanzaId: 'Q1', participant: '628111:5@s.whatsapp.net' }));
  const theirs = group(text({ stanzaId: 'Q2', participant: '62777@s.whatsapp.net' }));
  assert.equal(chatwootIngressLinkedAccountAddressing(ours, own)?.replies_to_linked_account, true);
  assert.equal(chatwootIngressLinkedAccountAddressing(theirs, own)?.replies_to_linked_account, false);
  assert.equal(
    chatwootIngressLinkedAccountAddressing(group(text({ stanzaId: 'Q3', participant: '900111@lid' })), own)
      ?.replies_to_linked_account,
    true,
  );
});

test('flags are stamped only on inbound group messages and only when our identity is known', () => {
  const body = group(text({ mentionedJid: ['628111@s.whatsapp.net'] }));
  const stamped = buildChatwootIngressAttributes(body as any, null, false, own).we_digital_ingress as any;
  assert.equal(stamped.mentions_linked_account, true);
  assert.equal(stamped.replies_to_linked_account, false);

  const unknown = buildChatwootIngressAttributes(body as any, null, false, []).we_digital_ingress as any;
  assert.equal('mentions_linked_account' in unknown, false);

  const outbound = buildChatwootIngressAttributes(group(text({ mentionedJid: ['628111@s.whatsapp.net'] }), true) as any, null, false, own)
    .we_digital_ingress as any;
  assert.equal('mentions_linked_account' in outbound, false);

  const direct = buildChatwootIngressAttributes(
    { key: { remoteJid: '62899@s.whatsapp.net', fromMe: false, id: 'D1' }, message: { conversation: 'hi' } } as any,
    null,
    false,
    own,
  ).we_digital_ingress as any;
  assert.equal('mentions_linked_account' in direct, false);
});
