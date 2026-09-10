import assert from 'node:assert/strict';
import test from 'node:test';

import { toChatwootProviderDto } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-provider-dto';

test('findChatwoot mapping returns the authoritative durable provider id used by the outbound ledger', () => {
  const row = {
    id: 'provider-durable-id',
    instanceId: 'instance-1',
    createdAt: new Date('2026-09-10T00:00:00Z'),
    updatedAt: new Date('2026-09-10T00:00:00Z'),
    enabled: true,
    accountId: '7',
    token: 'redacted-test-token',
    url: 'https://chatwoot.example.invalid',
    nameInbox: 'WA - Test',
    number: '628123',
    signMsg: false,
    signDelimiter: null,
    reopenConversation: false,
    conversationPending: false,
    mergeBrazilContacts: false,
    importContacts: false,
    importMessages: false,
    daysLimitImportMessages: 30,
    organization: null,
    logo: null,
    ignoreJids: [],
  };
  const provider = toChatwootProviderDto(row);

  assert.equal(provider?.id, row.id);
  assert.equal(provider?.enabled, true);
  assert.equal(provider?.accountId, row.accountId);
});
