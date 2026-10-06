import { Message } from '@prisma/client';

const object = (value: any): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, any>, fields: string[]) => Object.keys(value).every((key) => fields.includes(key));
const long = (value: any) =>
  (Number.isSafeInteger(value) && value >= 0) ||
  (object(value) &&
    only(value, ['low', 'high', 'unsigned']) &&
    Number.isInteger(value.low) &&
    Number.isInteger(value.high) &&
    value.high >= 0 &&
    value.high <= 2097151 &&
    typeof value.unsigned === 'boolean');
const bytes32 = (value: any) =>
  typeof value === 'string' &&
  Buffer.from(value, 'base64').length === 32 &&
  Buffer.from(value, 'base64').toString('base64') === value;

const placeholderContext = (context: any) => {
  if (context === undefined) return true;
  if (
    !object(context) ||
    !only(context, ['threadId', 'deviceListMetadata', 'deviceListMetadataVersion']) ||
    !Array.isArray(context.threadId) ||
    context.threadId.length
  )
    return false;
  const device = context.deviceListMetadata;
  const hash10 = (v: any) =>
    typeof v === 'string' &&
    Buffer.from(v, 'base64').length === 10 &&
    Buffer.from(v, 'base64').toString('base64') === v;
  return (
    context.deviceListMetadataVersion === 2 &&
    object(device) &&
    only(device, [
      'senderKeyHash',
      'senderTimestamp',
      'recipientKeyHash',
      'recipientTimestamp',
      'senderKeyIndexes',
      'recipientKeyIndexes',
    ]) &&
    hash10(device.recipientKeyHash) &&
    long(device.recipientTimestamp) &&
    ((device.senderKeyHash === undefined && device.senderTimestamp === undefined) ||
      (hash10(device.senderKeyHash) && long(device.senderTimestamp))) &&
    Array.isArray(device.senderKeyIndexes) &&
    !device.senderKeyIndexes.length &&
    Array.isArray(device.recipientKeyIndexes) &&
    !device.recipientKeyIndexes.length
  );
};

export function knownHistoryMetadataControl(record: { messageType: string; message: unknown }): boolean {
  const body = record.message as any;
  if (!object(body)) return false;
  if (body.senderKeyDistributionMessage !== undefined) {
    const sender = body.senderKeyDistributionMessage;
    if (
      !object(sender) ||
      !only(sender, ['groupId', 'axolotlSenderKeyDistributionMessage']) ||
      typeof sender.groupId !== 'string' ||
      !sender.groupId ||
      typeof sender.axolotlSenderKeyDistributionMessage !== 'string' ||
      !sender.axolotlSenderKeyDistributionMessage
    )
      return false;
  }
  if (record.messageType === 'placeholderMessage') {
    return (
      placeholderContext(body.messageContextInfo) &&
      only(body, ['placeholderMessage', 'messageContextInfo']) &&
      object(body.placeholderMessage) &&
      only(body.placeholderMessage, ['type']) &&
      body.placeholderMessage.type === 0
    );
  }
  if (record.messageType !== 'unknown') return false;
  const context = body.messageContextInfo;
  if (
    !object(context) ||
    !Array.isArray(context.threadId) ||
    context.threadId.length ||
    !bytes32(context.messageSecret)
  )
    return false;
  if (body.messageHistoryNotice !== undefined) {
    const notice = body.messageHistoryNotice;
    const metadata = notice?.messageHistoryMetadata;
    return (
      only(body, ['messageHistoryNotice', 'messageContextInfo', 'senderKeyDistributionMessage']) &&
      only(context, ['threadId', 'messageSecret']) &&
      object(notice) &&
      only(notice, ['messageHistoryMetadata']) &&
      object(metadata) &&
      only(metadata, ['messageCount', 'historyReceivers', 'oldestMessageTimestamp']) &&
      long(metadata.messageCount) &&
      long(metadata.oldestMessageTimestamp) &&
      Array.isArray(metadata.historyReceivers) &&
      metadata.historyReceivers.length > 0 &&
      metadata.historyReceivers.every((jid: any) => typeof jid === 'string' && jid.length > 0)
    );
  }
  const limit = context.limitSharingV2;
  return (
    only(body, ['messageContextInfo']) &&
    only(context, ['threadId', 'messageSecret', 'limitSharingV2']) &&
    object(limit) &&
    only(limit, ['trigger', 'initiatedByMe', 'sharingLimited', 'limitSharingSettingTimestamp']) &&
    limit.trigger === 1 &&
    typeof limit.initiatedByMe === 'boolean' &&
    typeof limit.sharingLimited === 'boolean' &&
    long(limit.limitSharingSettingTimestamp)
  );
}

