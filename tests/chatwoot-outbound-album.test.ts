import assert from 'node:assert/strict';
import test from 'node:test';

import { BaileysStartupService } from '@api/integrations/channel/whatsapp/whatsapp.baileys.service';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { ChatwootOutboundPrismaStore } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-prisma-store';
import {
  buildChatwootOutboundParts,
  chatwootAttachmentAlbumKind,
  chatwootOutboundCallbackPartCount,
  ChatwootOutboundOrigin,
  StoredChatwootOutboundOperation,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';

const origin: ChatwootOutboundOrigin = {
  providerId: 'provider-1',
  baseUrl: 'https://chatwoot.example.invalid',
  accountId: 7,
  inboxId: 58,
  conversationId: 42,
  messageId: 314,
  inboxName: 'WA - Test',
  snapshotFingerprint: 'b'.repeat(64),
  routeBinding: {
    version: 2,
    provider: 'evo_whatsapp',
    inbox_id: 58,
    instance_id: 'instance-1',
    instance_name: 'test-instance',
    receiver_fingerprint: 'a'.repeat(64),
  },
};

const image = (id: number) => ({ id, file_type: 'image', data_url: `https://example.invalid/photo-${id}.jpg` });
const pdf = (id: number) => ({ id, file_type: 'file', data_url: `https://example.invalid/doc-${id}.pdf` });

const buildParts = (attachments: any[], albums = true, formattedText: string | null = 'caption') =>
  buildChatwootOutboundParts({
    instanceId: 'instance-1',
    body: {
      event: 'message_created',
      id: 314,
      account: { id: 7 },
      inbox: { id: 58 },
      conversation: { id: 42 },
      content_attributes: { in_reply_to: 99 },
      outbound_snapshot: { version: 1, fingerprint: 'b'.repeat(64) },
      attachments,
    },
    chatId: 'opaque-chat',
    formattedText,
    origin,
    albums,
  });

test('3 images + 1 pdf: album container first, its photos, then the document; one caption', () => {
  const parts = buildParts([pdf(9), image(12), image(10), image(11)]);

  assert.equal(parts.length, 5);
  assert.ok(parts.every((part) => part.partCount === 5 && part.messageSetHash === parts[0].messageSetHash));
  assert.deepEqual(parts[0].payload.album, { expectedImageCount: 3, expectedVideoCount: 0 });
  assert.equal(parts[0].payload.attachmentUrl, undefined);
  assert.equal(parts[0].payload.text, null);
  assert.equal(parts[0].payload.quotedChatwootMessageId, undefined);
  assert.deepEqual(
    parts.map((part) => part.payload.attachmentId),
    [undefined, 10, 11, 12, 9],
  );
  assert.deepEqual(
    parts.map((part) => part.payload.text),
    [null, 'caption', null, null, null],
  );
  assert.deepEqual(
    parts.map((part) => part.payload.albumParentWhatsappMessageId),
    [
      undefined,
      parts[0].plannedWhatsappMessageId,
      parts[0].plannedWhatsappMessageId,
      parts[0].plannedWhatsappMessageId,
      undefined,
    ],
  );
  assert.ok(parts.slice(1).every((part) => part.payload.quotedChatwootMessageId === 99));
  assert.equal(new Set(parts.map((part) => part.plannedWhatsappMessageId)).size, 5);
});

test('1 image + 2 pdf: no album, unchanged parts and frozen identity', () => {
  const attachments = [image(10), pdf(11), pdf(12)];
  const parts = buildParts(attachments);
  const withoutAlbums = buildParts(attachments, false);

  assert.equal(parts.length, 3);
  assert.ok(parts.every((part) => !part.payload.album && !part.payload.albumParentWhatsappMessageId));
  assert.deepEqual(parts, withoutAlbums);
  assert.deepEqual(
    parts.map((part) => part.payload.text),
    ['caption', null, null],
  );
});

test('2 pdf only: no album', () => {
  const parts = buildParts([pdf(10), pdf(11)]);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((part) => !part.payload.album && !part.payload.albumParentWhatsappMessageId));
  assert.deepEqual(buildParts([pdf(10), pdf(11)], false), parts);
});

test('album identity is stable across attachment order and replay', () => {
  const first = buildParts([image(10), pdf(9), image(11)]);
  const replay = buildParts([image(11), image(10), pdf(9)]);

  assert.deepEqual(first, replay);
  assert.deepEqual(
    first.map((part) => part.payload.attachmentId),
    [undefined, 10, 11, 9],
  );
  const changed = buildParts([image(10), pdf(9), image(12)]);
  assert.notEqual(changed[0].messageSetHash, first[0].messageSetHash);
  assert.notEqual(changed[0].plannedWhatsappMessageId, first[0].plannedWhatsappMessageId);
});

test('channels without albums keep one part per attachment', () => {
  const parts = buildParts([image(10), image(11)], false);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((part) => !part.payload.album));
});

test('text-less album keeps no caption at all', () => {
  const parts = buildParts([image(10), image(11)], true, null);
  assert.deepEqual(
    parts.map((part) => part.payload.text),
    [null, null, null],
  );
});

