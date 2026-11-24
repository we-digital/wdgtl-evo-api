import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatMediaPreparationErrorLog,
  mediaContentType,
  resolveChatwootAttachmentMetadata,
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

test('the Chatwoot attachment metadata chain excludes signed URL metadata and retains response MIME', async () => {
  const downloadContentType = async () => 'application/pdf; charset=binary';
  const metadata = await Promise.all(
    [
      'https://cdn.example.test/download?signature=QUERYSECRET',
      'https://cdn.example.test/download#fragment/PATHFRAGMENTSECRET',
      'https://cdn.example.test/archive.unknown?signature=QUERYSECRET#FRAGMENTSECRET',
    ].map((mediaUrl) => resolveChatwootAttachmentMetadata(mediaUrl, downloadContentType)),
  );

  assert.deepEqual(metadata, [
    { fileName: 'download', mimetype: 'application/pdf' },
    { fileName: 'download', mimetype: 'application/pdf' },
    { fileName: 'archive.unknown', mimetype: 'application/pdf' },
  ]);
  assert.doesNotMatch(JSON.stringify(metadata), /QUERYSECRET|PATHFRAGMENTSECRET|FRAGMENTSECRET/);
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

// C289: a 182-character PDF name was cut to "….p" and sent as text/x-pascal.
test('long file names keep their extension and their type', async () => {
  const stem =
    '24 NOVEMBER 2026 BBC - bayar 2 nomor warmeking UNTUK IDENFINITE-TERM EMPLOYMENT AGREEMENT (PKWTT) PT Thirteen DAN ' +
    'Surat Pernyataan Penutupan Perusahaan PT CONCIERGE VISA SERVICES';
  const longName = `${stem}.pdf`;
  assert.equal(longName.length, 182);

  const sanitized = sanitizeMediaFileName(longName);
  assert.equal(sanitized.length, 180);
  assert.match(sanitized, /\.pdf$/);
  assert.equal(sanitized, `${stem.slice(0, 176)}.pdf`);

  assert.deepEqual(resolveMediaMessageMetadata({ mediaType: 'document', fileName: longName }), {
    fileName: sanitized,
    mimetype: 'application/pdf',
  });

  const chatwootUrl = `https://chatwoot.example.test/rails/active_storage/blobs/redirect/abc/${encodeURIComponent(longName)}`;
  const fromChatwoot = await resolveChatwootAttachmentMetadata(chatwootUrl, async () => 'text/plain');
  assert.deepEqual(fromChatwoot, { fileName: sanitized, mimetype: 'application/pdf' });

  const xlsx = sanitizeMediaFileName(`${'a'.repeat(300)}.xlsx`);
  assert.equal(xlsx, `${'a'.repeat(175)}.xlsx`);
});

test('long names without a real extension are cut plainly and never split a surrogate pair', () => {
  const validity = `eVisa_${'N'.repeat(200)}_09.10.2026-09.10.2027`;
  const cut = sanitizeMediaFileName(validity);
  assert.equal(cut, validity.slice(0, 180));

  const emoji = sanitizeMediaFileName(`${'😀'.repeat(200)}.pdf`);
  assert.equal(Array.from(emoji).length, 180);
  assert.match(emoji, /^(😀)+\.pdf$/);

  assert.equal(sanitizeMediaFileName('short name.pdf'), 'short name.pdf');
});

test('the inbound bus type comes from WhatsApp, not from the name', () => {
  assert.equal(mediaContentType('application/pdf'), 'application/pdf');
  assert.equal(mediaContentType('Application/PDF; charset=binary'), 'application/pdf');
  assert.equal(mediaContentType('application/octet-stream'), undefined);
  assert.equal(mediaContentType(null), undefined);
  assert.equal(mediaContentType('pdf'), undefined);
});
