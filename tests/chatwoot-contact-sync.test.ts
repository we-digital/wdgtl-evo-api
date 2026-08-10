import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHATWOOT_CONTACT_ENRICHMENT_BATCH_LIMIT,
  extractChatwootContacts,
  shouldEnrichChatwootContacts,
  shouldForwardChatwootMessageUpsert,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-contact-sync';

test('extracts contacts from SDK and legacy response shapes', () => {
  const contact = { id: 1, identifier: '628123@s.whatsapp.net' };

  assert.deepEqual(extractChatwootContacts([contact]), [contact]);
  assert.deepEqual(extractChatwootContacts({ payload: [contact] }), [contact]);
  assert.deepEqual(extractChatwootContacts({ data: { payload: [contact] } }), [contact]);
  assert.deepEqual(extractChatwootContacts(null), []);
});

test('enriches only bounded contact batches', () => {
  assert.equal(shouldEnrichChatwootContacts(1), true);
  assert.equal(shouldEnrichChatwootContacts(CHATWOOT_CONTACT_ENRICHMENT_BATCH_LIMIT), true);
  assert.equal(shouldEnrichChatwootContacts(CHATWOOT_CONTACT_ENRICHMENT_BATCH_LIMIT + 1), false);
  assert.equal(shouldEnrichChatwootContacts(1, false), false);
});

test('forwards only live WhatsApp upserts to Chatwoot', () => {
  assert.equal(shouldForwardChatwootMessageUpsert('notify'), true);
  assert.equal(shouldForwardChatwootMessageUpsert('append'), false);
});
