import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { prepareCachedRecoveryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import { retainedTemplate } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';

function fixture(length = 419): any {
  return {
    templateMessage: {
      templateId: 'synthetic-template',
      contextInfo: { mentionedJid: [], groupMentions: [], statusAttributions: [] },
      hydratedTemplate: {
        templateId: 'synthetic-template',
        hydratedTitleText: '',
        hydratedContentText: 'x'.repeat(length),
        hydratedButtons: [
          { index: 1, quickReplyButton: { id: 'answer-yes', displayText: 'Yes' } },
          { index: 2, quickReplyButton: { id: 'answer-no', displayText: 'No' } },
        ],
      },
    },
  };
}

for (const length of [419, 409]) {
  test(`plaintext hydrated quick replies preserve exact ${length}-character body and labels without media IO`, async () => {
    const body = fixture(length);
    const record: any = {
      id: 'synthetic-native',
      instanceId: 'synthetic-owner',
      key: { id: 'synthetic-key', remoteJid: '120363000000001@g.us', fromMe: false },
      messageType: 'templateMessage',
      messageTimestamp: 1780000000,
      message: body,
    };
    const before = JSON.stringify(record);
    const rendered = retainedTemplate(body);
    assert.equal(rendered.text, `${'x'.repeat(length)}\nYes\nNo`);
    assert.equal(rendered.metadata.hydrated_template, body.templateMessage.hydratedTemplate);
    assert.equal(rendered.image, undefined);
    assert.equal(rendered.video, undefined);
    assert.equal(classifyCachedHistoryRecord(record, false), 'ordinary');
    assert.equal(
      chatwootImport.getContentMessage({ getConversationMessage: () => '' } as any, record, true),
      rendered.text,
    );
    const unexpected = async () => {
      throw new Error('unexpected media IO');
    };
    const media = await prepareCachedRecoveryMedia([record], unexpected, unexpected, unexpected);
    assert.equal(media.size, 0);
    assert.equal(JSON.stringify(record), before);
  });
}

test('hydrated title, footer, exact whitespace and native button IDs remain preserved', () => {
  const body = fixture();
  const hydrated = body.templateMessage.hydratedTemplate;
  hydrated.hydratedTitleText = 'Title';
  hydrated.hydratedContentText = '  exact\nbody  ';
  hydrated.hydratedFooterText = 'Footer';
  hydrated.hydratedButtons[0].quickReplyButton.displayText = '  Yes  ';
  const before = JSON.stringify(body);
  assert.equal(retainedTemplate(body).text, 'Title\n  exact\nbody  \nFooter\n  Yes  \nNo');
  assert.deepEqual(retainedTemplate(body).metadata.hydrated_template, hydrated);
  assert.equal(JSON.stringify(body), before);
});

const mutations: [string, (body: any) => void][] = [
  ['media image', (b) => (b.templateMessage.hydratedTemplate.imageMessage = {})],
  ['media video', (b) => (b.templateMessage.hydratedTemplate.videoMessage = {})],
  ['media document', (b) => (b.templateMessage.hydratedTemplate.documentMessage = {})],
  ['header', (b) => (b.templateMessage.hydratedTemplate.header = { title: 'unknown' })],
  [
    'unknown nested button',
    (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[0].quickReplyButton.unknown = true),
  ],
  ['unknown template field', (b) => (b.templateMessage.hydratedTemplate.unknown = true)],
  ['nonstring body', (b) => (b.templateMessage.hydratedTemplate.hydratedContentText = 42)],
  ['empty body', (b) => (b.templateMessage.hydratedTemplate.hydratedContentText = '')],
  ['nonstring footer', (b) => (b.templateMessage.hydratedTemplate.hydratedFooterText = {})],
  ['empty label', (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[0].quickReplyButton.displayText = '')],
  ['nonstring label', (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[0].quickReplyButton.displayText = 12)],
  ['missing button ID', (b) => delete b.templateMessage.hydratedTemplate.hydratedButtons[0].quickReplyButton.id],
  ['empty button ID', (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[0].quickReplyButton.id = '')],
  ['invalid index', (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[0].index = -1)],
  ['duplicate index', (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[1].index = 1)],
  ['conflicting template IDs', (b) => (b.templateMessage.hydratedTemplate.templateId = 'other')],
  ['conflicting template variants', (b) => (b.templateMessage.interactiveMessageTemplate = {})],
  [
    'mixed button variants',
    (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[1] = { index: 2, urlButton: {} }),
  ],
];

for (const [name, mutate] of mutations) {
  test(`hydrated quick replies refuse ${name} without dropping unknown content`, () => {
    const body = fixture();
    mutate(body);
    const before = JSON.stringify(body);
    assert.throws(() => retainedTemplate(body));
    assert.throws(() => classifyCachedHistoryRecord({ messageType: 'templateMessage', message: body }, false));
    assert.equal(JSON.stringify(body), before);
  });
}

test('interactive image-header template with footer and native flow remains held', () => {
  const body = {
    templateMessage: {
      templateId: 'synthetic-template',
      interactiveMessageTemplate: {
        body: { text: 'native body' },
        footer: { text: 'native footer' },
        header: { imageMessage: { mimetype: 'image/jpeg' }, hasMediaAttachment: true },
        nativeFlowMessage: {
          buttons: [{ name: 'cta_url', buttonParamsJson: '{}' }],
          messageParamsJson: '{}',
        },
      },
    },
  };
  const before = JSON.stringify(body);
  assert.throws(() => retainedTemplate(body));
  assert.throws(() => classifyCachedHistoryRecord({ messageType: 'templateMessage', message: body }, false));
  assert.equal(JSON.stringify(body), before);
});
