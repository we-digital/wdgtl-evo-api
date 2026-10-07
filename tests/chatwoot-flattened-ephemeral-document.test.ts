import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import {
  retainedHistoryMedia,
  retainedHistoryDisplayBody,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';
import { prepareCachedRecoveryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';

const bytes = Buffer.from('synthetic ordinary PDF bytes');
const source: any = {
  id: 'native-file',
  instanceId: 'owned',
  messageType: 'ephemeralMessage',
  messageTimestamp: 123,
  key: { id: 'document', remoteJid: '123456@g.us', fromMe: false },
  message: {
    documentMessage: {
      mimetype: 'application/pdf',
      fileName: 'retained.pdf',
      fileLength: bytes.length,
      fileSha256: createHash('sha256').update(bytes).digest('base64'),
    },
  },
};

test('native flattened ephemeral document stays ordinary and retains source body while media/display is document', async () => {
  const before = JSON.stringify(source);
  assert.equal(classifyCachedHistoryRecord(source, false), 'ordinary');
  assert.equal(retainedHistoryMedia(source).type, 'documentMessage');
  assert.equal(retainedHistoryDisplayBody(source), source.message);
  let reads = 0;
  const prepared = await prepareCachedRecoveryMedia(
    [source],
    async () => null,
    async () => assert.fail('No owned object exists'),
    async (row) => {
      assert.equal(row, source);
      reads++;
      return bytes;
    },
  );
  assert.equal(reads, 1);
  assert.equal(prepared.get(source.id)?.descriptor.mimetype, 'application/pdf');
  assert.equal(prepared.get(source.id)?.bytes, bytes);
  assert.equal(JSON.stringify(source), before);
});

test('unknown wrapper/outer payload, wrong body and unauthenticated bytes stop ordinary file import', async () => {
  for (const body of [
    null,
    {},
    { ephemeralMessage: { message: source.message } },
    { ...source.message, conversation: 'mixed' },
    { ...source.message, unknown: true },
    { documentMessage: [] },
    { documentMessage: 'not descriptor' },
  ])
    assert.throws(() => classifyCachedHistoryRecord({ ...source, message: body }, false));
  await assert.rejects(
    prepareCachedRecoveryMedia(
      [source],
      async () => null,
      async () => assert.fail('No owned object exists'),
      async () => Buffer.from('different'),
    ),
    /cached_media_bytes_mismatch/,
  );
  await assert.rejects(
    prepareCachedRecoveryMedia(
      [
        {
          ...source,
          message: {
            documentMessage: {
              ...source.message.documentMessage,
              mimetype: 'application/pdf\r\nHeader: injected',
            },
          },
        },
      ],
      async () => null,
      async () => bytes,
      async () => bytes,
    ),
    /cached_media_authority_unavailable/,
  );
});
