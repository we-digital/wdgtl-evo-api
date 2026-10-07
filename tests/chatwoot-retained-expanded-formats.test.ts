import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createCipheriv, createHmac } from 'node:crypto';
import { getMediaKeys } from 'baileys';
import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import {
  retainedHistoryMedia,
  retainedTemplate,
  retainedButtons,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';
import {
  albumImageCount,
  preserveAlbumContainers,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-album';
import { ignoredNullEditProof } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ignored-history-edit';
import {
  prepareCachedRecoveryMedia,
  readRetainedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
const b64 = Buffer.alloc(32, 4).toString('base64');
const long = { low: 3, high: 0, unsigned: false };
const metadata = {
  messageCount: long,
  oldestMessageTimestamp: long,
  historyReceivers: ['628111111111@s.whatsapp.net'],
};
const key = { id: 'SYNTHETIC', remoteJid: '628111111111@lid', fromMe: false };
const base = { id: 'synthetic', instanceId: 'owned', key, messageTimestamp: 123, status: 'EDITED' };

test('protocol history bundles and notices retain exact typed metadata without customer content', () => {
  const bundle = {
    mimetype: 'application/protobuf',
    fileSha256: b64,
    fileEncSha256: b64,
    mediaKey: b64,
    directPath: '/native-protocol',
    mediaKeyTimestamp: long,
    messageHistoryMetadata: metadata,
  };
  for (const body of [
    { messageHistoryBundle: bundle },
    {
      messageHistoryBundle: bundle,
      messageContextInfo: { threadId: [], deviceListMetadata: { senderAccountType: 0 } },
    },
    { messageHistoryNotice: { messageHistoryMetadata: metadata }, messageContextInfo: { threadId: [] } },
  ])
    assert.equal(classifyCachedHistoryRecord({ messageType: 'unknown', message: body }, false), 'metadata_control');
  for (const body of [
    { messageHistoryBundle: { ...bundle, fileSha256: 'bad' } },
    { messageHistoryBundle: { ...bundle, unknown: true } },
    { messageHistoryBundle: bundle, conversation: 'visible' },
    { messageHistoryNotice: { messageHistoryMetadata: { ...metadata, messageCount: -1 } } },
    { messageHistoryNotice: { messageHistoryMetadata: metadata }, messageContextInfo: { threadId: ['unproved'] } },
  ])
    assert.throws(() => classifyCachedHistoryRecord({ messageType: 'unknown', message: body }, false));
});

test('zero-count album bookkeeping is explicit, versioned and cannot claim any children', async () => {
  const parent = {
    ...base,
    messageType: 'albumMessage',
    message: { albumMessage: { expectedImageCount: 0, expectedVideoCount: 0 } },
  };
  assert.throws(() => albumImageCount(parent));
  assert.equal(albumImageCount(parent, 'container_only'), 0);
  const proof = await preserveAlbumContainers(
    [parent],
    { findMany: async () => [structuredClone(parent)] },
    { connect: async () => assert.fail('No destination query') },
    1,
    39,
    'container_only',
  );
  await proof.assertCurrent();
  const p = proof.proofs.get('WAID:SYNTHETIC');
  assert.equal(p.expectedImages, 0);
  assert.equal(p.childrenQueried, false);
  assert.equal(p.childrenComplete, false);
  assert.equal(p.children, undefined);
  assert.deepEqual(JSON.parse(p.sourceNativeJSON), parent);
  for (const count of [-1, 14, 0.5])
    assert.throws(() =>
      albumImageCount(
        { ...parent, message: { albumMessage: { expectedImageCount: count, expectedVideoCount: 0 } } },
        'container_only',
      ),
    );
  assert.throws(() =>
    albumImageCount({ ...parent, message: { ...parent.message, conversation: 'visible' } }, 'container_only'),
  );
});

test('NULL edited contacts and albums use only exact ignored-native proof, never an ordinary-body omission', () => {
  for (const messageType of ['contactMessage', 'albumMessage']) {
    const source = { ...base, messageType, message: null };
    const state = {
      sourceRows: [source],
      targetUpdates: [{ id: 'edit', instanceId: 'owned', messageId: 'synthetic', status: 'EDITED' }],
      competitors: [],
    };
    assert.equal(classifyCachedHistoryRecord(source, true), 'unavailable_other_edit');
    const p = ignoredNullEditProof(source as any, state as any, 1, 39);
    assert.equal(p.destinationState, 'unqualified');
    assert.equal((p as any).destinationAbsent, undefined);
    assert.deepEqual(JSON.parse(p.sourceNativeJSON), source);
    assert.throws(() => ignoredNullEditProof({ ...source, status: 'READ' } as any, state as any, 1, 39));
    assert.throws(() => ignoredNullEditProof(source as any, { ...state, targetUpdates: [] } as any, 1, 39));
    assert.throws(() => classifyCachedHistoryRecord({ ...source, message: {} }, true));
  }
});

test('hydrated and interactive image templates plus plain buttons retain visible text and native media', () => {
  const image = { mimetype: 'image/jpeg', fileLength: 12, fileSha256: b64 };
  const hydrated = {
    templateMessage: {
      templateId: 'template',
      hydratedTemplate: {
        templateId: 'template',
        imageMessage: image,
        hydratedButtons: [{ index: 0, urlButton: { url: 'https://example.invalid', displayText: 'Open' } }],
        hydratedContentText: 'Retained body',
      },
    },
  };
  const interactive = {
    templateMessage: {
      templateId: 'template',
      contextInfo: { metadata: 'retained' },
      interactiveMessageTemplate: {
        body: { text: 'Retained body' },
        header: { imageMessage: image, hasMediaAttachment: true },
        nativeFlowMessage: {
          buttons: [
            {
              name: 'cta_url',
              buttonParamsJson: JSON.stringify({ display_text: 'Open', url: 'https://example.invalid' }),
            },
          ],
          messageParamsJson: '{}',
        },
      },
    },
  };
  for (const body of [hydrated, interactive]) {
    const before = JSON.stringify(body);
    assert.equal(classifyCachedHistoryRecord({ messageType: 'templateMessage', message: body }, false), 'ordinary');
    assert.match(retainedTemplate(body).text, /Retained body/);
    assert.match(retainedTemplate(body).text, /Open/);
    assert.equal(retainedHistoryMedia({ messageType: 'templateMessage', message: body } as any).type, 'imageMessage');
    assert.equal(JSON.stringify(body), before);
  }
  const buttons = {
    buttonsMessage: {
      buttons: [{ type: 1, buttonId: 'button', buttonText: { displayText: 'Retained label' } }],
      headerType: 1,
      contentText: 'Retained body',
    },
  };
  assert.equal(classifyCachedHistoryRecord({ messageType: 'buttonsMessage', message: buttons }, false), 'ordinary');
  assert.equal(retainedButtons(buttons).text, 'Retained body\nRetained label');
  assert.throws(() => retainedButtons({ buttonsMessage: { ...buttons.buttonsMessage, headerType: 2 } }));
  assert.throws(() => retainedTemplate({ ...hydrated, conversation: 'unknown' }));
});

test('lottie sticker bytes use one authenticated SDK sticker download and exact native WAS file proof', async () => {
  const plaintext = Buffer.from('synthetic native WAS file');
  const mediaKey = Buffer.alloc(32, 17);
  const keys = await getMediaKeys(mediaKey, 'sticker');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const encryptedBody = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac('sha256', keys.macKey)
    .update(Buffer.concat([keys.iv, encryptedBody]))
    .digest()
    .subarray(0, 10);
  const ciphertext = Buffer.concat([encryptedBody, mac]);
  const descriptor = {
    isLottie: true,
    mimetype: 'application/was',
    mediaKey: mediaKey.toString('base64'),
    directPath: '/synthetic-sticker',
    fileLength: plaintext.length,
    fileSha256: createHash('sha256').update(plaintext).digest('base64'),
    fileEncSha256: createHash('sha256').update(ciphertext).digest('base64'),
  };
  const source = {
    ...base,
    status: 'READ',
    messageType: 'lottieStickerMessage',
    message: { lottieStickerMessage: { message: { stickerMessage: descriptor } } },
  } as any;
  const before = JSON.stringify(source);
  let gets = 0;
  const result = await prepareCachedRecoveryMedia(
    [source],
    async () => null,
    async () => assert.fail('No stored Media'),
    async (m) =>
      readRetainedRecoveryMedia(m, undefined, (async () => {
        gets++;
        return new Response(ciphertext);
      }) as any),
  );
  assert.equal(gets, 1);
  assert.deepEqual(result.get(source.id)?.bytes, plaintext);
  assert.equal(result.get(source.id)?.descriptor.mimetype, 'application/was');
  assert.match(result.get(source.id)!.descriptor.filename, /\.was$/);
  assert.equal(retainedHistoryMedia(source).type, 'documentMessage');
  assert.equal(JSON.stringify(source), before);
  const corrupt = Buffer.from(ciphertext);
  corrupt[corrupt.length - 1] ^= 1;
  const changed = structuredClone(source);
  changed.message.lottieStickerMessage.message.stickerMessage.fileEncSha256 = createHash('sha256')
    .update(corrupt)
    .digest('base64');
  await assert.rejects(
    readRetainedRecoveryMedia(changed, undefined, (async () => new Response(corrupt)) as any),
    /crypto|bytes/,
  );
  assert.throws(() =>
    classifyCachedHistoryRecord({ ...source, message: { ...source.message, conversation: 'unexpected' } }, false),
  );
});
