import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync } from 'node:crypto';
import test from 'node:test';

import { proto } from 'baileys';

import { recoverEncryptedHistoryEdit } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-encrypted-history-edit';
import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';

function fixture(edit: any, metadata?: any, extraBody: any = {}) {
  const participant = '123456789@s.whatsapp.net';
  const key = { id: 'original', remoteJid: '123456@g.us', fromMe: true };
  const secret = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(12, 8);
  const plaintext = Buffer.from(
    proto.Message.encode(
      proto.Message.fromObject({
        protocolMessage: { type: 14, key, editedMessage: edit },
        ...(metadata === undefined ? {} : { messageContextInfo: metadata }),
        ...extraBody,
      }),
    ).finish(),
  );
  const derived = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      Buffer.alloc(0),
      Buffer.from('original' + participant + participant + 'Message Edit'),
      32,
    ),
  );
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const original: any = {
    id: 'db-original',
    instanceId: 'synthetic',
    key: { ...key, fromMe: false, participant },
    messageTimestamp: 100,
    messageType: 'conversation',
    message: { conversation: 'before', messageContextInfo: { messageSecret: secret.toString('base64') } },
    chatwootMessageId: 314,
    chatwootInboxId: 99,
    chatwootConversationId: 40,
  };
  const envelope: any = {
    id: 'db-edit',
    messageTimestamp: 110,
    instanceId: 'synthetic',
    key: { id: 'edit', remoteJid: key.remoteJid, fromMe: false, participant },
    messageType: 'secretEncryptedMessage',
    message: {
      secretEncryptedMessage: {
        secretEncType: 2,
        targetMessageKey: key,
        encIv: iv.toString('base64'),
        encPayload: ciphertext.toString('base64'),
      },
    },
  };
  return { envelope, original };
}

test('authenticated sender-relative edit retains business direction, original UTC/key and raw source', () => {
  const { envelope, original } = fixture({
    extendedTextMessage: { text: 'after', contextInfo: { stanzaId: 'untrusted-outer-copy' } },
  });
  const before = JSON.stringify({ envelope, original });
  const after = recoverEncryptedHistoryEdit(envelope, original);
  assert.equal(after.messageType, 'extendedTextMessage');
  assert.equal((after.message as any).extendedTextMessage.text, 'after');
  assert.equal((after.message as any).extendedTextMessage.contextInfo, undefined);
  assert.deepEqual(after.key, original.key);
  assert.equal((after.key as any).fromMe, false);
  assert.equal(after.messageTimestamp, 100);
  assert.equal(JSON.stringify({ envelope, original }), before);
});

test('caption-only delta conserves every original attachment field and original context', () => {
  const { envelope, original } = fixture({
    documentWithCaptionMessage: {
      message: { documentMessage: { caption: 'new caption', contextInfo: { stanzaId: 'not-original-context' } } },
    },
  });
  original.messageType = 'documentMessage';
  original.message.documentMessage = {
    caption: 'old',
    url: 'synthetic-media',
    fileSha256: 'original-hash',
    mediaKey: 'original-key',
    contextInfo: { stanzaId: 'original' },
  };
  delete original.message.conversation;
  const result = recoverEncryptedHistoryEdit(envelope, original);
  assert.deepEqual((result.message as any).documentMessage, {
    ...original.message.documentMessage,
    caption: 'new caption',
  });
});

test('authenticated 32-byte wrapper metadata is accepted without replacing original context', () => {
  const { envelope, original } = fixture(
    { extendedTextMessage: { text: 'after' } },
    { messageSecret: Buffer.alloc(32, 19).toString('base64') },
  );
  const before = JSON.stringify({ envelope, original });
  const result = recoverEncryptedHistoryEdit(envelope, original);
  assert.equal((result.message as any).extendedTextMessage.text, 'after');
  assert.deepEqual((result.message as any).messageContextInfo, original.message.messageContextInfo);
  assert.notEqual((result.message as any).messageContextInfo.messageSecret, Buffer.alloc(32, 19).toString('base64'));
  assert.deepEqual(result.key, original.key);
  assert.equal(result.messageTimestamp, original.messageTimestamp);
  assert.equal(JSON.stringify({ envelope, original }), before);
});

test('authenticated wrapper metadata rejects malformed lengths, extra metadata and extra message bodies', () => {
  for (const metadata of [
    {},
    { messageSecret: Buffer.alloc(31).toString('base64') },
    { messageSecret: Buffer.alloc(33).toString('base64') },
    { deviceListMetadataVersion: 2 },
    { messageSecret: Buffer.alloc(32).toString('base64'), deviceListMetadataVersion: 2 },
  ]) {
    const { envelope, original } = fixture({ conversation: 'after' }, metadata);
    const before = JSON.stringify({ envelope, original });
    assert.throws(() => recoverEncryptedHistoryEdit(envelope, original), /authenticated metadata/);
    assert.equal(JSON.stringify({ envelope, original }), before);
  }
  assert.throws(() => fixture({ conversation: 'after' }, { messageSecret: 'invalid%' }), /invalid encoding/);
  const { envelope, original } = fixture(
    { conversation: 'after' },
    { messageSecret: Buffer.alloc(32).toString('base64') },
    { conversation: 'contradictory extra body' },
  );
  assert.throws(() => recoverEncryptedHistoryEdit(envelope, original), /inner target/);
});

