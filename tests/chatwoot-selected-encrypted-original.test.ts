import assert from 'node:assert/strict';
import { createCipheriv, createHash, hkdfSync } from 'node:crypto';
import test from 'node:test';
import { proto } from 'baileys';
import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';

function nativePair(image: boolean) {
  const participant = '123456789@s.whatsapp.net';
  const key = { id: 'original', remoteJid: '123456@g.us', fromMe: true };
  const secret = Buffer.alloc(32, 7),
    iv = Buffer.alloc(12, 8),
    bytes = Buffer.from('synthetic-owned-image');
  const plaintext = Buffer.from(
    proto.Message.encode(
      proto.Message.fromObject({
        protocolMessage: { type: 14, key, editedMessage: image ? { stickerMessage: {} } : { conversation: 'after' } },
      }),
    ).finish(),
  );
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(
      hkdfSync(
        'sha256',
        secret,
        Buffer.alloc(0),
        Buffer.from('original' + participant + participant + 'Message Edit'),
        32,
      ),
    ),
    iv,
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const original: any = {
    id: 'native-original',
    instanceId: 'synthetic',
    status: 'DELIVERY_ACK',
    messageTimestamp: 100,
    key: { ...key, fromMe: false, participant },
    messageType: image ? 'imageMessage' : 'conversation',
    message: {
      ...(image
        ? {
            imageMessage: {
              caption: 'before',
              mimetype: 'image/jpeg',
              fileLength: bytes.length,
              fileSha256: createHash('sha256').update(bytes).digest('base64'),
            },
          }
        : { conversation: 'before' }),
      messageContextInfo: { messageSecret: secret.toString('base64') },
    },
    chatwootMessageId: null,
    chatwootInboxId: null,
    chatwootConversationId: null,
  };
  const envelope: any = {
    id: 'native-edit',
    instanceId: 'synthetic',
    messageTimestamp: 110,
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
  return { original, envelope, bytes };
}

test('same-selected available original imports and verifies before recovered edit or unsupported preservation; unsafe boundaries stop', async (t) => {
  const modulePath = require.resolve('../src/api/server.module.ts'),
    priorModule = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const names = [
    'getExistingSourceIds',
    'getVerifiedRecoverySourceIds',
    'activateHistorySourceGuards',
    'reconcileOutboundHistoryBindings',
    'importHistoryMessages',
    'selectOrCreateFksFromChatwoot',
  ] as const;
  const methods = names.map((n) => chatwootImport[n]),
    priorPool = postgresClient.getChatwootConnection;
  t.after(() => {
    names.forEach((n, i) => ((chatwootImport as any)[n] = methods[i]));
    postgresClient.getChatwootConnection = priorPool;
    if (priorModule) require.cache[modulePath] = priorModule;
    else delete require.cache[modulePath];
  });
  for (const mode of [
    'text',
    'image',
    'out-of-batch',
    'ambiguous',
    'rotated',
    'media-failure',
    'destination-rotation',
    'competing',
    'already-imported-image',
    'missing-target',
  ] as const) {
    const image = !['text', 'out-of-batch'].includes(mode),
      { original, envelope, bytes } = nativePair(image);
    const before = JSON.stringify({ original, envelope });
    const selected = ['out-of-batch', 'missing-target'].includes(mode) ? [envelope] : [original, envelope];
    let stored = mode === 'already-imported-image',
      edits = 0,
      captures = 0;
    const events: string[] = [];
    let currentContent = 'before',
      edited = false;
    const service: any = Object.create(ChatwootService.prototype);
    service.isImportHistoryAvailable = () => true;
    service.getProvider = async () => ({ accountId: '1', enabled: true, importMessages: true });
    service.getStoredHistoryRecoveryInbox = async () => ({ id: 99 });
    service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true, NATIVE_BRIDGE_TOKEN: 'synthetic' }) };
    service.resolvePhoneJidForLid = async () => null;
    service.getGroupIdentityNames = async () => new Map();
    service.getConversationMessage = () => 'before';
    service.waMonitor = { waInstances: {} };
    const media = {
      id: 'owned-media',
      messageId: original.id,
      instanceId: 'synthetic',
      type: 'imageMessage',
      mimetype: 'image/jpeg',
      fileName: 'synthetic/123456@g.us/imageMessage/1700000000000_synthetic.jpeg',
    };
    service.prismaRepository = {
      message: {
        findMany: async ({ where }: any) =>
          where.OR
            ? mode === 'competing'
              ? [{ ...envelope, id: 'other-edit' }]
              : []
            : where.key
              ? mode === 'missing-target'
                ? []
                : [original]
              : where.instanceId
                ? mode === 'missing-target'
                  ? [envelope]
                  : [envelope, mode === 'rotated' && stored ? { ...original, messageTimestamp: 101 } : original]
                : selected,
        findUnique: async ({ where }: any) => (where.id === envelope.id ? envelope : original),
      },
      messageUpdate: { findMany: async () => [] },
      media: { findFirst: async () => (image ? media : null) },
    };
    service.readCachedRecoveryObject = async () => {
      events.push('owned-read');
      return bytes;
    };
    service.assertSilentHistoryMediaCapability = async () => {};
    service.assertTaggedHistoryMediaStored = async () => {
      if (stored) events.push('physical-proof');
      return new Set(stored ? ['WAID:original'] : []);
    };
    service.sendData = async () => {
      events.push('import');
      stored = true;
      return { expectedContentAttributes: {} };
    };
    service.verifyRecoveryMediaDestination = async () => {
      events.push('verify-media');
      if (mode === 'media-failure') throw new Error('synthetic physical mismatch');
    };
    service.applyWhatsappProviderEdit = async () => {
      assert.equal(stored, true);
      events.push('edit');
      edits++;
      currentContent = 'after';
      edited = true;
    };
    chatwootImport.getExistingSourceIds = async () =>
      new Set(mode === 'already-imported-image' ? ['WAID:original'] : []);
    chatwootImport.getVerifiedRecoverySourceIds = async (rows: any[]) => {
      if (mode === 'ambiguous') throw new Error('synthetic ambiguous destination');
      if (stored) events.push('verified');
      return new Set(stored ? rows.filter((x) => x.id === original.id).map((x) => `WAID:${x.key.id}`) : []);
    };
    chatwootImport.activateHistorySourceGuards = async () => {};
    chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
    chatwootImport.importHistoryMessages = async (_i, _s, _ib, _p, data: any) => {
      assert.deepEqual(data.messages, [original]);
      events.push('import');
      stored = true;
      return 1;
    };
    chatwootImport.selectOrCreateFksFromChatwoot = async () =>
      new Map([[original.key.remoteJid, { conversation_id: '123' }]]);
    postgresClient.getChatwootConnection = (() => ({
      query: async (sql: string) => {
        if (sql.includes('a.meta ?')) return { rows: [] };
        if (sql.includes('message_snapshot')) {
          captures++;
          events.push('capture');
          assert.equal(stored, true);
        }
        if (
          sql.includes('provider_conversation_bindings') &&
          !sql.includes('message_snapshot') &&
          !sql.includes('FOR UPDATE') &&
          !sql.includes('bound_provider')
        )
          return { rows: [{ id: 123, display_id: 40 }] };
        return {
          rows: stored
            ? [
                {
                  id: mode === 'destination-rotation' && captures > 1 ? 315 : 314,
                  display_id: 40,
                  private: false,
                  message_type: 0,
                  content: currentContent,
                  content_attributes: { edited },
                  provider_peer: original.key.remoteJid,
                  bound_peer: original.key.remoteJid,
                  bound_provider: 'whatsapp',
                  binding_snapshot: { provider: 'whatsapp' },
                  contact_inbox_snapshot: { id: 1 },
                  contact_inbox_matches: true,
                  message_snapshot: { content: 'before' },
                  attachments: image
                    ? [{ attachment: { id: 8 }, blob: { key: 'owned', byte_size: bytes.length } }]
                    : [],
                },
              ]
            : [],
        };
      },
    })) as any;
    const request = {
      contractVersion: '2026-08-28',
      dryRun: false,
      scope: 'all',
      unresolvedLidMode: 'skip',
      recoveryMode: 'maximize',
      refreshLidMappings: false,
      expectedDestinationKey: 'chatwoot:1:99',
      expectedInboxId: 99,
      messages: selected.map((message) => ({
        message,
        sourceId: `WAID:${message.key.id}`,
        expectedDirection: 'incoming',
      })),
    };
    const result = service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request);
    if (mode === 'missing-target') {
      const done = await result;
      assert.equal(done.outcomes.length, 1);
      const outcome = done.outcomes[0];
      assert.equal(outcome.status, 'skipped');
      assert.equal(outcome.unavailableOriginalEdit.version, 3);
      assert.equal(outcome.unavailableOriginalEdit.nativeTargetState, 'missing');
      assert.equal(outcome.unavailableOriginalEdit.destinationState, 'unqualified');
      assert.equal(edits, 0);
      assert.equal(stored, false);
      assert.equal(events.includes('import'), false);
    } else if (['text', 'image', 'competing', 'already-imported-image'].includes(mode)) {
      const done = await result;
      assert.equal(
        done.outcomes.find((x: any) => x.sourceId === 'WAID:original').status,
        mode === 'already-imported-image' ? 'existing' : 'imported',
      );
      if (mode !== 'already-imported-image') assert.equal(events.indexOf('import') < events.indexOf('verified'), true);
      if (mode === 'text') {
        assert.equal(edits, 1);
        assert.equal(events.indexOf('verified') < events.indexOf('edit'), true);
      } else {
        assert.equal(edits, 0);
        assert.equal(events.indexOf('physical-proof') < events.indexOf('capture'), true);
        const proof = done.outcomes.find((x: any) => x.sourceId === 'WAID:edit').ignoredEditPreservation;
        assert.equal(proof.destinationMessageId, 314);
        assert.equal(proof.nativeVersionSHA256, createHash('sha256').update(JSON.stringify(original)).digest('hex'));
      }
    } else {
      await assert.rejects(result);
      assert.equal(edits, 0);
      if (['out-of-batch', 'ambiguous'].includes(mode)) assert.equal(stored, false);
      if (['media-failure', 'rotated'].includes(mode)) assert.equal(captures, 0);
    }
    assert.equal(JSON.stringify({ original, envelope }), before);
  }
});

