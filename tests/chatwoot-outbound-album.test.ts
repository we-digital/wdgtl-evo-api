import assert from 'node:assert/strict';
import test from 'node:test';

import { BaileysStartupService } from '@api/integrations/channel/whatsapp/whatsapp.baileys.service';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { ChatwootOutboundPrismaStore } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-prisma-store';
import {
  buildChatwootOutboundParts,
  chatwootAttachmentAlbumKind,
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

test('permit send [pdf, photo, photo]: PDF first with the caption, then the photos as one album', () => {
  const parts = buildParts([image(12), pdf(10), image(11)]);
  const parent = parts[1].plannedWhatsappMessageId;

  assert.equal(parts.length, 4);
  assert.ok(parts.every((part) => part.partCount === 4 && part.messageSetHash === parts[0].messageSetHash));
  assert.deepEqual(
    parts.map((part) => part.payload.attachmentId),
    [10, undefined, 11, 12],
  );
  assert.deepEqual(parts[1].payload.album, { expectedImageCount: 2, expectedVideoCount: 0 });
  assert.equal(parts[1].payload.quotedChatwootMessageId, undefined);
  assert.deepEqual(
    parts.map((part) => part.payload.text),
    ['caption', null, null, null],
  );
  assert.deepEqual(
    parts.map((part) => part.payload.albumParentWhatsappMessageId),
    [undefined, undefined, parent, parent],
  );
  assert.ok([parts[0], parts[2], parts[3]].every((part) => part.payload.quotedChatwootMessageId === 99));
});

test('3 images + 1 pdf in upload order: album where the first photo stands, caption on that photo', () => {
  const parts = buildParts([image(10), pdf(11), image(12), image(13)]);
  const parent = parts[0].plannedWhatsappMessageId;

  assert.deepEqual(
    parts.map((part) => part.payload.attachmentId),
    [undefined, 10, 12, 13, 11],
  );
  assert.deepEqual(parts[0].payload.album, { expectedImageCount: 3, expectedVideoCount: 0 });
  assert.deepEqual(
    parts.map((part) => part.payload.text),
    [null, 'caption', null, null, null],
  );
  assert.deepEqual(
    parts.map((part) => part.payload.albumParentWhatsappMessageId),
    [undefined, parent, parent, parent, undefined],
  );
  assert.equal(new Set(parts.map((part) => part.plannedWhatsappMessageId)).size, 5);
});

test('mixed [pdf, photo, pdf, photo] keeps upload order around the album', () => {
  const parts = buildParts([pdf(1), image(2), pdf(3), image(4)]);
  assert.deepEqual(
    parts.map((part) => (part.payload.album ? 'album' : part.payload.attachmentId)),
    [1, 'album', 2, 4, 3],
  );
  assert.deepEqual(
    parts.map((part) => part.payload.text),
    ['caption', null, null, null, null],
  );
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
    [9, undefined, 10, 11],
  );
  const changed = buildParts([image(10), pdf(9), image(12)]);
  assert.notEqual(changed[0].messageSetHash, first[0].messageSetHash);
  assert.notEqual(changed[1].plannedWhatsappMessageId, first[1].plannedWhatsappMessageId);
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
  assert.equal(status.expectedCallbackParts, 3);
  // A document leader (permit order) still expects every media part, not the container.
  const permit = buildParts([pdf(10), image(11), image(12)]).map((part) =>
    stored(part, 'callback_pending', `WAID:${part.partIndex}`),
  );
  const permitStatus = await new ChatwootOutboundPrismaStore({
    chatwootOutboundOperation: { findMany: async () => permit },
  } as any).messageStatus(permit[0] as StoredChatwootOutboundOperation);
  assert.equal(permitStatus.leader, true);
  assert.equal(permitStatus.expectedCallbackParts, 3);
  assert.deepEqual(
    permitStatus.callbackParts.map((part) => part.sourceId),
    ['WAID:0', 'WAID:2', 'WAID:3'],
  );
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

test('flag off: the plan is exactly the pre-album one, planned ids included', () => {
  const service: any = Object.create(ChatwootService.prototype);
  service.configService = { get: () => ({ OUTBOUND_ALBUMS_ENABLED: false }) };
  service.waMonitor = { waInstances: {} };
  assert.equal(service.outboundAlbumsSupported({ instanceName: 'test-instance' }), false);
  service.configService = { get: () => ({ OUTBOUND_ALBUMS_ENABLED: true }) };
  assert.equal(service.outboundAlbumsSupported({ instanceName: 'test-instance' }), true);
  service.waMonitor = { waInstances: { 'test-instance': { mediaMessage() {} } } };
  assert.equal(service.outboundAlbumsSupported({ instanceName: 'test-instance' }), false);

  // Values produced by origin/main (before albums) for the same message.
  const parts = buildParts([image(12), pdf(10), image(11)], false);
  assert.equal(parts[0].messageSetHash, 'b17ca25f9f0b1812ab8a64c4b3123f3e82e3e17b8cbb055541b4e5858bd28b68');
  assert.deepEqual(
    parts.map((part) => [part.payload.attachmentId, part.plannedWhatsappMessageId, part.payload.text]),
    [
      [10, 'WD08AEF7F8AB948A647E', 'caption'],
      [11, 'WDC9DC987F61EA51D49F', null],
      [12, 'WD03F9954AE2F6F9B7ED', null],
    ],
  );
  assert.ok(parts.every((part) => !('album' in part.payload) && !('albumParentWhatsappMessageId' in part.payload)));
});

// Drives sendQueuedOutbound part by part like the lane does, keeping each
// part's durable row in a fake store that the album lookups read.
const durableSend = async (parts: any[], options: { headerFails?: boolean } = {}) => {
  const service: any = Object.create(ChatwootService.prototype);
  service.logger = { verbose() {}, debug() {}, error() {}, warn() {} };
  service.getQuotedMessage = async () => undefined;
  const rows = parts.map((part) => stored(part, 'pending'));
  service.outboundStore = { retainedOperations: async () => rows };
  const containers: any[] = [];
  const media: any[] = [];
  const errors: string[] = [];
  const waInstance = {
    instanceId: 'instance-1',
    connectionStatus: { state: 'open' },
    albumContainerMessage: async (data: any) => {
      await data.beforeTransport?.();
      containers.push(data);
      if (options.headerFails) throw Object.assign(new Error('relay failed'), { name: 'RelayFailed' });
      return { key: { id: data.messageId } };
    },
    mediaMessage: async (data: any) => {
      await data.beforeTransport?.();
      media.push(data);
      return { key: { id: data.messageId } };
    },
  };
  const context = { instance: { instanceName: 'test-instance', instanceId: 'instance-1' }, waInstance };
  for (const row of rows) {
    row.state = 'sending';
    try {
      const result = await service.sendQueuedOutbound(
        row,
        context,
        async () => undefined,
        new AbortController().signal,
      );
      Object.assign(row, { state: 'callback_pending', whatsappMessageId: result.whatsappMessageId });
    } catch (error) {
      errors.push(error.name);
      row.state = 'failed';
    }
  }
  return { containers, media, errors };
};

test('durable permit send: PDF with caption, album header, photos joined to it', async () => {
  const parts = buildParts([pdf(10), image(11), image(12)]);
  const parent = parts[1].plannedWhatsappMessageId;
  const { containers, media, errors } = await durableSend(parts);

  assert.deepEqual(errors, []);
  assert.deepEqual(
    containers.map((data) => [data.messageId, data.expectedImageCount, data.expectedVideoCount]),
    [[parent, 2, 0]],
  );
  assert.deepEqual(
    media.map((data) => [data.mediatype, data.albumParentKey?.id, data.caption]),
    [
      ['document', undefined, 'caption'],
      ['image', parent, undefined],
      ['image', parent, undefined],
    ],
  );
});

test('a failed album header leaves no orphans: its photos go out as plain single media', async () => {
  const parts = buildParts([image(10), image(11), pdf(12)]);
  const { containers, media, errors } = await durableSend(parts, { headerFails: true });

  assert.equal(containers.length, 1);
  assert.deepEqual(errors, ['RelayFailed']);
  assert.deepEqual(
    media.map((data) => [data.mediatype, data.albumParentKey, data.caption]),
    [
      ['image', undefined, 'caption'],
      ['image', undefined, undefined],
      ['document', undefined, undefined],
    ],
  );
});

test('header counts use the sender type decision; a member sent as document does not join', async () => {
  // Chatwoot calls all three images, but one is served as a PDF.
  const parts = buildParts([
    image(10),
    image(11),
    { id: 12, file_type: 'image', data_url: 'https://example.invalid/x.pdf' },
  ]);
  const parent = parts[0].plannedWhatsappMessageId;
  assert.deepEqual(parts[0].payload.album, { expectedImageCount: 3, expectedVideoCount: 0 });
  const { containers, media } = await durableSend(parts);

  assert.deepEqual(
    containers.map((data) => [data.expectedImageCount, data.expectedVideoCount]),
    [[2, 0]],
  );
  assert.deepEqual(
    media.map((data) => [data.mediatype, data.albumParentKey?.id]),
    [
      ['image', parent],
      ['image', parent],
      ['document', undefined],
    ],
  );
});

test('an album with fewer than two real photos sends no header and the photo goes out alone', async () => {
  const parts = buildParts([image(10), { id: 11, file_type: 'image', data_url: 'https://example.invalid/x.pdf' }]);
  const { containers, media, errors } = await durableSend(parts);

  assert.equal(containers.length, 0);
  assert.deepEqual(errors, ['AlbumNotNeeded']);
  assert.deepEqual(
    media.map((data) => [data.mediatype, data.albumParentKey, data.caption]),
    [
      ['image', undefined, 'caption'],
      ['document', undefined, undefined],
    ],
  );
});
