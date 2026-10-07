import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  cachedMediaDescriptor,
  prepareCachedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

const bytes = Buffer.from('synthetic-owned-zip');
const mimes = ['application/zip', 'application/x-zip-compressed'];
function fixture(mimetype: string) {
  const message = {
    id: 'native-zip',
    instanceId: 'synthetic-instance',
    messageType: 'documentMessage',
    key: { id: 'zip-key', remoteJid: '628111111111@s.whatsapp.net', fromMe: false },
    message: {
      documentMessage: {
        mimetype,
        fileName: 'synthetic.zip',
        fileLength: bytes.length,
        fileSha256: createHash('sha256').update(bytes).digest('base64'),
      },
    },
  } as any;
  const media = {
    messageId: message.id,
    instanceId: message.instanceId,
    type: message.messageType,
    mimetype,
    fileName: `${message.instanceId}/${message.key.remoteJid}/documentMessage/1700000000000_synthetic.zip`,
  } as any;
  return { message, media };
}

test('owned ZIP document aliases preserve native digest and stored MIME in both directions', async () => {
  for (const nativeMIME of mimes) {
    for (const storedMIME of mimes) {
      const { message, media } = fixture(nativeMIME);
      media.mimetype = storedMIME;
      const prepared = await prepareCachedRecoveryMedia(
        [message],
        async () => media,
        async () => bytes,
      );
      const item = prepared.get(message.id)!;
      assert.equal(item.descriptor.mimetype, storedMIME);
      assert.equal(item.descriptor.filename, 'synthetic.zip');
      assert.equal(item.descriptor.objectName, media.fileName);
      assert.equal(item.bytes.equals(bytes), true);
      assert.equal(item.descriptor.digest.equals(createHash('sha256').update(bytes).digest()), true);
    }
  }
});

test('ZIP equivalence cannot bypass owner, path, source type, MIME or byte authority', async () => {
  const { message, media } = fixture('application/x-zip-compressed');
  media.mimetype = 'application/zip';
  for (const patch of [
    { messageId: 'foreign-message' },
    { instanceId: 'foreign-instance' },
    { type: 'imageMessage' },
    { fileName: media.fileName.replace(message.key.remoteJid, 'foreign-peer') },
    { fileName: media.fileName.replace('synthetic.zip', '../synthetic.zip') },
    { mimetype: 'application/gzip' },
    { mimetype: 'application/zip; charset=utf-8' },
    { mimetype: 'application/ZIP' },
    { mimetype: 'application/zip\r\nInjected: true' },
  ]) {
    assert.throws(() => cachedMediaDescriptor(message, { ...media, ...patch }));
  }
  const image = {
    ...message,
    messageType: 'imageMessage',
    message: { imageMessage: message.message.documentMessage },
  };
  const imageMedia = {
    ...media,
    type: 'imageMessage',
    fileName: media.fileName.replace('documentMessage', 'imageMessage'),
  };
  assert.throws(() => cachedMediaDescriptor(image, imageMedia));
  for (const corrupt of [Buffer.from('wrong'), Buffer.alloc(bytes.length)]) {
    await assert.rejects(
      prepareCachedRecoveryMedia(
        [message],
        async () => media,
        async () => corrupt,
      ),
    );
  }
  for (const patch of [{ fileLength: 0 }, { fileSha256: Buffer.alloc(31).toString('base64') }]) {
    assert.throws(() =>
      cachedMediaDescriptor(
        { ...message, message: { documentMessage: { ...message.message.documentMessage, ...patch } } },
        media,
      ),
    );
  }
});
