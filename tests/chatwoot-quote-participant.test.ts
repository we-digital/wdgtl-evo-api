import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

import {
  compactReplyToIds,
  extractWhatsappReplyParticipant,
  sameWhatsappUser,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-reply-context';

// we:Digital (owner, 2026-11-16): Chatwoot names the quoted author from contextInfo.participant.
const servicePath = '../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts';

const quoting = (participant: string, wrapper = false) => {
  const content = {
    extendedTextMessage: {
      text: 'reply',
      contextInfo: { stanzaId: 'Q1', participant, quotedMessage: { conversation: 'the scan' } },
    },
  };
  return {
    key: { remoteJid: '628111@s.whatsapp.net', fromMe: false },
    message: wrapper ? { ephemeralMessage: { message: content } } : content,
  };
};

test('reads the participant of the quoting contextInfo, without the device suffix', () => {
  assert.equal(extractWhatsappReplyParticipant(quoting('628111:12@s.whatsapp.net')), '628111@s.whatsapp.net');
  assert.equal(extractWhatsappReplyParticipant(quoting('19000@lid', true)), '19000@lid');
  assert.equal(extractWhatsappReplyParticipant(quoting('not-a-jid')), null);
  assert.equal(
    extractWhatsappReplyParticipant({
      message: { extendedTextMessage: { contextInfo: { participant: '1@s.whatsapp.net' } } },
    }),
    null,
    'a contextInfo without stanzaId is not a quote',
  );
});

test('compares WhatsApp users across devices and keeps the hint in the reply ids', () => {
  assert.equal(sameWhatsappUser('628999:3@s.whatsapp.net', '628999@s.whatsapp.net'), true);
  assert.equal(sameWhatsappUser('628999@s.whatsapp.net', '628999@lid'), false);
  assert.equal(sameWhatsappUser(null, null), false);
  assert.deepEqual(
    compactReplyToIds({
      in_reply_to: null,
      in_reply_to_external_id: 'WAID:Q1',
      quote_participant: { jid: '628111@s.whatsapp.net', from_me: false },
    }),
    { in_reply_to_external_id: 'WAID:Q1', quote_participant: { jid: '628111@s.whatsapp.net', from_me: false } },
  );
  assert.deepEqual(
    compactReplyToIds({ in_reply_to: null, in_reply_to_external_id: null, quote_participant: { from_me: false } }),
    {},
  );
});

test('getReplyToIds says whether the quoted message was ours', async (t) => {
  const modulePath = require.resolve('../src/api/server.module.ts');
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  // The NATS client is optional in local checkouts; this test never reaches the bus.
  const moduleApi = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const load = moduleApi._load;
  moduleApi._load = (request: string, ...rest: unknown[]) =>
    request.startsWith('@nats-io/') ? new Proxy({}, { get: () => () => ({}) }) : load(request, ...rest);
  t.after(() => {
    moduleApi._load = load;
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  });
  const { ChatwootService } = require(servicePath);
  const service = Object.create(ChatwootService.prototype) as any;
  const instance = { instanceName: 'synthetic', instanceId: 'instance-1', ownerJid: '628999@s.whatsapp.net' };
  service.waMonitor = {
    waInstances: { synthetic: { client: { user: { id: '628999:7@s.whatsapp.net', lid: '55500:7@lid' } } } },
  };
  let stored: any = null;
  service.getMessageByKeyId = async () => stored;

  const theirs = await service.getReplyToIds(quoting('628111@s.whatsapp.net'), instance);
  assert.deepEqual(theirs.quote_participant, { jid: '628111@s.whatsapp.net', from_me: false });

  const oursByLid = await service.getReplyToIds(quoting('55500@lid'), instance);
  assert.deepEqual(oursByLid.quote_participant, { jid: '55500@lid', from_me: true });

  stored = { key: { id: 'Q1', fromMe: true }, message: { conversation: 'the scan' }, chatwootMessageId: 9 };
  const storedOurs = await service.getReplyToIds(quoting('628111@s.whatsapp.net'), instance);
  assert.equal(storedOurs.in_reply_to, 9);
  assert.deepEqual(storedOurs.quote_participant, { jid: '628111@s.whatsapp.net', from_me: true });
});
