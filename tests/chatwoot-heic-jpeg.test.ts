import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  heicMediaAsJpeg,
  isHeicMedia,
  jpegFileName,
  mediaConverterConfig,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-heic-jpeg';

const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const env = { MEDIA_CONVERTER_URL: 'https://converter.test/', MEDIA_CONVERTER_API_KEY: 'k' } as NodeJS.ProcessEnv;

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('HEIC is found by mimetype, extension or ftyp brand', () => {
  const other = Buffer.from('not heic at all');
  assert.ok(isHeicMedia({ bytes: other, fileName: 'a.bin', mimetype: 'image/heic' }));
  assert.ok(isHeicMedia({ bytes: other, fileName: 'IMG_1.HEIF', mimetype: 'application/octet-stream' }));
  assert.ok(isHeicMedia({ bytes: heic, fileName: 'abc.', mimetype: null }));
  assert.ok(!isHeicMedia({ bytes: jpeg, fileName: 'a.jpg', mimetype: 'image/jpeg' }));
});

test('converted names end in .jpg', () => {
  assert.equal(jpegFileName('IMG_0001-42.HEIC'), 'IMG_0001-42.jpg');
  assert.equal(jpegFileName('x.heif'), 'x.jpg');
  assert.equal(jpegFileName('abc.'), 'abc.jpg');
  assert.equal(jpegFileName('photo'), 'photo.jpg');
});

test('the converter is off without URL and key', async () => {
  assert.equal(mediaConverterConfig({} as NodeJS.ProcessEnv), null);
  const { impl, calls } = fakeFetch(() => new Response(jpeg));
  const result = await heicMediaAsJpeg({ bytes: heic, fileName: 'a.heic' }, undefined, {}, impl);
  assert.equal(result.converted, false);
  assert.equal(calls.length, 0);
});

test('HEIC is sent to the converter and replaced by its JPEG', async () => {
  const { impl, calls } = fakeFetch(() => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }));
  const events: string[] = [];
  const result = await heicMediaAsJpeg(
    { bytes: heic, fileName: 'IMG_1-10.HEIC', mimetype: 'image/heic' },
    (event) => events.push(event),
    env,
    impl,
  );
  assert.equal(calls[0].url, 'https://converter.test/v1/media/jpeg');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer k');
  assert.deepEqual(result, { bytes: jpeg, fileName: 'IMG_1-10.jpg', mimetype: 'image/jpeg', converted: true });
  assert.deepEqual(events, ['chatwoot_heic_converted']);
});

test('other media never reaches the converter', async () => {
  const { impl, calls } = fakeFetch(() => new Response(jpeg));
  const media = { bytes: jpeg, fileName: 'a.jpg', mimetype: 'image/jpeg' };
  const result = await heicMediaAsJpeg(media, undefined, env, impl);
  assert.equal(result.converted, false);
  assert.equal(result.bytes, jpeg);
  assert.equal(calls.length, 0);
});

test('converter errors keep the original and log only the error class', async () => {
  for (const response of [
    () => new Response('no', { status: 415 }),
    () => new Response(Buffer.from('not a jpeg')),
    () => Promise.reject(Object.assign(new Error('timeout IMG_1.HEIC'), { name: 'TimeoutError' })),
  ]) {
    const { impl } = fakeFetch(response);
    const logged: Record<string, unknown>[] = [];
    const media = { bytes: heic, fileName: 'IMG_1.HEIC', mimetype: 'image/heic' };
    const result = await heicMediaAsJpeg(media, (_event, fields) => logged.push(fields), env, impl);
    assert.equal(result.converted, false);
    assert.equal(result.bytes, heic);
    assert.equal(result.fileName, 'IMG_1.HEIC');
    assert.equal(logged.length, 1);
    assert.deepEqual(Object.keys(logged[0]).sort(), ['errorClass', 'ms']);
    assert.ok(!JSON.stringify(logged[0]).includes('IMG_1'));
  }
});
