import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  cachedMediaDescriptor,
  cachedMediaMIMEsEqual,
  prepareCachedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

const bytes = Buffer.from('synthetic-authenticated-opus');
function fixture() {
  const message = {
    id: 'native-audio',
    instanceId: 'synthetic-instance',
    messageType: 'audioMessage',
    key: { id: 'audio-key', remoteJid: '628111111111@s.whatsapp.net', fromMe: false },
    message: {
      audioMessage: {
        mimetype: 'audio/ogg; codecs=opus',
        fileName: 'synthetic.ogg',
        fileLength: bytes.length,
        fileSha256: createHash('sha256').update(bytes).digest('base64'),
      },
    },
  } as any;
  const media = {
    messageId: message.id,
    instanceId: message.instanceId,
    type: 'audioMessage',
    mimetype: 'audio/opus',
    fileName: `${message.instanceId}/${message.key.remoteJid}/audioMessage/1700000000000_synthetic.ogg`,
  } as any;
  return { message, media };
}

test('ordinary Opus stored MIME preserves native source, filename, size and SHA', async () => {
  const { message, media } = fixture();
  const original = JSON.stringify(message);
  const prepared = await prepareCachedRecoveryMedia(
    [message],
    async () => media,
    async () => bytes,
  );
  const result = prepared.get(message.id)!;
  assert.equal(result.descriptor.mimetype, 'audio/opus');
  assert.equal(result.descriptor.filename, 'synthetic.ogg');
  assert.equal(result.descriptor.size, bytes.length);
  assert.deepEqual(result.descriptor.digest, createHash('sha256').update(bytes).digest());
  assert.deepEqual(result.bytes, bytes);
  assert.equal(JSON.stringify(message), original);
  for (const native of ['audio/ogg', 'audio/ogg; codecs=opus']) {
    assert.equal(cachedMediaMIMEsEqual('audioMessage', native, 'audio/opus'), true);
  }
});

test('Opus alias cannot qualify another source family, codec or header', () => {
  for (const type of ['documentMessage', 'imageMessage', 'videoMessage', 'stickerMessage']) {
    assert.equal(cachedMediaMIMEsEqual(type, 'audio/ogg; codecs=opus', 'audio/opus'), false);
  }
  for (const stored of [
    'audio/aac',
    'audio/mpeg',
    'audio/opus; codecs=opus',
    'audio/OPUS',
    'audio/opus\r\nInjected: true',
  ]) {
    assert.equal(cachedMediaMIMEsEqual('audioMessage', 'audio/ogg; codecs=opus', stored), false);
  }
});

test('Opus normalization keeps owner, path, native digest and exact byte guards', async () => {
  const { message, media } = fixture();
  for (const patch of [
    { messageId: 'foreign' },
    { instanceId: 'foreign' },
    { type: 'documentMessage' },
    { fileName: media.fileName.replace(message.key.remoteJid, 'foreign-peer') },
  ]) {
    assert.throws(() => cachedMediaDescriptor(message, { ...media, ...patch }));
  }
  for (const corrupt of [Buffer.alloc(bytes.length), Buffer.from('wrong-size')]) {
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
        {
          ...message,
          message: {
            audioMessage: { ...message.message.audioMessage, ...patch },
          },
        },
        media,
      ),
    );
  }
});
