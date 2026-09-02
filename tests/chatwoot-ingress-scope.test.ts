import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatwootEvoRouteBinding,
  buildChatwootIngressAttributes,
  chatwootEvoRouteBindingsEqual,
  classifyChatwootIngressScope,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';

const route = buildChatwootEvoRouteBinding({
  inboxId: 58,
  instanceId: 'instance-uuid-p-mila',
  instanceName: 'p-mila',
  receiverNumber: '+62 811 1111 1111:4@s.whatsapp.net',
  signingKey: 'chatwoot-token',
});

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
  assert.ok(route);
  assert.equal(route.receiver_fingerprint.length, 64);
  assert.deepEqual(buildChatwootIngressAttributes({ key: { remoteJid: '123@g.us', fromMe: false } }, route), {
    we_digital_ingress: {
      version: 2,
      provider: 'evo_whatsapp',
      scope: 'group',
      direction: 'inbound',
      from_me: false,
      route,
    },
  });
});

test('binds the physical receiver without exposing its number and rejects incomplete routes', () => {
  assert.ok(route);
  assert.equal(JSON.stringify(route).includes('6281111111111'), false);
  assert.equal(
    chatwootEvoRouteBindingsEqual(route, { ...route, receiver_fingerprint: route.receiver_fingerprint }),
    true,
  );
  assert.equal(chatwootEvoRouteBindingsEqual(route, { ...route, instance_name: 't-test' }), false);
  assert.equal(
    buildChatwootEvoRouteBinding({
      inboxId: 58,
      instanceId: 'instance-uuid-p-mila',
      instanceName: 'p-mila',
      receiverNumber: null,
      signingKey: 'chatwoot-token',
    }),
    null,
  );
});

test('marks messages sent by the linked device as outbound', () => {
  assert.deepEqual(
    buildChatwootIngressAttributes({ key: { remoteJid: '628123@s.whatsapp.net', fromMe: true } }, route)
      .we_digital_ingress,
    {
      version: 2,
      provider: 'evo_whatsapp',
      scope: 'direct',
      direction: 'outbound',
      from_me: true,
      route,
    },
  );
});
