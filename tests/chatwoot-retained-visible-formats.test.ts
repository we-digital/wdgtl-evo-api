import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import {
  prepareCachedRecoveryMedia,
  readRetainedRecoveryVideo,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import {
  retainedHistoryDisplayBody,
  retainedHistoryMedia,
  retainedTemplate,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';

const bytes = Buffer.from('synthetic video');
const descriptor = {
  fileSha256: createHash('sha256').update(bytes).digest('base64'),
  fileLength: bytes.length,
  mimetype: 'video/mp4',
  caption: 'retained caption',
};
const base = {
  id: 'native',
  instanceId: 'synthetic',
  key: { id: 'source', remoteJid: 'synthetic@g.us', fromMe: true },
};
const media = {
  messageId: base.id,
  instanceId: base.instanceId,
  type: 'videoMessage',
  mimetype: 'video/mp4',
  fileName: 'synthetic/synthetic@g.us/source/videoMessage/file.mp4',
};

test('associated video import copies preserve descriptor, caption and native authority; no provider fallback', async () => {
  const record: any = {
    ...base,
    messageType: 'associatedChildMessage',
    message: { associatedChildMessage: { message: { videoMessage: descriptor } } },
  };
  const before = JSON.stringify(record);
  assert.equal(classifyCachedHistoryRecord(record, false), 'ordinary');
  assert.deepEqual(retainedHistoryDisplayBody(record), { videoMessage: descriptor });
  const cached = await prepareCachedRecoveryMedia(
    [record],
    async () => media as any,
    async () => bytes,
  );
  assert.equal(
    cached.get(record.id)?.descriptor.digest.toString('hex'),
    createHash('sha256').update(bytes).digest('hex'),
  );
  assert.equal(JSON.stringify(record), before);
  await assert.rejects(
    () =>
      prepareCachedRecoveryMedia(
        [record],
        async () => null,
        async () => bytes,
      ),
    /authority_unavailable/,
  );
  await assert.rejects(
    () =>
      prepareCachedRecoveryMedia(
        [record],
        async () => media as any,
        async () => Buffer.from('wrong'),
      ),
    /bytes_mismatch/,
  );
  assert.throws(() =>
    retainedHistoryMedia({
      ...record,
      message: { associatedChildMessage: { parentMessageKey: {}, message: { videoMessage: descriptor } } },
    }),
  );
});

test('native templates preserve title, body, footer, actions and owned header media without placeholder mode', async () => {
  const hydrated = {
    templateMessage: {
      templateId: 'synthetic',
      hydratedTemplate: {
        templateId: 'synthetic',
        hydratedButtons: [],
        hydratedTitleText: 'title',
        hydratedContentText: 'body',
        hydratedFooterText: 'footer',
      },
    },
  };
  assert.equal(retainedTemplate(hydrated).text, 'title\nbody\nfooter');
  assert.equal(
    chatwootImport.getContentMessage({ getConversationMessage: () => '' } as any, { message: hydrated } as any, true),
    'title\nbody\nfooter',
  );
  const flow = {
    buttons: [
      {
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({
          display_text: 'button',
          url: 'https://example.test/path',
          extraNativeField: true,
        }),
      },
    ],
    messageParamsJson: JSON.stringify({ bottom_sheet: true }),
  };
  const body = {
    templateMessage: {
      templateId: 'synthetic',
      interactiveMessageTemplate: {
        body: { text: 'body' },
        header: { hasMediaAttachment: true, videoMessage: descriptor },
        nativeFlowMessage: flow,
      },
    },
  };
  const record: any = { ...base, messageType: 'templateMessage', message: body };
  const before = JSON.stringify(record);
  assert.equal(classifyCachedHistoryRecord(record, false), 'ordinary');
  assert.equal(retainedTemplate(body).text, 'body\nbutton: https://example.test/path');
  assert.deepEqual(retainedTemplate(body).metadata.native_flow, flow);
  const cached = await prepareCachedRecoveryMedia(
    [record],
    async () => media as any,
    async () => bytes,
  );
  assert.equal(cached.size, 1);
  assert.equal(JSON.stringify(record), before);
  assert.throws(() =>
    retainedTemplate({
      templateMessage: {
        ...hydrated.templateMessage,
        hydratedTemplate: { ...hydrated.templateMessage.hydratedTemplate, hydratedButtons: [{}] },
      },
    }),
  );
  assert.throws(() =>
    retainedTemplate({
      templateMessage: {
        ...body.templateMessage,
        interactiveMessageTemplate: {
          ...body.templateMessage.interactiveMessageTemplate,
          header: { hasMediaAttachment: false },
        },
      },
    }),
  );
});

test('contacts retain the complete native vCard; malformed or additional primary bodies refuse', async () => {
  const record: any = {
    ...base,
    messageType: 'contactMessage',
    message: {
      contactMessage: {
        vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Synthetic\nEND:VCARD',
        displayName: 'Synthetic',
      },
    },
  };
  assert.equal(classifyCachedHistoryRecord(record, false), 'ordinary');
  assert.equal(
    (
      await prepareCachedRecoveryMedia(
        [record],
        async () => {
          throw new Error('must not read media');
        },
        async () => bytes,
      )
    ).size,
    0,
  );
  assert.throws(() =>
    classifyCachedHistoryRecord({ ...record, message: { ...record.message, conversation: 'extra' } }, false),
  );
  assert.throws(() =>
    classifyCachedHistoryRecord({ ...record, message: { contactMessage: { vcard: 'truncated' } } }, false),
  );
});

test('necessary native video fetch is one bounded fixed-host read, with full plaintext digest before use', async () => {
  const key = Buffer.alloc(32, 1).toString('base64');
  const record: any = {
    ...base,
    messageType: 'associatedChildMessage',
    message: {
      associatedChildMessage: {
        message: { videoMessage: { ...descriptor, mediaKey: key, url: 'https://mmg.whatsapp.net/synthetic' } },
      },
    },
  };
  let calls = 0;
  const download = async (source: any, kind: any, options: any) => {
    calls++;
    assert.equal(source.url, 'https://mmg.whatsapp.net/synthetic');
    assert.equal(kind, 'video');
    assert.equal(options.options.redirect, 'error');
    assert.equal(options.options.signal instanceof AbortSignal, true);
    return Readable.from(bytes) as any;
  };
  const before = JSON.stringify(record);
  assert.equal((await readRetainedRecoveryVideo(record, download)).equals(bytes), true);
  assert.equal(calls, 1);
  const cached = await prepareCachedRecoveryMedia(
    [record],
    async () => null,
    async () => assert.fail('No unowned object read'),
    (message) => readRetainedRecoveryVideo(message, download),
  );
  assert.equal(cached.get(record.id)?.media, null);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(record), before);
  await assert.rejects(
    () => readRetainedRecoveryVideo(record, async () => Readable.from('bad') as any),
    /bytes_mismatch/,
  );
  await assert.rejects(() =>
    readRetainedRecoveryVideo(record, async () => {
      throw new Error('one failed read');
    }),
  );
  for (const url of [
    'http://mmg.whatsapp.net/a',
    'https://mmg.whatsapp.net.evil.test/a',
    'https://mmg.whatsapp.net@evil.test/a',
  ]) {
    const changed = structuredClone(record);
    changed.message.associatedChildMessage.message.videoMessage.url = url;
    await assert.rejects(() => readRetainedRecoveryVideo(changed, async () => assert.fail('No foreign transport')));
  }
});

test('an unavailable native media request aborts once at the read deadline and yields no import bytes', async () => {
  const record: any = {
    ...base,
    messageType: 'associatedChildMessage',
    message: {
      associatedChildMessage: {
        message: {
          videoMessage: {
            ...descriptor,
            mediaKey: Buffer.alloc(32, 1).toString('base64'),
            url: 'https://mmg.whatsapp.net/synthetic',
          },
        },
      },
    },
  };
  let calls = 0;
  let aborted = false;
  const started = Date.now();
  await assert.rejects(
    () =>
      readRetainedRecoveryVideo(record, async (_source, _kind, options: any) => {
        calls++;
        return await new Promise<any>((_resolve, reject) =>
          options.options.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('read aborted'));
            },
            { once: true },
          ),
        );
      }),
    /read aborted/,
  );
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal(Date.now() - started < 8000, true);
});
