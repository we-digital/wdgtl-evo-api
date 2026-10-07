import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';

test('actual postimage boundary accepts only authenticated WAS identified as ZIP; every other stored-field guard stays exact', async (t) => {
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
  const priorPool = postgresClient.getChatwootConnection;
  t.after(() => {
    postgresClient.getChatwootConnection = priorPool;
    if (priorModule) require.cache[modulePath] = priorModule;
    else delete require.cache[modulePath];
  });
  // Sanitized shape of the genuine 51 postimage: media-only incoming file, native WAS, stored ZIP.
  const bytes = Buffer.from('synthetic authenticated WAS archive');
  const descriptor = {
    filename: 'synthetic.was',
    mimetype: 'application/was',
    size: bytes.length,
    digest: createHash('sha256').update(bytes).digest(),
  };
  const message: any = {
    id: 'native-file',
    instanceId: 'owned',
    messageType: 'lottieStickerMessage',
    messageTimestamp: 123,
    key: { id: 'synthetic', remoteJid: '123456@s.whatsapp.net', fromMe: false },
    message: {
      lottieStickerMessage: {
        message: {
          stickerMessage: {
            isLottie: true,
            mimetype: 'application/was',
            fileLength: bytes.length,
            fileSha256: descriptor.digest.toString('base64'),
          },
        },
      },
    },
  };
  const attributes = {
    provider_history_native: {
      message_id: message.id,
      source: {
        message_type: message.messageType,
        sha256: createHash('sha256').update(JSON.stringify(message)).digest('hex'),
      },
    },
  };
  const row = {
    id: 1,
    message_type: 0,
    private: false,
    account_id: 1,
    inbox_id: 51,
    conversation_id: 2,
    display_id: 3,
    conversation_account: 1,
    conversation_inbox: 51,
    content: null,
    content_attributes: JSON.stringify(attributes),
    byte_size: bytes.length,
    attachment_meta: {
      whatsapp_history_sha256: descriptor.digest.toString('hex'),
      whatsapp_history_media_type: 'document',
    },
    content_type: 'application/zip',
    filename: descriptor.filename,
    checksum: createHash('md5').update(bytes).digest('base64'),
    created_at_epoch: message.messageTimestamp,
  };
  let rows: any[] = [row];
  postgresClient.getChatwootConnection = (() => ({ query: async () => ({ rows }) })) as any;
  const service: any = Object.create(ChatwootService.prototype);
  const verify = (native = message) =>
    service.verifyRecoveryMediaDestination(native, { accountId: '1' }, 51, descriptor, bytes, {
      conversationId: 2,
      displayId: 3,
      content: '',
      attributes,
    });
  await verify();
  rows = [{ ...row, content_type: 'application/was' }];
  await verify();
  for (const change of [
    { content_type: 'application/octet-stream' },
    { content_type: 'application/x-zip-compressed' },
    { attachment_meta: { ...row.attachment_meta, whatsapp_history_sha256: '0'.repeat(64) } },
    { attachment_meta: { ...row.attachment_meta, whatsapp_history_media_type: 'image' } },
    { byte_size: bytes.length + 1 },
    { checksum: 'wrong' },
    { filename: 'different.was' },
    { content: 'different caption' },
    { created_at_epoch: 124 },
    { private: true },
    { message_type: 1 },
    { account_id: 2 },
    { conversation_inbox: 40 },
    {
      content_attributes: JSON.stringify({
        provider_history_native: { ...attributes.provider_history_native, message_id: 'foreign' },
      }),
    },
  ]) {
    rows = [{ ...row, ...change }];
    await assert.rejects(verify(), /cached_media_import_postimage_unconfirmed/);
  }
  rows = [row, row];
  await assert.rejects(verify(), /cached_media_import_postimage_unconfirmed/);
  rows = [row];
  await assert.rejects(
    verify({
      ...message,
      messageType: 'documentMessage',
      message: {
        documentMessage: message.message.lottieStickerMessage.message.stickerMessage,
      },
    }),
    /cached_media_import_postimage_unconfirmed/,
  );
  await assert.rejects(
    verify({
      ...message,
      message: {
        lottieStickerMessage: {
          message: {
            stickerMessage: { ...message.message.lottieStickerMessage.message.stickerMessage, isLottie: false },
          },
        },
      },
    }),
  );
});
