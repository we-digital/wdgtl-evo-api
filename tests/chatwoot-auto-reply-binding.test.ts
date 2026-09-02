import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatwootOutboundProvenance,
  validateChatwootAutoReplyBinding,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-auto-reply-binding';
import { buildChatwootEvoRouteBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';

const route = buildChatwootEvoRouteBinding({
  inboxId: 58,
  instanceId: 'instance-uuid-p-mila',
  instanceName: 'p-mila',
  receiverNumber: '6281111111111',
  signingKey: 'chatwoot-token',
});

assert.ok(route);

const body = {
  id: 314,
  account: { id: 7 },
  inbox: { id: 58 },
  conversation: { id: 42 },
  content_attributes: {
    auto_reply: {
      version: 2,
      delivery_binding: route,
    },
  },
};

test('accepts only the exact Chatwoot inbox and EVO instance binding', () => {
  assert.deepEqual(validateChatwootAutoReplyBinding(body, route), { protected: true, valid: true });

  assert.deepEqual(validateChatwootAutoReplyBinding(body, { ...route, instance_name: 'd-acc' }), {
    protected: true,
    valid: false,
    reason: 'route_mismatch',
  });
  assert.deepEqual(validateChatwootAutoReplyBinding(body, { ...route, inbox_id: 42 }), {
    protected: true,
    valid: false,
    reason: 'route_mismatch',
  });
});

test('fails closed for missing, malformed and foreign auto-reply bindings', () => {
  assert.deepEqual(
    validateChatwootAutoReplyBinding({ ...body, content_attributes: { auto_reply: { version: 2 } } }, route),
    { protected: true, valid: false, reason: 'missing_binding' },
  );
  assert.deepEqual(
    validateChatwootAutoReplyBinding(
      {
        ...body,
        content_attributes: {
          auto_reply: {
            version: 2,
            delivery_binding: {
              ...body.content_attributes.auto_reply.delivery_binding,
              provider: 'telegram_mtproto',
            },
          },
        },
      },
      route,
    ),
    { protected: true, valid: false, reason: 'provider_mismatch' },
  );
});

test('leaves ordinary Chatwoot messages unchanged and builds correlated provenance', () => {
  assert.deepEqual(validateChatwootAutoReplyBinding({ content_attributes: {} }, null), {
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
