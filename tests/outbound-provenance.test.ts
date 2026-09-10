import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachOutboundProvenance,
  isChatwootOutboundEcho,
  isRetainedChatwootOutboundMessageId,
  matchesChatwootOutboundProvenance,
  resolveOutboundRequestId,
} from '@api/types/outbound-provenance';

test('preserves a safe caller request ID and rejects unsafe values', () => {
  const opaqueRequestId = '5ae4fa35-0193-4b77-8440-45d8628f7597';

  assert.equal(resolveOutboundRequestId(opaqueRequestId), opaqueRequestId);
  assert.notEqual(resolveOutboundRequestId('628123456789'), '628123456789');
  assert.match(resolveOutboundRequestId('unsafe request id'), /^[0-9a-f-]{36}$/);
});

test('requires the exact retained Chatwoot provenance for pre-callback deletion', () => {
  const contextInfo = {
    weDigitalOutbound: {
      version: 1,
      origin: 'chatwoot',
      requestId: 'operation-1',
      chatwootMessageId: 314,
      chatwootInboxId: 58,
      chatwootConversationId: 42,
    },
  };
  const expected = {
    requestId: 'operation-1',
    chatwootMessageId: 314,
    chatwootInboxId: 58,
    chatwootConversationId: 42,
  };
  assert.equal(matchesChatwootOutboundProvenance(contextInfo, expected), true);
  assert.equal(matchesChatwootOutboundProvenance(contextInfo, { ...expected, chatwootConversationId: 43 }), false);
});

test('stores provenance alongside existing message context without replacing it', () => {
  assert.deepEqual(
    attachOutboundProvenance(
      { contextInfo: { quotedMessageId: 'quoted-1' }, message: { conversation: 'hello' } },
      { version: 1, origin: 'api', requestId: 'request-1' },
    ),
    {
      contextInfo: {
        quotedMessageId: 'quoted-1',
        weDigitalOutbound: { version: 1, origin: 'api', requestId: 'request-1' },
      },
      message: { conversation: 'hello' },
    },
  );
});

test('suppresses a complete locally-originated Chatwoot outbound echo without a ledger lookup', async () => {
  const echo = {
    key: { fromMe: true, id: 'WDDE7D150B1147822490' },
    contextInfo: {
      weDigitalOutbound: {
        version: 1,
        origin: 'chatwoot',
        requestId: 'a'.repeat(64),
        chatwootMessageId: 314,
        chatwootInboxId: 58,
        chatwootConversationId: 42,
      },
    },
  };

  let lookups = 0;
  const lookup = async (whatsappMessageId: string) => {
    lookups += 1;
    return whatsappMessageId === 'WDDE7D150B1147822490';
  };

  assert.equal(await isChatwootOutboundEcho(echo, lookup), true);
  assert.equal(lookups, 0);
  assert.equal(await isChatwootOutboundEcho({ ...echo, key: { fromMe: false } }, lookup), false);
  assert.equal(
    await isChatwootOutboundEcho(
      {
        ...echo,
        key: { fromMe: true, id: 'unknown-api-send' },
        contextInfo: { weDigitalOutbound: { ...echo.contextInfo.weDigitalOutbound, origin: 'api' } },
      },
      lookup,
    ),
    false,
  );
  assert.equal(await isChatwootOutboundEcho({ ...echo, key: { fromMe: true, id: ['bad'] } }, lookup), false);
  assert.equal(await isChatwootOutboundEcho({ ...echo, key: { fromMe: true, id: 'bad id' } }, lookup), false);
  assert.equal(await isChatwootOutboundEcho({ ...echo, key: { fromMe: true, id: 'x'.repeat(101) } }, lookup), false);
  assert.equal(
    await isChatwootOutboundEcho(
      {
        ...echo,
        key: { fromMe: true, id: 'unknown-api-send' },
        contextInfo: { weDigitalOutbound: { ...echo.contextInfo.weDigitalOutbound, chatwootMessageId: '314' } },
      },
      lookup,
    ),
    false,
  );
});

test('uses the exact durable WhatsApp ID when a Baileys echo lost custom provenance', async () => {
  const lookedUp: string[] = [];
  const lookup = async (whatsappMessageId: string) => {
    lookedUp.push(whatsappMessageId);
    return whatsappMessageId === 'WDDE7D150B1147822490';
  };

  assert.equal(await isChatwootOutboundEcho({ key: { fromMe: true, id: 'WDDE7D150B1147822490' } }, lookup), true);
  assert.deepEqual(lookedUp, ['WDDE7D150B1147822490']);
  assert.equal(await isChatwootOutboundEcho({ key: { fromMe: true, id: 'unknown-api-send' } }, lookup), false);
  assert.equal(await isChatwootOutboundEcho({ key: { fromMe: false, id: 'WDDE7D150B1147822490' } }, lookup), false);
  assert.equal(await isChatwootOutboundEcho({ key: { fromMe: true, id: ['WDDE7D150B1147822490'] } }, lookup), false);
  assert.equal(await isChatwootOutboundEcho({ key: { fromMe: true, id: 'bad id' } }, lookup), false);
});

test('looks up both planned and actual WhatsApp IDs inside the exact instance', async () => {
  const queries: unknown[] = [];
  const repository = {
    chatwootOutboundOperation: {
      findMany: async (query: unknown) => {
        queries.push(query);
        return [
          {
            instanceId: 'instance-1',
            plannedWhatsappMessageId: 'WDDE7D150B1147822490',
            whatsappMessageId: null,
          },
        ];
      },
    },
  };

  assert.equal(await isRetainedChatwootOutboundMessageId(repository, 'instance-1', 'WDDE7D150B1147822490'), true);
  assert.deepEqual(queries, [
    {
      where: {
        instanceId: 'instance-1',
        OR: [{ plannedWhatsappMessageId: 'WDDE7D150B1147822490' }, { whatsappMessageId: 'WDDE7D150B1147822490' }],
      },
      select: {
        instanceId: true,
        plannedWhatsappMessageId: true,
        whatsappMessageId: true,
      },
    },
  ]);
});

test('requires byte-exact instance and WAID matches despite a case-insensitive database candidate set', async () => {
  let lookups = 0;
  const repository = {
    chatwootOutboundOperation: {
      findMany: async () => {
        lookups += 1;
        return [
          {
            instanceId: 'INSTANCE-1',
            plannedWhatsappMessageId: 'wdde7d150b1147822490',
            whatsappMessageId: '3eb0abcdef',
          },
        ];
      },
    },
  };

  assert.equal(await isRetainedChatwootOutboundMessageId(repository, 'instance-1', 'WDDE7D150B1147822490'), false);
  assert.equal(await isRetainedChatwootOutboundMessageId(repository, 'instance-1', '3EB0ABCDEF'), false);
  assert.equal(lookups, 2);

  assert.equal(await isRetainedChatwootOutboundMessageId(repository, undefined, 'WDDE7D150B1147822490'), false);
  assert.equal(await isRetainedChatwootOutboundMessageId(repository, '', 'WDDE7D150B1147822490'), false);
  assert.equal(await isRetainedChatwootOutboundMessageId(repository, 'bad instance', 'WDDE7D150B1147822490'), false);
  assert.equal(lookups, 2);
});
