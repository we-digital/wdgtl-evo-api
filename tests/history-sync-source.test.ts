import assert from 'node:assert/strict';
import test from 'node:test';

import { createHistorySyncAcquisitionKey, createHistorySyncSourceKey } from '@api/utils/history-sync-source';

test('reconnect device suffix does not create a new WhatsApp acquisition identity', () => {
  assert.equal(
    createHistorySyncAcquisitionKey('instance-id', '628111:9@s.whatsapp.net'),
    createHistorySyncAcquisitionKey('instance-id', '628111@s.whatsapp.net'),
  );
});

test('renamed inbox stays the same source while destination changes are explicit', () => {
  const source = {
    instanceId: 'instance-id',
    ownerJid: '628111@s.whatsapp.net',
    chatwoot: {
      accountId: '12',
      url: 'https://chatwoot.example.test',
      nameInbox: 'stable-provider-key',
    },
  };

  const original = createHistorySyncSourceKey(source);
  assert.equal(
    original,
    createHistorySyncSourceKey({
      ...source,
      chatwoot: { ...source.chatwoot, nameInbox: 'Renamed BBC WhatsApp' },
    }),
  );
  assert.notEqual(
    original,
    createHistorySyncSourceKey({
      ...source,
      chatwoot: { ...source.chatwoot, accountId: '13' },
    }),
  );
});
