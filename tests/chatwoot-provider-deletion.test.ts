import assert from 'node:assert/strict';
import test from 'node:test';

import {
  confirmProviderDeletionBeforeMarkingLocal,
  markWhatsappKeyDeleted,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-provider-deletion';

test('provider deletion marks the EVO row only after Chatwoot confirms the soft delete', async () => {
  const calls: string[] = [];

  const result = await confirmProviderDeletionBeforeMarkingLocal({
    softDelete: async () => {
      calls.push('soft-delete');
      return 'confirmed';
    },
    markLocal: async () => {
      calls.push('mark-local');
    },
  });

  assert.equal(result, 'confirmed');
  assert.deepEqual(calls, ['soft-delete', 'mark-local']);
});

test('provider deletion leaves the EVO row untouched when Chatwoot fails', async () => {
  let marked = false;

  await assert.rejects(
    confirmProviderDeletionBeforeMarkingLocal({
      softDelete: async () => {
        throw new Error('Chatwoot unavailable');
      },
      markLocal: async () => {
        marked = true;
      },
    }),
    /Chatwoot unavailable/,
  );

  assert.equal(marked, false);
});

test('the marked key keeps the WhatsApp identity and only adds deleted', () => {
  const key = { id: 'ABC', remoteJid: '62811@s.whatsapp.net', fromMe: false, participant: undefined };
  assert.deepEqual(markWhatsappKeyDeleted(key), { ...key, deleted: true });
  assert.deepEqual(key, { id: 'ABC', remoteJid: '62811@s.whatsapp.net', fromMe: false, participant: undefined });
  assert.deepEqual(markWhatsappKeyDeleted(null), { deleted: true });
  assert.deepEqual(markWhatsappKeyDeleted(['x']), { deleted: true });
});