test('unknown keys, wrong author/direction/instance/target, AEAD corruption or replacement media refuse', () => {
  for (const mutate of [
    (e: any, _o: any) => {
      e.messageTimestamp = 99;
    },
    (_e: any, o: any) => {
      o.status = 'EDITED';
    },
    (e: any, _o: any) => {
      e.instanceId = 'foreign';
    },
    (e: any, _o: any) => {
      e.key.fromMe = true;
    },
    (e: any, _o: any) => {
      e.key.participant = '999999@s.whatsapp.net';
    },
    (e: any, _o: any) => {
      e.message.secretEncryptedMessage.targetMessageKey.id = 'other';
    },
    (e: any, _o: any) => {
      e.message.secretEncryptedMessage.encPayload = Buffer.alloc(32).toString('base64');
    },
    (_e: any, o: any) => {
      o.message.messageContextInfo.messageSecret = Buffer.alloc(32).toString('base64');
    },
  ]) {
    const { envelope, original } = fixture({ conversation: 'after' });
    mutate(envelope, original);
    assert.throws(() => recoverEncryptedHistoryEdit(envelope, original));
  }
  const { envelope, original } = fixture({
    documentWithCaptionMessage: { message: { documentMessage: { caption: 'new', url: 'replacement' } } },
  });
  original.messageType = 'documentMessage';
  original.message.documentMessage = { caption: 'old', url: 'original' };
  assert.throws(() => recoverEncryptedHistoryEdit(envelope, original), /unsupported/);
});

test('typed controls tolerate known metadata but unknown records and missing text still require explicit edit evidence', () => {
  const key = { id: 'target', remoteJid: '123@g.us', fromMe: false };
  assert.equal(
    classifyCachedHistoryRecord({ messageType: 'conversation', message: null }, true),
    'unavailable_text_edit',
  );
  assert.throws(() => classifyCachedHistoryRecord({ messageType: 'conversation', message: null }, false));
  assert.equal(
    classifyCachedHistoryRecord(
      { messageType: 'reactionMessage', message: { reactionMessage: { key, text: 'x' }, messageContextInfo: {} } },
      false,
    ),
    'reaction_control',
  );
  assert.equal(
    classifyCachedHistoryRecord(
      { messageType: 'pinInChatMessage', message: { pinInChatMessage: { key, type: 1 }, messageContextInfo: {} } },
      false,
    ),
    'pin_control',
  );
  assert.equal(
    classifyCachedHistoryRecord(
      {
        messageType: 'pollUpdateMessage',
        message: { pollUpdateMessage: { pollCreationMessageKey: key, vote: { encIv: 'x', encPayload: 'x' } } },
      },
      false,
    ),
    'poll_control',
  );
  assert.throws(() =>
    classifyCachedHistoryRecord(
      { messageType: 'pinInChatMessage', message: { pinInChatMessage: { key, type: 1 }, unknown: {} } },
      false,
    ),
  );
});

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';

test('empty edited text retains a unique nonempty public current peer target; all conflicting targets refuse', async () => {
  const originalPool = postgresClient.getChatwootConnection;
  const valid = {
    id: 314,
    message_type: 0,
    conversation_id: 140,
    display_id: 40,
    private: false,
    content: 'retained text',
    provider_peer: '123456@g.us',
  };
  try {
    for (const rows of [
      [valid],
      [],
      [valid, valid],
      [{ ...valid, content: '' }],
      [{ ...valid, provider_peer: 'other@g.us' }],
      [{ ...valid, private: true }],
      [{ ...valid, id: 315 }],
      [{ ...valid, message_type: 1 }],
      [{ ...valid, display_id: 140 }],
    ]) {
      const queries: string[] = [];
      postgresClient.getChatwootConnection = (() => ({
        connect: async () => ({
          query: async (sql: string) => {
            queries.push(sql);
            if (sql.includes('SELECT m.id')) assert.match(sql, /c\.display_id/);
            return { rows: sql.includes('SELECT m.id') ? rows : [] };
          },
          release() {},
        }),
      })) as any;
      const pending = chatwootImport.reconcileProviderHistoryEdits(
        [
          {
            id: 'edited',
            key: { id: 'text', fromMe: false, remoteJid: '123456@g.us' },
            messageType: 'conversation',
            message: null,
            chatwootMessageId: 314,
            chatwootInboxId: 99,
            chatwootConversationId: 40,
          } as any,
        ],
        99,
        { accountId: '1' } as any,
        { applyWhatsappProviderEdit: () => assert.fail('Unavailable text never clears content') } as any,
      );
      if (rows.length === 1 && rows[0] === valid)
        assert.equal((await pending).get('WAID:text'), 'preserved_existing_source_payload_unavailable');
      else await assert.rejects(pending);
      assert.equal(
        queries.some((sql) => /^(UPDATE|INSERT|DELETE)/.test(sql)),
        false,
      );
    }
  } finally {
    postgresClient.getChatwootConnection = originalPool;
  }
});

