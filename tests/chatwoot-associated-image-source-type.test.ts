import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { proto } from 'baileys';

import { cachedMediaDescriptor } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import {
  retainedHistoryDisplayBody,
  retainedHistoryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';

const bytes = Buffer.from('synthetic associated JPEG');
const descriptor = {
  mimetype: 'image/jpeg',
  width: 2160,
  height: 3840,
  caption: 'original caption',
  fileLength: bytes.length,
  fileSha256: createHash('sha256').update(bytes).digest('base64'),
  fileEncSha256: Buffer.alloc(32, 1).toString('base64'),
  mediaKey: Buffer.alloc(32, 2).toString('base64'),
  mediaKeyTimestamp: 1700000000,
  url: 'https://mmg.whatsapp.net/synthetic',
  directPath: '/synthetic',
};
function record(image = descriptor) {
  return {
    id: 'native-source',
    instanceId: 'synthetic',
    messageType: 'associatedChildMessage',
    key: { id: 'provider-source', remoteJid: '120363000000@g.us', fromMe: false },
    message: { associatedChildMessage: { message: { imageMessage: image } } },
  } as any;
}
const media = {
  messageId: 'native-source',
  instanceId: 'synthetic',
  type: 'imageMessage',
  mimetype: 'image/jpeg',
  fileName: 'synthetic/120363000000@g.us/provider-source/imageMessage/synthetic.jpg',
} as any;

test('installed protobuf image source enums preserve the associated image and cache authority', () => {
  for (const imageSourceType of [0, 1, 2, 3]) {
    const encoded = proto.Message.ImageMessage.encode(
      proto.Message.ImageMessage.fromObject({ ...descriptor, imageSourceType }),
    ).finish();
    const native = proto.Message.ImageMessage.toObject(proto.Message.ImageMessage.decode(encoded), {
      bytes: String,
      longs: Number,
    });
    const source = record(native as any),
      before = JSON.stringify(source);
    assert.equal(retainedHistoryMedia(source).type, 'imageMessage');
    assert.deepEqual(retainedHistoryDisplayBody(source).imageMessage, native);
    assert.equal(cachedMediaDescriptor(source, media).digest.toString('base64'), descriptor.fileSha256);
    assert.equal(JSON.stringify(source), before);
  }
  assert.equal(retainedHistoryMedia(record()).type, 'imageMessage');
});

test('unknown or malformed source enums remain refused', () => {
  for (const imageSourceType of [null, '0', -1, 0.5, 4, true, {}, []]) {
    assert.throws(
      () => retainedHistoryMedia(record({ ...descriptor, imageSourceType } as any)),
      /wrapper is unsupported/,
    );
  }
});

test('known source metadata cannot bypass native media identity and digest guards', () => {
  const valid = { ...descriptor, imageSourceType: 0 };
  for (const change of [{ mimetype: 'application/pdf' }, { fileSha256: '' }, { mediaKey: '' }, { fileLength: 0 }]) {
    assert.throws(() => retainedHistoryMedia(record({ ...valid, ...change } as any)), /wrapper is unsupported/);
  }
  assert.throws(
    () => cachedMediaDescriptor(record(valid), { ...media, messageId: 'another-source' }),
    /authority_unavailable/,
  );
});
