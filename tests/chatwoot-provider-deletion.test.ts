import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmProviderDeletionBeforeDroppingMapping } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-provider-deletion';

test('provider deletion drops the WhatsApp mapping only after Chatwoot confirms the soft delete', async () => {
  const calls: string[] = [];

  const result = await confirmProviderDeletionBeforeDroppingMapping({
    softDelete: async () => {
      calls.push('soft-delete');
      return 'confirmed';
    },
    dropMapping: async () => {
      calls.push('drop-mapping');
    },
  });

  assert.equal(result, 'confirmed');
  assert.deepEqual(calls, ['soft-delete', 'drop-mapping']);
});

test('provider deletion preserves the WhatsApp mapping when Chatwoot fails', async () => {
  let mappingDropped = false;

  await assert.rejects(
    confirmProviderDeletionBeforeDroppingMapping({
      softDelete: async () => {
        throw new Error('Chatwoot unavailable');
      },
      dropMapping: async () => {
        mappingDropped = true;
      },
    }),
    /Chatwoot unavailable/,
  );

  assert.equal(mappingDropped, false);
});
