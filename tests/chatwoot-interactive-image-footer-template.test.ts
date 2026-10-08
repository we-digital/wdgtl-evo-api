import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { prepareCachedRecoveryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import {
  retainedHistoryMedia,
  retainedNativeJPEGDescriptor,
  retainedTemplate,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';

const bytes = Buffer.from('synthetic authenticated image bytes');
const b64 = Buffer.alloc(32, 1).toString('base64');
const image = {
  url: 'https://mmg.whatsapp.net/image.enc',
  directPath: '/image.enc',
  width: 2250,
  height: 2250,
  mediaKey: b64,
  mimetype: 'image/jpeg',
  fileLength: { low: bytes.length, high: 0, unsigned: true },
  fileSha256: createHash('sha256').update(bytes).digest('base64'),
  fileEncSha256: b64,
  mediaKeyTimestamp: { low: 100, high: 0, unsigned: true },
  jpegThumbnail: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]).toString('base64'),
  thumbnailSha256: b64,
  thumbnailEncSha256: b64,
  thumbnailDirectPath: '/thumbnail.enc',
  contextInfo: { mentionedJid: [], groupMentions: [], statusAttributions: [] },
};
const record = () => ({
  id: 'synthetic-native-id',
  instanceId: 'synthetic-owner',
  key: { id: 'synthetic-key', remoteJid: '100001@lid', fromMe: false },
  messageType: 'templateMessage',
  messageTimestamp: 100,
  message: {
    templateMessage: {
      templateId: 'synthetic-template',
      interactiveMessageTemplate: {
        body: { text: 'exact native body' },
        footer: { text: 'exact native footer' },
        header: { hasMediaAttachment: true, imageMessage: structuredClone(image) },
        nativeFlowMessage: {
          buttons: [
            {
              name: 'cta_url',
              buttonParamsJson: JSON.stringify({
                display_text: 'label',
                url: 'https://example.test/path',
                landing_page_url: 'https://example.test/landing',
                webview_presentation: null,
                payment_link_preview: false,
                merchant_payment_link_preview: false,
                webview_interaction: false,
              }),
            },
          ],
          messageParamsJson: JSON.stringify({
            bottom_sheet: { in_thread_buttons_limit: 1 },
            tap_target_configuration: { button_index: 0 },
            tap_target_list: [],
          }),
        },
      },
    },
  },
});

test('typed image template preserves body, footer, image, flow and current native authority', () => {
  const source = record();
  const original = structuredClone(source);
  const decoded = retainedTemplate(source.message);
  assert.equal(classifyCachedHistoryRecord(source, false), 'ordinary');
  assert.equal(decoded.text, 'exact native body\nexact native footer\nlabel: https://example.test/path');
  assert.deepEqual(decoded.image, image);
  assert.deepEqual(decoded.metadata.header, source.message.templateMessage.interactiveMessageTemplate.header);
  assert.deepEqual(decoded.metadata.footer, { text: 'exact native footer' });
  assert.deepEqual(
    decoded.metadata.native_flow,
    source.message.templateMessage.interactiveMessageTemplate.nativeFlowMessage,
  );
  assert.deepEqual(retainedHistoryMedia(source as any), { type: 'imageMessage', descriptor: image });
  assert.deepEqual(source, original);
});

test('an additional native image caption is retained without duplicating the body', () => {
  const source: any = record();
  source.message.templateMessage.interactiveMessageTemplate.header.imageMessage.caption = 'image caption';
  assert.equal(
    retainedTemplate(source.message).text,
    'exact native body\nimage caption\nexact native footer\nlabel: https://example.test/path',
  );
  source.message.templateMessage.interactiveMessageTemplate.header.imageMessage.caption = 'exact native body';
  assert.equal(
    retainedTemplate(source.message).text,
    'exact native body\nexact native footer\nlabel: https://example.test/path',
  );
});

