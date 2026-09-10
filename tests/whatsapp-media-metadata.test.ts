import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatMediaPreparationErrorLog,
  resolveMediaMessageMetadata,
  sanitizeMediaFileName,
} from '@api/integrations/channel/whatsapp/media-message-metadata';

test('derives signed-media filenames only from the decoded URL pathname', () => {
  const mediaUrl =
    'https://media-user:media-password@cdn.example.test/private/R%C3%A9sum%C3%A9%202026.pdf' +
    '?X-Amz-Credential=TOPSECRET&X-Amz-Signature=QUERYSECRET#fragment=FRAGMENTSECRET';
  const metadata = resolveMediaMessageMetadata({
    mediaType: 'document',
    mediaUrl,
    responseContentType: 'application/pdf',
  });

  assert.deepEqual(metadata, { fileName: 'Résumé 2026.pdf', mimetype: 'application/pdf' });
  assert.doesNotMatch(JSON.stringify(metadata), /media-user|media-password|TOPSECRET|QUERYSECRET|FRAGMENTSECRET/);
});

test('uses a validated response MIME for an extensionless URL path', () => {
  const metadata = resolveMediaMessageMetadata({
    mediaType: 'document',
    mediaUrl: 'https://cdn.example.test/download?signature=TOPSECRET#FRAGMENTSECRET',
    responseContentType: 'application/pdf; charset=binary',
  });

  assert.deepEqual(metadata, { fileName: 'download', mimetype: 'application/pdf' });
});

test('sanitizes malicious URL and local basenames without changing ordinary local filenames', () => {
  assert.equal(
    sanitizeMediaFileName('https://cdn.example.test/%2e%2e%2f..%5c%00%0d%0aX-Evil%3Avalue.pdf?token=TOPSECRET'),
    'X-Evil_value.pdf',
  );
  assert.deepEqual(
    resolveMediaMessageMetadata({
      mediaType: 'document',
      fileName: 'Quarterly%20Report.PDF',
      responseContentType: 'text/plain',
    }),
    { fileName: 'Quarterly%20Report.PDF', mimetype: 'application/pdf' },
  );
  assert.equal(sanitizeMediaFileName('../../unsafe\r\nname?.pdf#ignored'), 'unsafe_name');
});

test('rejects invalid MIME values instead of serializing false or unsafe response metadata', () => {
  assert.deepEqual(
    resolveMediaMessageMetadata({
      mediaType: 'document',
      mediaUrl: 'https://cdn.example.test/download?signature=TOPSECRET',
      responseContentType: 'application/pdf\r\nX-Signature: TOPSECRET',
    }),
    { fileName: 'download', mimetype: undefined },
  );
});

test('media preparation logs retain only a bounded error class', () => {
  const signedUrl = 'https://user:password@cdn.example.test/file.pdf?signature=TOPSECRET#FRAGMENTSECRET';
  const ordinaryError = new Error(`Download failed for ${signedUrl}`);
  const maliciousNameError = Object.assign(new Error('failed'), { name: `AxiosError:${signedUrl}` });

  assert.equal(
    formatMediaPreparationErrorLog('whatsapp_media_prepare_error', ordinaryError),
    '{"event":"whatsapp_media_prepare_error","errorClass":"Error"}',
  );
  const unsafeNameLog = formatMediaPreparationErrorLog('whatsapp_media_prepare_error', maliciousNameError);
  assert.equal(unsafeNameLog, '{"event":"whatsapp_media_prepare_error","errorClass":"Error"}');
  assert.doesNotMatch(unsafeNameLog, /user|password|TOPSECRET|FRAGMENTSECRET/);
});
