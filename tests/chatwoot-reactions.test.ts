import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWhatsappReactionActor } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-reactions';

test('fromMe reactions always identity as me (not participant/remoteJid)', () => {
  assert.deepEqual(
    buildWhatsappReactionActor({
      key: {
        fromMe: true,
        remoteJid: '628123@s.whatsapp.net',
        participant: '628999@s.whatsapp.net',
      },
      pushName: 'Agent Phone',
    }),
    {
      actor_type: 'external',
      actor_id: 'me',
      actor_name: 'Agent Phone',
      external_id: 'me',
      source: 'whatsapp',
    }
  );
});

test('inbound reactions keep peer identity', () => {
  assert.deepEqual(
    buildWhatsappReactionActor({
      key: { fromMe: false, remoteJid: '628123@s.whatsapp.net' },
      pushName: 'Alice',
    }),
    {
      actor_type: 'external',
      actor_id: '628123@s.whatsapp.net',
      actor_name: 'Alice',
      external_id: '628123@s.whatsapp.net',
      source: 'whatsapp',
    }
  );
});
