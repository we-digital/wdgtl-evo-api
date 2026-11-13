process.env.CHATWOOT_AVATAR_SYNC = 'off';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import '@api/server.module';
import { chatwootIgnoresJid } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import {
  busInstanceEnabled,
  busOutboundPeerAllowed,
  busPartition,
  busSubject,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-bus';

test('bus partition equals Chatwoot ProviderBus.partition_for reference values', () => {
  assert.equal(busPartition('inst-1|1234@s.whatsapp.net'), 5);
  assert.equal(busPartition('inst-1|120363431310229945@g.us'), 2);
  assert.equal(busPartition('acc1:inbox4:-100123'), 9);
  assert.equal(busPartition('é-unicode'), 7);
});

test('a chat always maps to one ordered subject of its instance', () => {
  const subject = busSubject('inst-1', '120363431310229945@g.us');
  assert.equal(subject, 'wa.in.p02.inst-1');
  assert.equal(busSubject('inst-1', '120363431310229945@g.us'), subject);
});

test('bus delivery is opt-in per instance and needs a bus URL', () => {
  const url = process.env.CHATWOOT_BUS_URL;
  try {
    delete process.env.CHATWOOT_BUS_URL;
    assert.equal(busInstanceEnabled('p-mila', '*'), false);
    process.env.CHATWOOT_BUS_URL = 'nats://bus:4222';
    assert.equal(busInstanceEnabled('p-mila', 'p-mila, d-kitas'), true);
    assert.equal(busInstanceEnabled('t-test', 'p-mila, d-kitas'), false);
    assert.equal(busInstanceEnabled('t-test', '*'), true);
    assert.equal(busInstanceEnabled('t-test', ''), false);
  } finally {
    if (url === undefined) delete process.env.CHATWOOT_BUS_URL;
    else process.env.CHATWOOT_BUS_URL = url;
  }
});

test('outbound peer allowlist: empty allows all, otherwise only listed peers', () => {
  assert.equal(busOutboundPeerAllowed('1@g.us', ''), true);
  assert.equal(busOutboundPeerAllowed('1@g.us', '1@g.us,2@g.us'), true);
  assert.equal(busOutboundPeerAllowed('3@g.us', '1@g.us,2@g.us'), false);
  assert.equal(busOutboundPeerAllowed(null, '1@g.us'), false);
  assert.equal(busOutboundPeerAllowed('3@g.us', '*'), true);
});

test('ignored chats are refused before the ledger with the processWhatsappEvent rules', () => {
  assert.equal(chatwootIgnoresJid(['@g.us'], '120@g.us'), true);
  assert.equal(chatwootIgnoresJid(['@g.us'], '62811@s.whatsapp.net'), false);
  assert.equal(chatwootIgnoresJid(['@s.whatsapp.net'], '62811@s.whatsapp.net'), true);
  assert.equal(chatwootIgnoresJid(['120@g.us'], '120@g.us'), true);
  assert.equal(chatwootIgnoresJid(['120@g.us'], '121@g.us'), false);
  assert.equal(chatwootIgnoresJid([], '120@g.us'), false);
  assert.equal(chatwootIgnoresJid(null, '120@g.us'), false);
});
