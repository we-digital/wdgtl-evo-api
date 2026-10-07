import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import { getMediaKeys } from 'baileys';

import { readRetainedRecoveryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

async function fixture(family: 'image' | 'document') {
  const plaintext = Buffer.alloc(49298, 13);
  const key = Buffer.alloc(32, 6);
  const keys = await getMediaKeys(key, family);
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac('sha256', keys.macKey)
    .update(Buffer.concat([keys.iv, body]))
    .digest()
    .subarray(0, 10);
  const ciphertext = Buffer.concat([body, mac]);
  const row = {
    id: 'synthetic-jpeg-document',
    instanceId: 'synthetic-instance',
    messageType: 'documentMessage',
    key: { id: 'SYNTHETICJPEGDOC', remoteJid: '628111111111@s.whatsapp.net', fromMe: false },
    message: {
      documentMessage: {
        mimetype: 'image/jpeg',
        fileName: 'synthetic.jpg',
        fileLength: plaintext.length,
        fileSha256: createHash('sha256').update(plaintext).digest('base64'),
        fileEncSha256: createHash('sha256').update(ciphertext).digest('base64'),
        mediaKey: key.toString('base64'),
        directPath: '/synthetic-jpeg-document',
      },
    },
  } as any;
  return { plaintext, ciphertext, row };
}

test('native JPEG document authenticates Image keys on the same captured bytes; native envelope remains unchanged', async () => {
  for (const family of ['image', 'document'] as const) {
    const f = await fixture(family);
    const before = JSON.stringify(f.row);
    let requests = 0;
    const bytes = await readRetainedRecoveryMedia(f.row, undefined, (async (url: any, options: any) => {
      requests++;
      assert.equal(url, 'https://mmg.whatsapp.net/synthetic-jpeg-document');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert(options.signal instanceof AbortSignal);
      return new Response(f.ciphertext, { status: 200 });
    }) as any);
    assert(bytes.equals(f.plaintext));
    assert.equal(requests, 1);
    assert.equal(JSON.stringify(f.row), before);
  }
});

test('JPEG document inverse key family retains encrypted SHA, Image MAC and native plaintext SHA/size checks', async () => {
  for (const mutation of ['enc-sha', 'image-mac', 'plain-sha', 'size', 'key']) {
    const f = await fixture('image');
    const d = f.row.message.documentMessage;
    if (mutation === 'enc-sha') d.fileEncSha256 = Buffer.alloc(32).toString('base64');
    if (mutation === 'image-mac') {
      f.ciphertext[f.ciphertext.length - 1] ^= 1;
      d.fileEncSha256 = createHash('sha256').update(f.ciphertext).digest('base64');
    }
    if (mutation === 'plain-sha') d.fileSha256 = Buffer.alloc(32).toString('base64');
    if (mutation === 'size') d.fileLength++;
    if (mutation === 'key') d.mediaKey = Buffer.alloc(31).toString('base64');
    let requests = 0;
    await assert.rejects(() =>
      readRetainedRecoveryMedia(f.row, undefined, (async () => {
        requests++;
        return new Response(f.ciphertext, { status: 200 });
      }) as any),
    );
    assert.equal(requests, mutation === 'key' ? 0 : 1);
  }
});

test('Image keys are not selected for PDF, normalized wrapper documents, or other MIME variants', async () => {
  for (const mutation of ['pdf', 'jpeg-parameter', 'wrapper']) {
    const f = await fixture('image');
    if (mutation === 'pdf') f.row.message.documentMessage.mimetype = 'application/pdf';
    if (mutation === 'jpeg-parameter') f.row.message.documentMessage.mimetype = 'image/jpeg; charset=utf-8';
    if (mutation === 'wrapper') f.row.messageType = 'ephemeralMessage';
    await assert.rejects(() =>
      readRetainedRecoveryMedia(f.row, undefined, (async () => new Response(f.ciphertext)) as any),
    );
  }
});
