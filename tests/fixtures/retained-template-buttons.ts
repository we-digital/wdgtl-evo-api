import { createHash } from 'node:crypto';

export const retainedTemplateBytes = Buffer.from('synthetic JPEG bytes with full digest');
export const retainedTemplateImage = (bytes = retainedTemplateBytes) => ({
  url: 'https://mmg.whatsapp.net/synthetic.enc',
  directPath: '/synthetic.enc',
  fileLength: bytes.length,
  fileSha256: createHash('sha256').update(bytes).digest('base64'),
  fileEncSha256: Buffer.alloc(32, 2).toString('base64'),
  mediaKey: Buffer.alloc(32, 3).toString('base64'),
  mediaKeyTimestamp: 1700000000,
  mimetype: 'image/jpeg',
  width: 40,
  height: 50,
  caption: 'original image caption',
});
export const retainedTemplateFixtures = (bytes = retainedTemplateBytes) => {
  const quick = (index: number) => ({
    index,
    quickReplyButton: { id: `native-${index}`, displayText: `Reply ${index}` },
  });
  const url = (index: number) => ({
    index,
    urlButton: { displayText: `Link ${index}`, url: `https://example.test/${index}` },
  });
  const cta = (index: number) => ({
    name: 'cta_url',
    buttonParamsJson: JSON.stringify({
      display_text: `CTA ${index}`,
      url: `https://example.test/${index}`,
      consented_users_url: `https://example.test/${index}`,
      webview_presentation: null,
      payment_link_preview: false,
      merchant_payment_link_preview: false,
      landing_page_url: `https://example.test/${index}`,
      webview_interaction: false,
    }),
  });
  const context = { threadId: [], messageSecret: Buffer.alloc(32, 4).toString('base64') };
  const hydrated = (image: boolean) => ({
    templateMessage: {
      templateId: 'native-template',
      hydratedTemplate: {
        templateId: 'native-template',
        hydratedContentText: 'full original body\nsecond line',
        ...(image ? { imageMessage: retainedTemplateImage(bytes) } : { hydratedTitleText: 'Original title' }),
        hydratedFooterText: 'Original footer',
        hydratedButtons: image ? [quick(0), quick(1)] : [url(0), url(1), quick(2)],
      },
    },
    messageContextInfo: context,
  });
  const interactive = (footer: boolean) => ({
    templateMessage: {
      templateId: 'native-template',
      interactiveMessageTemplate: {
        header: { hasMediaAttachment: true, imageMessage: retainedTemplateImage(bytes) },
        body: { text: 'full original CTA body\nsecond line' },
        ...(footer ? { footer: { text: 'Original footer' } } : {}),
        nativeFlowMessage: { buttons: [cta(0), cta(1)], messageParamsJson: '{}' },
      },
    },
    messageContextInfo: context,
  });
  return [hydrated(true), hydrated(false), interactive(false), interactive(true)];
};
