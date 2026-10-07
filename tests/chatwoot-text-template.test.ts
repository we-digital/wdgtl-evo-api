import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { prepareCachedRecoveryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import { retainedTemplate } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';

function fixture() {
  return {
    templateMessage: {
      templateId: 'synthetic-template',
      interactiveMessageTemplate: {
        body: { text: 'synthetic body' },
        header: { title: 'synthetic title' },
        footer: { text: 'synthetic footer' },
        nativeFlowMessage: {
          buttons: [
            {
              name: 'cta_url',
              buttonParamsJson: JSON.stringify({ display_text: 'Read', url: 'https://example.test/read' }),
            },
          ],
          messageParamsJson: '{}',
        },
      },
    },
  };
}

test('text-only template preserves title, body, footer and CTA without any media lookup', async () => {
  const body = fixture();
  const before = JSON.stringify(body);
  assert.equal(
    retainedTemplate(body).text,
    'synthetic title\nsynthetic body\nsynthetic footer\nRead: https://example.test/read',
  );
  assert.equal(classifyCachedHistoryRecord({ messageType: 'templateMessage', message: body }, false), 'ordinary');
  const unexpected = async () => {
    throw new Error('unexpected media IO');
  };
  const media = await prepareCachedRecoveryMedia(
    [{ id: 'synthetic', messageType: 'templateMessage', message: body } as any],
    unexpected,
    unexpected,
    unexpected,
  );
  assert.equal(media.size, 0);
  assert.equal(JSON.stringify(body), before);
});

test('explicit false media flag and retained bounded native CTA sidecars stay inert', () => {
  const body: any = fixture();
  const template = body.templateMessage.interactiveMessageTemplate;
  template.header.hasMediaAttachment = false;
  const action = JSON.parse(template.nativeFlowMessage.buttons[0].buttonParamsJson);
  Object.assign(action, {
    consented_users_url: action.url,
    landing_page_url: action.url,
    webview_presentation: null,
    payment_link_preview: false,
    merchant_payment_link_preview: false,
    webview_interaction: true,
  });
  template.nativeFlowMessage.buttons[0].buttonParamsJson = JSON.stringify(action);
  template.nativeFlowMessage.messageParamsJson = JSON.stringify({
    bottom_sheet: { divider_indices: [] },
    tap_target_list: [],
    tap_target_configuration: { title: 'metadata only' },
    text_truncation_length_limit_in_lines: 5,
  });
  const result = retainedTemplate(body);
  assert.equal(result.image, undefined);
  assert.equal(result.video, undefined);
  assert.equal(result.metadata.native_flow, template.nativeFlowMessage);
});

test('text-only template refuses unknown source fields, invalid footer, media flag and unknown actions', () => {
  for (const mutate of [
    (b: any) => {
      b.templateMessage.templateId = '';
    },
    (b: any) => {
      b.templateMessage.interactiveMessageTemplate.header.unknown = true;
    },
    (b: any) => {
      b.templateMessage.interactiveMessageTemplate.unknown = true;
    },
    (b: any) => {
      b.templateMessage.interactiveMessageTemplate.footer.text = 12;
    },
    (b: any) => {
      b.templateMessage.interactiveMessageTemplate.header.hasMediaAttachment = true;
    },
    (b: any) => {
      b.templateMessage.interactiveMessageTemplate.nativeFlowMessage.buttons[0].name = 'payment';
    },
  ]) {
    const body = fixture();
    mutate(body);
    assert.throws(() => retainedTemplate(body));
  }
});

test('text-only CTA refuses unsafe URLs, malformed params and unrecognized action fields', () => {
  for (const patch of [
    { url: 'javascript:alert(1)' },
    { url: 'https://user:password@example.test' },
    { url: 'https://example.test\r\nInjected: true' },
    { unknown_action: true },
    { payment_link_preview: 'true' },
  ]) {
    const body = fixture();
    const flow = body.templateMessage.interactiveMessageTemplate.nativeFlowMessage;
    flow.buttons[0].buttonParamsJson = JSON.stringify({ display_text: 'Read', url: 'https://example.test', ...patch });
    assert.throws(() => retainedTemplate(body));
  }
  for (const params of ['not-json', '[]', '{"unknown":true}', 'null']) {
    const body = fixture();
    body.templateMessage.interactiveMessageTemplate.nativeFlowMessage.messageParamsJson = params;
    assert.throws(() => retainedTemplate(body));
  }
});
