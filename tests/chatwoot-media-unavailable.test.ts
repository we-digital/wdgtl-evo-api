import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deliverWithoutMedia,
  mediaFailureKind,
  mediaUnavailableContent,
  mediaUnavailableLabel,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-media-unavailable';
import { nativeMediaBytes } from '../src/api/integrations/channel/whatsapp/native-media-refresh';

test('observed prod media failures are classified', () => {
  for (const message of [
    'native_media_refresh_deadline_unknown_no_retry',
    'native_media_refresh_source_nonunique',
    'Error: error:1C800064:Provider routines::bad decrypt',
    'Failed to re-upload media (2)',
    'native_media_refresh_bytes_unqualified',
    'InboundNativeMediaBytesUnconfirmed',
    'Request failed with status code 404',
  ])
    assert.equal(mediaFailureKind(new Error(message)), 'unavailable', message);
  for (const message of [
    'connect ETIMEDOUT 1.2.3.4:443',
    'socket hang up',
    'Request failed with status code 503',
    'native_media_refresh_persistence_CAS_refused',
  ])
    assert.equal(mediaFailureKind(new Error(message)), 'transient', message);
  assert.equal(mediaFailureKind('Message not found'), 'unavailable');
  assert.equal(mediaFailureKind(new Error('new kind of failure')), 'unknown');
});

test('fallback policy: unavailable now, unknown after 3 attempts, transient after 12', () => {
  assert.equal(deliverWithoutMedia('unavailable', 0), true);
  assert.equal(deliverWithoutMedia('unknown', 2), false);
  assert.equal(deliverWithoutMedia('unknown', 3), true);
  assert.equal(deliverWithoutMedia('transient', 11), false);
  assert.equal(deliverWithoutMedia('transient', 12), true);
});

test('placeholders per media type, in English, with caption and document name', () => {
  assert.equal(mediaUnavailableLabel({ imageMessage: {} }), '[Photo — file no longer available]');
  assert.equal(mediaUnavailableLabel({ videoMessage: {} }), '[Video — file no longer available]');
  assert.equal(mediaUnavailableLabel({ audioMessage: {} }), '[Audio — file no longer available]');
  assert.equal(mediaUnavailableLabel({ audioMessage: { ptt: true } }), '[Voice message — file no longer available]');
  assert.equal(mediaUnavailableLabel({ stickerMessage: {} }), '[Sticker — file no longer available]');
  assert.equal(
    mediaUnavailableLabel({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'kitas.pdf' } } } }),
    '[Document “kitas.pdf” — file no longer available]',
  );
  assert.equal(mediaUnavailableLabel({ conversation: 'text' }), null);
  assert.equal(
    mediaUnavailableContent('caption', { imageMessage: {} }),
    'caption\n\n[Photo — file no longer available]',
  );
  assert.equal(mediaUnavailableContent('', { imageMessage: {} }), '[Photo — file no longer available]');
});

test('media key bytes are raw for every stored encoding (frozen object keys gave "bad decrypt")', () => {
  const raw = Buffer.alloc(32, 7);
  const expected = [...raw];
  for (const value of [
    raw.toString('base64'),
    Object.fromEntries(expected.map((byte, i) => [String(i), byte])),
    { type: 'Buffer', data: expected },
    Uint8Array.from(expected),
  ])
    assert.deepEqual([...nativeMediaBytes(value)!], expected);
  // The old conversion took Object.values of Buffer JSON: ['Buffer', [...]] became two zero bytes.
  assert.deepEqual([...Uint8Array.from(Object.values({ type: 'Buffer', data: expected }) as any)], [0, 0]);
  for (const value of [null, '', {}, { a: 1 }, [1, 2]]) assert.equal(nativeMediaBytes(value), null);
});