test('same-batch imported-original receipt binds actual IDs, native hash and scoped binding without native pointer fabrication', async (t) => {
  const { original, envelope } = nativePair(true);
  const prior = postgresClient.getChatwootConnection;
  t.after(() => {
    postgresClient.getChatwootConnection = prior;
  });
  const valid = {
    id: 314,
    display_id: 40,
    message_type: 0,
    private: false,
    provider_peer: original.key.remoteJid,
    bound_peer: original.key.remoteJid,
    bound_provider: 'whatsapp',
    binding_snapshot: { provider: 'whatsapp' },
    contact_inbox_matches: true,
    contact_inbox_snapshot: { id: 1 },
    content: '',
    content_attributes: {},
    attachments: [{ blob: { key: 'owned', byte_size: 35106 } }],
  };
  let rows: any[] = [valid];
  postgresClient.getChatwootConnection = (() => ({ query: async () => ({ rows }) })) as any;
  const receipt = await chatwootImport.verifyImportedHistoryEditOriginal(original, 99, { accountId: '1' } as any);
  const proof = await chatwootImport.captureIgnoredHistoryEdit(
    envelope,
    original,
    99,
    { accountId: '1' } as any,
    'unavailable',
    'Retained encrypted edit content is unsupported',
    receipt,
  );
  assert.equal(proof.destinationMessageId, 314);
  assert.equal(original.chatwootMessageId, null);
  for (const changed of [
    { ...receipt, sourceId: 'WAID:foreign' },
    { ...receipt, nativeVersionSHA256: '0'.repeat(64) },
    { ...receipt, destinationMessageId: 315 },
    { ...receipt, destinationConversationId: 41 },
  ])
    await assert.rejects(
      chatwootImport.captureIgnoredHistoryEdit(
        envelope,
        original,
        99,
        { accountId: '1' } as any,
        'unavailable',
        'Retained encrypted edit content is unsupported',
        changed,
      ),
    );
  for (const bad of [
    [],
    [valid, valid],
    [{ ...valid, bound_peer: 'foreign@g.us' }],
    [{ ...valid, bound_provider: 'telegram_mtproto' }],
    [{ ...valid, contact_inbox_matches: false }],
    [{ ...valid, private: true }],
    [{ ...valid, message_type: 1 }],
  ]) {
    rows = bad;
    await assert.rejects(chatwootImport.verifyImportedHistoryEditOriginal(original, 99, { accountId: '1' } as any));
  }
  rows = [valid];
  await assert.rejects(
    chatwootImport.verifyImportedHistoryEditOriginal({ ...original, chatwootMessageId: 314 }, 99, {
      accountId: '1',
    } as any),
  );
});