export function retainedTemplate(body: any): { text: string; metadata: Record<string, any>; video?: any } {
  const template = body?.templateMessage;
  if (
    !object(template) ||
    !only(template, ['templateId', 'hydratedTemplate', 'interactiveMessageTemplate']) ||
    typeof template.templateId !== 'string' ||
    !template.templateId
  )
    throw new Error('Retained template content is unsupported');
  const hydrated = template.hydratedTemplate;
  const interactive = template.interactiveMessageTemplate;
  if (
    object(hydrated) &&
    interactive === undefined &&
    only(hydrated, [
      'templateId',
      'hydratedButtons',
      'hydratedTitleText',
      'hydratedContentText',
      'hydratedFooterText',
    ]) &&
    hydrated.templateId === template.templateId &&
    Array.isArray(hydrated.hydratedButtons) &&
    !hydrated.hydratedButtons.length &&
    typeof hydrated.hydratedContentText === 'string' &&
    hydrated.hydratedContentText.length > 0 &&
    (hydrated.hydratedTitleText === undefined || typeof hydrated.hydratedTitleText === 'string') &&
    (hydrated.hydratedFooterText === undefined || typeof hydrated.hydratedFooterText === 'string')
  ) {
    return {
      text: [hydrated.hydratedTitleText, hydrated.hydratedContentText, hydrated.hydratedFooterText]
        .filter(Boolean)
        .join('\n'),
      metadata: { template_id: template.templateId, hydrated_template: hydrated },
    };
  }
  if (
    hydrated !== undefined ||
    !object(interactive) ||
    !only(interactive, ['body', 'header', 'nativeFlowMessage']) ||
    !object(interactive.body) ||
    !only(interactive.body, ['text']) ||
    typeof interactive.body.text !== 'string' ||
    !interactive.body.text ||
    !object(interactive.header) ||
    !only(interactive.header, ['videoMessage', 'hasMediaAttachment']) ||
    interactive.header.hasMediaAttachment !== true ||
    !object(interactive.header.videoMessage) ||
    !object(interactive.nativeFlowMessage) ||
    !only(interactive.nativeFlowMessage, ['buttons', 'messageParamsJson'])
  )
    throw new Error('Retained template content is unsupported');
  const flow = interactive.nativeFlowMessage;
  if (
    !Array.isArray(flow.buttons) ||
    flow.buttons.length !== 1 ||
    !object(flow.buttons[0]) ||
    !only(flow.buttons[0], ['name', 'buttonParamsJson']) ||
    flow.buttons[0].name !== 'cta_url' ||
    typeof flow.buttons[0].buttonParamsJson !== 'string' ||
    typeof flow.messageParamsJson !== 'string'
  )
    throw new Error('Retained template actions are unsupported');
  const button = JSON.parse(flow.buttons[0].buttonParamsJson);
  const params = JSON.parse(flow.messageParamsJson);
  if (
    !object(button) ||
    typeof button.display_text !== 'string' ||
    !button.display_text ||
    typeof button.url !== 'string' ||
    !/^https?:\/\//.test(button.url) ||
    !object(params)
  )
    throw new Error('Retained template actions are unsupported');
  return {
    text: `${interactive.body.text}\n${button.display_text}: ${button.url}`,
    metadata: { template_id: template.templateId, body: interactive.body, native_flow: flow },
    video: interactive.header.videoMessage,
  };
}

// Only a validated import copy is unwrapped. The persisted native row remains the authority and is never rewritten.
export function retainedHistoryMedia(message: Message): { type: string; descriptor: any } {
  const body = message.message as any;
  if (message.messageType === 'associatedChildMessage') {
    const child = body?.associatedChildMessage;
    if (
      !object(body) ||
      !only(body, ['associatedChildMessage', 'messageContextInfo']) ||
      !object(child) ||
      !only(child, ['message']) ||
      !object(child.message) ||
      !only(child.message, ['videoMessage']) ||
      !object(child.message.videoMessage)
    )
      throw new Error('Retained associated media wrapper is unsupported');
    return { type: 'videoMessage', descriptor: child.message.videoMessage };
  }
  if (message.messageType === 'templateMessage') {
    const template = retainedTemplate(body);
    if (!template.video) throw new Error('cached_media_native_digest_unavailable');
    return { type: 'videoMessage', descriptor: template.video };
  }
  return { type: message.messageType, descriptor: body?.[message.messageType] };
}

export function retainedHistoryDisplayBody(message: Message): any {
  if (message.messageType === 'associatedChildMessage')
    return {
      videoMessage: retainedHistoryMedia(message).descriptor,
      ...((message.message as any)?.messageContextInfo
        ? { messageContextInfo: (message.message as any).messageContextInfo }
        : {}),
    };
  return message.message;
}
