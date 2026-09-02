import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatwootIngressAttributes,
  classifyChatwootIngressScope,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';

test('classifies direct WhatsApp and alternate LID identities', () => {
  assert.equal(classifyChatwootIngressScope({ key: { remoteJid: '628123@s.whatsapp.net' } }), 'direct');
  assert.equal(
    classifyChatwootIngressScope({
      key: { remoteJid: '123@lid', remoteJidAlt: '628123@s.whatsapp.net' },
    }),
    'direct',
  );
});

test('classifies groups and broadcasts without treating unknown identities as direct', () => {
  assert.equal(classifyChatwootIngressScope({ key: { remoteJid: '123@g.us' } }), 'group');
  assert.equal(classifyChatwootIngressScope({ key: { remoteJid: 'status@broadcast' } }), 'broadcast');
  assert.equal(classifyChatwootIngressScope({ key: { remoteJid: '123@lid' } }), 'unknown');
  assert.equal(classifyChatwootIngressScope({ key: {} }), 'unknown');
});

test('builds a versioned ingress contract for Chatwoot content attributes', () => {
  assert.deepEqual(buildChatwootIngressAttributes({ key: { remoteJid: '123@g.us' } }), {
    we_digital_ingress: {
      version: 1,
      provider: 'evo_whatsapp',
      scope: 'group',
    },
  });
});