test('album kind follows Chatwoot file type and the document-only formats', () => {
  assert.equal(chatwootAttachmentAlbumKind({ file_type: 'image' }, 'https://x.invalid/a.jpg'), 'image');
  assert.equal(chatwootAttachmentAlbumKind({ file_type: 0 }, 'https://x.invalid/a'), 'image');
  assert.equal(chatwootAttachmentAlbumKind({ file_type: 'video' }, 'https://x.invalid/a.mp4'), 'video');
  assert.equal(chatwootAttachmentAlbumKind({ file_type: 'image' }, 'https://x.invalid/a.gif'), null);
  assert.equal(chatwootAttachmentAlbumKind({ file_type: 'image', extension: 'svg' }, 'https://x.invalid/a'), null);
  assert.equal(chatwootAttachmentAlbumKind({ file_type: 'file' }, 'https://x.invalid/a.jpg'), null);
  assert.equal(chatwootAttachmentAlbumKind({ file_type: 'audio' }, 'https://x.invalid/a.mp3'), null);
  assert.equal(chatwootAttachmentAlbumKind({}, 'https://x.invalid/a.PNG'), 'image');
  assert.equal(chatwootAttachmentAlbumKind({}, 'https://x.invalid/a.pdf'), null);
  assert.equal(chatwootAttachmentAlbumKind({}, 'https://x.invalid/a'), null);
});

const stored = (part: any, state: string, whatsappMessageId?: string) => ({
  ...part,
  id: `operation-${part.partIndex}`,
  instanceId: 'instance-1',
  chatwootMessageId: 314,
  chatwootInboxId: 58,
  chatwootConversationId: 42,
  state,
  whatsappMessageId,
  preparationAttempts: 0,
  sendAttempts: whatsappMessageId ? 1 : 0,
  transportOutcomeUnresolved: false,
  callbackAttempts: 0,
  claimGeneration: 0,
});

test('the album container is never reported to Chatwoot as a delivery part', async () => {
  const parts = buildParts([image(10), image(11), pdf(12)]);
  const rows = parts.map((part) => stored(part, 'callback_pending', `WAID:${part.partIndex}`));
  const store = new ChatwootOutboundPrismaStore({
    chatwootOutboundOperation: { findMany: async () => rows },
  } as any);

  const status = await store.messageStatus(rows[0] as StoredChatwootOutboundOperation);
  assert.equal(status.outcome, 'success');
  assert.equal(status.leader, true);
  assert.deepEqual(
    status.callbackParts.map((part) => [part.sourceId, part.partIndex, part.partCount]),
    [
      ['WAID:1', 0, 3],
      ['WAID:2', 1, 3],
      ['WAID:3', 2, 3],
    ],
  );
  assert.equal(chatwootOutboundCallbackPartCount(rows[0] as StoredChatwootOutboundOperation), 3);
  assert.equal(chatwootOutboundCallbackPartCount(rows[1] as StoredChatwootOutboundOperation), 4);
});

test('a sent container whose media all failed is a failure; a failed container with sent media is partial', async () => {
  const parts = buildParts([image(10), image(11)]);
  const onlyContainer = [
    stored(parts[0], 'callback_pending', 'WAID:0'),
    stored(parts[1], 'failed'),
    stored(parts[2], 'failure_callback_pending'),
  ];
  const containerFailed = [
    stored(parts[0], 'failure_callback_pending'),
    stored(parts[1], 'callback_pending', 'WAID:1'),
    stored(parts[2], 'callback_pending', 'WAID:2'),
  ];
  const statusOf = async (rows: any[]) =>
    new ChatwootOutboundPrismaStore({ chatwootOutboundOperation: { findMany: async () => rows } } as any).messageStatus(
      rows[0],
    );

  const failure = await statusOf(onlyContainer);
  assert.equal(failure.outcome, 'failure');
  assert.deepEqual(failure.callbackParts, []);
  const partial = await statusOf(containerFailed);
  assert.equal(partial.outcome, 'partial_success');
  assert.deepEqual(
    partial.callbackParts.map((part) => part.sourceId),
    ['WAID:1', 'WAID:2'],
  );
});

const baileys = (sent: any[]) => {
  const wa: any = Object.create(BaileysStartupService.prototype);
  wa.whatsappNumber = async () => [{ exists: true, jid: '628123@s.whatsapp.net' }];
  wa.logger = { verbose() {}, debug() {}, error() {}, warn() {} };
  wa.configService = {
    get(key: string) {
      if (key === 'DATABASE') return { SAVE_DATA: { NEW_MESSAGE: false } };
      return { ENABLED: false };
    },
  };
  wa.localWebhook = { enabled: false };
  wa.localChatwoot = { enabled: false };
  wa.prepareMessage = (message: any) => message;
  wa.sendDataWebhook = () => undefined;
  wa.prepareMediaMessage = async () => ({ message: { imageMessage: { caption: 'x' } } });
  wa.sendMessage = async (sender: string, message: any, transport: any) => {
    await transport.beforeTransport?.();
    sent.push({ sender, message, transport });
    return {
      key: { id: transport.messageId, remoteJid: sender, fromMe: true },
      message,
      messageTimestamp: 1,
    };
  };
  return wa;
};

