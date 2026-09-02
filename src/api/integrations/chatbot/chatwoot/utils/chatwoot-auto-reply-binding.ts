import { OutboundMessageProvenance } from '@api/types/outbound-provenance';

const CONTRACT_VERSION = 1;

export type AutoReplyBindingValidation =
  | { protected: false; valid: true }
  | { protected: true; valid: true }
  | {
      protected: true;
      valid: false;
      reason: 'missing_binding' | 'invalid_contract' | 'provider_mismatch' | 'instance_mismatch' | 'inbox_mismatch';
    };

export function validateChatwootAutoReplyBinding(body: any, instanceName: string): AutoReplyBindingValidation {
  const autoReply = body?.content_attributes?.auto_reply;
  if (!autoReply) {
    return { protected: false, valid: true };
  }

  const binding = autoReply.delivery_binding;
  if (!binding) {
    return { protected: true, valid: false, reason: 'missing_binding' };
  }
  if (autoReply.version !== CONTRACT_VERSION || binding.version !== CONTRACT_VERSION) {
    return { protected: true, valid: false, reason: 'invalid_contract' };
  }
  if (binding.provider !== 'evo_whatsapp') {
    return { protected: true, valid: false, reason: 'provider_mismatch' };
  }
  if (binding.instance_name !== instanceName) {
    return { protected: true, valid: false, reason: 'instance_mismatch' };
  }
  if (Number(binding.inbox_id) !== Number(body?.inbox?.id)) {
    return { protected: true, valid: false, reason: 'inbox_mismatch' };
  }

  return { protected: true, valid: true };
}

export function buildChatwootOutboundProvenance(body: any): OutboundMessageProvenance {
  const optionalNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  };

  return {
    version: CONTRACT_VERSION,
    origin: 'chatwoot',
    requestId: `chatwoot:${body?.account?.id ?? 'unknown'}:${body?.id ?? 'unknown'}`,
    chatwootMessageId: optionalNumber(body?.id),
    chatwootInboxId: optionalNumber(body?.inbox?.id),
    chatwootConversationId: optionalNumber(body?.conversation?.id),
  };
}