test('whole cached-v2 encrypted edit updates only the unique existing original and refuses source drift/foreign binding', async (t) => {
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
  t.after(() => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  });
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service: any = Object.create(ChatwootService.prototype);
  const { envelope, original } = fixture({ conversation: 'authenticated after' });
  envelope.messageTimestamp = 110;
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: false }) };
  service.isImportHistoryAvailable = () => true;
  service.getProvider = async () => ({ accountId: '1', importMessages: true, enabled: true });
  service.getStoredHistoryRecoveryInbox = async () => ({ id: 99 });
  let drift = false,
    competingEdit = false;
  service.prismaRepository = {
    message: {
      findMany: async ({ where }: any) =>
        where.OR
          ? competingEdit
            ? [{ ...envelope, id: 'newer-edit', messageTimestamp: 111 }]
            : []
          : where.key
            ? [original]
            : where.instanceId
              ? [envelope, { ...original, messageTimestamp: drift ? 101 : 100 }]
              : [envelope],
    },
    messageUpdate: { findMany: async () => [] },
  };
  const methods = [
    'activateHistorySourceGuards',
    'reconcileOutboundHistoryBindings',
    'getVerifiedRecoverySourceIds',
    'importHistoryMessages',
  ] as const;
  const saved = methods.map((method) => chatwootImport[method]);
  const pool = postgresClient.getChatwootConnection;
  t.after(() => {
    methods.forEach((method, i) => ((chatwootImport as any)[method] = saved[i]));
    postgresClient.getChatwootConnection = pool;
  });
  chatwootImport.activateHistorySourceGuards = async () => {};
  chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
  chatwootImport.getVerifiedRecoverySourceIds = async (records: any[]) =>
    new Set(records.filter((x) => x.id === original.id).map((x) => `WAID:${x.key.id}`));
  chatwootImport.importHistoryMessages = async () => assert.fail('An encrypted edit never imports a new message');
  let content = 'before',
    edited = false,
    peer = original.key.remoteJid,
    calls = 0;
  postgresClient.getChatwootConnection = (() => ({
    query: async () => ({
      rows: [
        {
          id: 314,
          private: false,
          display_id: 40,
          message_type: 0,
          provider_peer: peer,
          content,
          content_attributes: { edited },
        },
      ],
    }),
  })) as any;
  service.applyWhatsappProviderEdit = async (_provider: any, target: any) => {
    assert.equal(target.messageId, 314);
    assert.equal(target.direction, 'incoming');
    assert.equal(target.sourceId, 'WAID:original');
    assert.equal(target.content, 'authenticated after');
    assert.deepEqual(target.providerRecoveryGuard, { content: 'before', content_attributes: { edited: false } });
    calls++;
    content = target.content;
    edited = true;
  };
  const request = {
    contractVersion: '2026-08-28',
    dryRun: false,
    scope: 'all',
    unresolvedLidMode: 'skip',
    recoveryMode: 'maximize',
    refreshLidMappings: false,
    expectedDestinationKey: 'chatwoot:1:99',
    expectedInboxId: 99,
    messages: [{ sourceId: 'WAID:edit', expectedDirection: 'incoming', message: envelope }],
  };
  const before = JSON.stringify({ envelope, original });
  drift = true;
  await assert.rejects(service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request), /rotated/);
  assert.equal(calls, 0);
  assert.equal(content, 'before');
  drift = false;
  competingEdit = true;
  await assert.rejects(service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request), /ordering/);
  assert.equal(calls, 0);
  assert.equal(content, 'before');
  competingEdit = false;
  content = 'newer edit';
  edited = true;
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request),
    /different existing edit/,
  );
  assert.equal(calls, 0);
  assert.equal(content, 'newer edit');
  content = 'before';
  edited = false;
  for (let i = 0; i < 2; i++) {
    const result = await service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request);
    assert.deepEqual(result.outcomes, [
      {
        sourceId: 'WAID:edit',
        status: 'existing',
        reason: 'authenticated_provider_edit_reconciled',
        recovery: 'native',
      },
    ]);
  }
  assert.equal(calls, 1);
  assert.equal(JSON.stringify({ envelope, original }), before);
  drift = true;
  await assert.rejects(service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request), /rotated/);
  drift = false;
  peer = 'foreign@g.us';
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request),
    /binding differs/,
  );
  assert.equal(calls, 1);
});