for (const [name, mutate] of Object.entries({
  unknownImage: (v: any) => {
    v.header.imageMessage.unknownNativeNode = true;
  },
  extraHeader: (v: any) => {
    v.header.documentMessage = {};
  },
  videoAndImage: (v: any) => {
    v.header.videoMessage = {};
  },
  absentMediaFlag: (v: any) => {
    delete v.header.hasMediaAttachment;
  },
  invalidFooter: (v: any) => {
    v.footer.text = {};
  },
  extraFooter: (v: any) => {
    v.footer.unknown = true;
  },
  extraBody: (v: any) => {
    v.body.action = {};
  },
  unknownFlow: (v: any) => {
    v.nativeFlowMessage.action = 'run';
  },
  unsupportedAction: (v: any) => {
    v.nativeFlowMessage.buttons[0].name = 'payment';
  },
  unsafeURL: (v: any) => {
    v.nativeFlowMessage.buttons[0].buttonParamsJson = JSON.stringify({
      display_text: 'label',
      url: 'javascript:run()',
    });
  },
  malformedJSON: (v: any) => {
    v.nativeFlowMessage.messageParamsJson = '{';
  },
  unknownActionField: (v: any) => {
    v.nativeFlowMessage.buttons[0].buttonParamsJson = JSON.stringify({
      display_text: 'label',
      url: 'https://example.test',
      execute: true,
    });
  },
})) {
  test(`image template rejects ${name} without changing the native row`, () => {
    const source = record();
    mutate(source.message.templateMessage.interactiveMessageTemplate);
    const raw = JSON.stringify(source);
    assert.throws(() => retainedTemplate(source.message));
    assert.equal(JSON.stringify(source), raw);
  });
}

for (const [name, mutate] of Object.entries({
  malformedThumbnail: (v: any) => {
    v.jpegThumbnail = 'not base64';
  },
  nonJPEGThumbnail: (v: any) => {
    v.jpegThumbnail = Buffer.from('not jpeg').toString('base64');
  },
  oversizedThumbnail: (v: any) => {
    v.jpegThumbnail = Buffer.alloc(16385).toString('base64');
  },
  invalidThumbnailHash: (v: any) => {
    v.thumbnailSha256 = Buffer.alloc(31).toString('base64');
  },
  partialThumbnailPointer: (v: any) => {
    delete v.thumbnailEncSha256;
  },
  unsafeThumbnailPath: (v: any) => {
    v.thumbnailDirectPath = '//foreign.test/path';
  },
  thumbnailPathWhitespace: (v: any) => {
    v.thumbnailDirectPath = '/invalid path';
  },
  changedFileAuthority: (v: any) => {
    v.fileSha256 = 'invalid';
  },
})) {
  test(`JPEG metadata rejects ${name}`, () => {
    const descriptor: any = structuredClone(image);
    mutate(descriptor);
    assert.equal(retainedNativeJPEGDescriptor(descriptor), false);
    const source: any = record();
    source.message.templateMessage.interactiveMessageTemplate.header.imageMessage = descriptor;
    assert.throws(() => retainedTemplate(source.message));
  });
}

test('verified cached bytes use the ordinary owned file path without provider calls', async () => {
  const source = record();
  const raw = JSON.stringify(source);
  let downloads = 0;
  const media: any = {
    messageId: source.id,
    instanceId: source.instanceId,
    type: 'imageMessage',
    mimetype: 'image/jpeg',
    fileName: `${source.instanceId}/${source.key.remoteJid}/${source.key.id}/imageMessage/image.jpg`,
  };
  const ready = await prepareCachedRecoveryMedia(
    [source as any],
    async () => media,
    async () => bytes,
    async () => {
      downloads++;
      return bytes;
    },
  );
  assert.equal(ready.get(source.id)?.bytes.length, bytes.length);
  assert.equal(downloads, 0);
  assert.equal(JSON.stringify(source), raw);
  await assert.rejects(
    () =>
      prepareCachedRecoveryMedia(
        [source as any],
        async () => ({ ...media, instanceId: 'foreign' }),
        async () => bytes,
      ),
    /authority_unavailable/,
  );
  await assert.rejects(
    () =>
      prepareCachedRecoveryMedia(
        [source as any],
        async () => media,
        async () => Buffer.from('wrong'),
      ),
    /bytes_mismatch/,
  );
  await assert.rejects(
    () =>
      prepareCachedRecoveryMedia(
        [source as any],
        async () => null,
        async () => bytes,
      ),
    /authority_unavailable/,
  );
});
