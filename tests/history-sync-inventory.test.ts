import assert from 'node:assert/strict';
import test from 'node:test';

import { HISTORY_SYNC_INVENTORY_CONTRACT_VERSION, toHistorySyncInventoryItem } from '@api/utils/history-sync-inventory';

test('publishes a safe versioned history inventory without raw owner or provider secrets', () => {
  const item = toHistorySyncInventoryItem({
    id: 'instance-id',
    name: 'instance-name',
    connectionStatus: 'open',
    ownerJid: '628111@s.whatsapp.net',
    createdAt: new Date('2026-08-31T09:00:00.000Z'),
    updatedAt: new Date('2026-08-31T09:30:00.000Z'),
    Chatwoot: {
      enabled: true,
      importMessages: true,
      accountId: '12',
      url: 'https://chatwoot.example.test/',
      nameInbox: 'BBC WhatsApp',
      updatedAt: new Date('2026-08-31T09:30:00.000Z'),
    },
  });

  assert.equal(HISTORY_SYNC_INVENTORY_CONTRACT_VERSION, '2026-08-31');
  assert.equal(item.ownerFingerprint.length, 64);
  assert.equal(item.sourceKey.length, 64);
  assert.equal(item.sourceIdentityReady, true);
  assert.equal('ownerJid' in item, false);
  assert.equal('token' in item, false);
  assert.deepEqual(item.chatwoot, {
    enabled: true,
    importMessages: true,
    updatedAt: '2026-08-31T09:30:00.000Z',
  });
});

test('marks an unavailable owner without exposing or inventing an identity', () => {
  const item = toHistorySyncInventoryItem({
    id: 'instance-id',
    name: 'instance-name',
    connectionStatus: 'close',
    ownerJid: null,
    createdAt: null,
    updatedAt: null,
    Chatwoot: null,
  });

  assert.equal(item.ownerFingerprint.length, 64);
  assert.equal(item.sourceKey.length, 64);
  assert.equal(item.sourceIdentityReady, false);
  assert.equal('ownerJid' in item, false);
});

test('source identity is stable across device suffixes and cosmetic URL casing', () => {
  const base = {
    id: 'instance-id',
    name: 'instance-name',
    connectionStatus: 'open',
    createdAt: null,
    updatedAt: null,
    Chatwoot: {
      enabled: true,
      importMessages: true,
      accountId: '12',
      url: 'https://chatwoot.example.test/',
      nameInbox: 'BBC WhatsApp',
      updatedAt: new Date('2026-08-31T09:30:00.000Z'),
    },
  };

  const first = toHistorySyncInventoryItem({ ...base, ownerJid: '628111:7@s.whatsapp.net' });
  const second = toHistorySyncInventoryItem({
    ...base,
    ownerJid: '628111@s.whatsapp.net',
    Chatwoot: { ...base.Chatwoot, url: 'HTTPS://CHATWOOT.EXAMPLE.TEST' },
  });

  assert.equal(first.sourceKey, second.sourceKey);
});