test('mediaMessage passes albumParentKey through with the resolved recipient', async () => {
  const sent: any[] = [];
  const wa = baileys(sent);
  await wa.mediaMessage(
    {
      number: '628123',
      mediatype: 'image',
      media: 'https://example.invalid/a.jpg',
      messageId: 'WDCHILD',
      albumParentKey: { fromMe: true, id: 'WDPARENT' },
    },
    null,
    true,
  );
  await wa.mediaMessage({ number: '628123', mediatype: 'image', media: 'https://example.invalid/b.jpg' }, null, true);

  assert.deepEqual(sent[0].transport.albumParentKey, {
    fromMe: true,
    id: 'WDPARENT',
    remoteJid: '628123@s.whatsapp.net',
  });
  assert.equal(sent[0].transport.messageId, 'WDCHILD');
  assert.equal(sent[1].transport.albumParentKey, undefined);
});

test('albumContainerMessage sends only the album header with the planned id and transport fence', async () => {
  const sent: any[] = [];
  const wa = baileys(sent);
  let fenced = 0;
  let committed: any;
  const result = await wa.albumContainerMessage(
    {
      number: '628123',
      expectedImageCount: 2,
      expectedVideoCount: 1,
      messageId: 'WDPARENT',
      beforeTransport: async () => {
        fenced += 1;
      },
      afterTransport: async (receipt: any) => {
        committed = receipt;
      },
    },
    true,
  );

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].message, { album: { expectedImageCount: 2, expectedVideoCount: 1 } });
  assert.equal(sent[0].transport.messageId, 'WDPARENT');
  assert.equal(fenced, 1);
  assert.equal(result.key.id, 'WDPARENT');
  assert.equal(committed.key.id, 'WDPARENT');
});

test('Chatwoot sendAttachment keeps albumParentKey for photos only, never for documents', async () => {
  const service: any = Object.create(ChatwootService.prototype);
  service.logger = { verbose() {}, debug() {}, error() {}, warn() {} };
  const calls: any[] = [];
  const waInstance = {
    mediaMessage: async (data: any) => {
      calls.push(data);
      return { key: { id: data.messageId } };
    },
  };
  const albumParentKey = { fromMe: true, id: 'WDPARENT' };

  await service.sendAttachment(waInstance, '628123', 'https://example.invalid/a.jpg', 'caption', {
    messageId: 'WD1',
    beforeTransport: async () => undefined,
    albumParentKey,
  });
  await service.sendAttachment(waInstance, '628123', 'https://example.invalid/b.pdf', undefined, {
    messageId: 'WD2',
    beforeTransport: async () => undefined,
    albumParentKey,
  });

  assert.equal(calls[0].mediatype, 'image');
  assert.deepEqual(calls[0].albumParentKey, albumParentKey);
  assert.equal(calls[0].caption, 'caption');
  assert.equal(calls[1].mediatype, 'document');
  assert.equal(calls[1].albumParentKey, undefined);
});

test('durable send: container with its planned id, then photos naming it, document outside the album', async () => {
  const parts = buildParts([image(10), image(11), pdf(12)]);
  const service: any = Object.create(ChatwootService.prototype);
  service.logger = { verbose() {}, debug() {}, error() {}, warn() {} };
  service.getQuotedMessage = async () => undefined;
  const containers: any[] = [];
  const media: any[] = [];
  const waInstance = {
    instanceId: 'instance-1',
    connectionStatus: { state: 'open' },
    albumContainerMessage: async (data: any) => {
      await data.beforeTransport?.();
      containers.push(data);
      return { key: { id: data.messageId } };
    },
    mediaMessage: async (data: any) => {
      await data.beforeTransport?.();
      media.push(data);
      return { key: { id: data.messageId } };
    },
  };
  const context = { instance: { instanceName: 'test-instance', instanceId: 'instance-1' }, waInstance };
  let fences = 0;
  for (const part of parts) {
    const result = await service.sendQueuedOutbound(
      stored(part, 'sending'),
      context,
      async () => {
        fences += 1;
      },
      new AbortController().signal,
    );
    assert.equal(result.whatsappMessageId, part.plannedWhatsappMessageId);
  }

  assert.equal(fences, 4);
  assert.deepEqual(
    containers.map((data) => [data.messageId, data.expectedImageCount, data.expectedVideoCount]),
    [[parts[0].plannedWhatsappMessageId, 2, 0]],
  );
  assert.deepEqual(
    media.map((data) => [data.mediatype, data.albumParentKey?.id, data.caption]),
    [
      ['image', parts[0].plannedWhatsappMessageId, 'caption'],
      ['image', parts[0].plannedWhatsappMessageId, undefined],
      ['document', undefined, undefined],
    ],
  );
});
