import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import { getMediaKeys } from 'baileys';

import {
  cachedMediaMIMEsEqual,
  prepareCachedRecoveryMedia,
  readRetainedRecoveryMedia,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

async function fixture(type: 'audio' | 'video') {
  const bytes = Buffer.alloc(8192, 9);
  const key = Buffer.alloc(32, 7);
  const keys = await getMediaKeys(key, type);
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const mac = createHmac('sha256', keys.macKey)
    .update(Buffer.concat([keys.iv, body]))
    .digest()
    .subarray(0, 10);
  const encrypted = Buffer.concat([body, mac]);
  const descriptor = {
    mimetype: type === 'audio' ? 'audio/ogg; codecs=opus' : 'video/mp4',
    fileLength: bytes.length,
    fileSha256: createHash('sha256').update(bytes).digest('base64'),
    fileEncSha256: createHash('sha256').update(encrypted).digest('base64'),
    mediaKey: key.toString('base64'),
    directPath: `/synthetic-${type}`,
  };
  const message = {
    id: `synthetic-${type}`,
    instanceId: 'synthetic-instance',
    messageType: `${type}Message`,
    key: { id: `synthetic-${type}`, remoteJid: '628111111111@s.whatsapp.net', fromMe: false },
    message: { [`${type}Message`]: descriptor },
  } as any;
  return { bytes, encrypted, descriptor, message };
}

test('missing ordinary Opus audio and MP4 use one bounded default SDK family with full SHA/MAC/size', async () => {
  for (const type of ['audio', 'video'] as const) {
    const f = await fixture(type);
    const before = JSON.stringify(f.message);
    let requests = 0;
    const prepared = await prepareCachedRecoveryMedia(
      [f.message],
      async () => null,
      async () => assert.fail('No owned object for Media0'),
      async (message) =>
        readRetainedRecoveryMedia(message, undefined, (async (url: any, options: any) => {
          requests++;
          assert.equal(url, `https://mmg.whatsapp.net/synthetic-${type}`);
          assert.equal(options.method, 'GET');
          assert.equal(options.redirect, 'error');
          assert(options.signal instanceof AbortSignal);
          assert(options.dispatcher);
          return new Response(f.encrypted, { status: 200 });
        }) as any),
    );
    const actual = prepared.get(f.message.id)!;
    assert.equal(requests, 1);
    assert(actual.bytes.equals(f.bytes));
    assert.equal(actual.descriptor.filename, `synthetic-${type}.${type === 'audio' ? 'ogg' : 'mp4'}`);
    assert.equal(actual.descriptor.mimetype, f.descriptor.mimetype);
    assert.equal(JSON.stringify(f.message), before);
  }
});

test('audio/video refuse native encrypted/plain digest, MAC, key, size and MIME contradictions without retries', async () => {
  for (const type of ['audio', 'video'] as const) {
    for (const mutation of ['enc-sha', 'mac', 'plain-sha', 'size', 'key', 'mime', 'direction', 'url']) {
      const f = await fixture(type);
      let encrypted = f.encrypted;
      if (mutation === 'enc-sha') f.descriptor.fileEncSha256 = Buffer.alloc(32).toString('base64');
      if (mutation === 'mac') {
        encrypted = Buffer.from(encrypted);
        encrypted[encrypted.length - 1] ^= 1;
        f.descriptor.fileEncSha256 = createHash('sha256').update(encrypted).digest('base64');
      }
      if (mutation === 'plain-sha') f.descriptor.fileSha256 = Buffer.alloc(32).toString('base64');
      if (mutation === 'size') f.descriptor.fileLength++;
      if (mutation === 'key') f.descriptor.mediaKey = Buffer.alloc(31).toString('base64');
      if (mutation === 'mime') f.descriptor.mimetype = type === 'audio' ? 'audio/mpeg' : 'video/unknown';
      if (mutation === 'direction') f.message.key.fromMe = null;
      if (mutation === 'url') f.descriptor.directPath = '//foreign.invalid/object';
      let requests = 0;
      await assert.rejects(() =>
        readRetainedRecoveryMedia(f.message, undefined, (async () => {
          requests++;
          return new Response(encrypted, { status: 200 });
        }) as any),
      );
      assert.equal(requests, ['key', 'mime', 'direction', 'url'].includes(mutation) ? 0 : 1);
    }
  }
});

test('only exact observed document archive and audio Opus MIME aliases are equivalent', () => {
  for (const [type, one, two] of [
    ['documentMessage', 'application/zip', 'application/x-zip-compressed'],
    ['documentMessage', 'application/rar', 'application/vnd.rar'],
    ['audioMessage', 'audio/ogg', 'audio/ogg; codecs=opus'],
  ]) {
    assert.equal(cachedMediaMIMEsEqual(type, one, two), true);
    assert.equal(cachedMediaMIMEsEqual(type, two, one), true);
    assert.equal(cachedMediaMIMEsEqual('imageMessage', one, two), false);
    assert.equal(cachedMediaMIMEsEqual(type, one, `${two}; injected=1`), false);
    assert.equal(cachedMediaMIMEsEqual(type, one, `${two}\r\nInjected: true`), false);
    assert.equal(cachedMediaMIMEsEqual(type, one, two.toUpperCase()), false);
  }
});
