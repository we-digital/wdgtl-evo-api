import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatwootOutboundProvenance,
  validateChatwootAutoReplyBinding,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-auto-reply-binding';

const body = {
  id: 314,
  account: { id: 7 },
  inbox: { id: 58 },
  conversation: { id: 42 },
  content_attributes: {
    auto_reply: {
      version: 1,
      delivery_binding: {
        version: 1,
        provider: 'evo_whatsapp',
        inbox_id: 58,
        instance_name: 'p-mila',
      },
    },
  },
};

test('accepts only the exact Chatwoot inbox and EVO instance binding', () => {
  assert.deepEqual(validateChatwootAutoReplyBinding(body, 'p-mila'), { protected: true, valid: true });

  assert.deepEqual(validateChatwootAutoReplyBinding(body, 'd-acc'), {
    protected: true,
    valid: false,
    reason: 'instance_mismatch',
  });
  assert.deepEqual(validateChatwootAutoReplyBinding({ ...body, inbox: { id: 42 } }, 'p-mila'), {
    protected: true,
    valid: false,
    reason: 'inbox_mismatch',
  });
});

test('fails closed for missing, malformed and foreign auto-reply bindings', () => {
  assert.deepEqual(
    validateChatwootAutoReplyBinding(
      { ...body, content_attributes: { auto_reply: { version: 1 } } },
      'p-mila',
    ),
    { protected: true, valid: false, reason: 'missing_binding' },
  );
  assert.deepEqual(
    validateChatwootAutoReplyBinding(
      {
        ...body,
        content_attributes: {
          auto_reply: {
            version: 1,
            delivery_binding: {
              ...body.content_attributes.auto_reply.delivery_binding,
              provider: 'telegram_mtproto',
            },
          },
        },
      },
      'p-mila',
    ),
    { protected: true, valid: false, reason: 'provider_mismatch' },
  );
});

test('leaves ordinary Chatwoot messages unchanged and builds correlated provenance', () => {
  assert.deepEqual(validateChatwootAutoReplyBinding({ content_attributes: {} }, 'd-acc'), {
    protected: false,
    valid: true,
  });
  assert.deepEqual(buildChatwootOutboundProvenance(body), {
    version: 1,
    origin: 'chatwoot',
    requestId: 'chatwoot:7:314',
    chatwootMessageId: 314,
    chatwootInboxId: 58,
    chatwootConversationId: 42,
  });
});
