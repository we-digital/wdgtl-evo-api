import { Message } from '@prisma/client';

// Retained protobuf sidecars are preserved, never executed or rendered.
export const boundedRetainedMetadata = (value: any): boolean => {
  let nodes = 0;
  const valid = (v: any, depth: number): boolean => {
    if (++nodes > 4096 || depth > 12) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return Buffer.byteLength(v) <= 65536;
    if (Array.isArray(v)) return v.length <= 512 && v.every((x) => valid(x, depth + 1));
    return (
      v &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Object.keys(v).length <= 128 &&
      Object.entries(v).every(
        ([k, x]) => k.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(k) && valid(x, depth + 1),
      )
    );
  };
  return object(value) && valid(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= 65536;
};

const object = (value: any): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, any>, fields: string[]) => Object.keys(value).every((key) => fields.includes(key));
const long = (value: any) =>
  (Number.isSafeInteger(value) && value >= 0) ||
  (object(value) &&
    only(value, ['low', 'high', 'unsigned']) &&
    Number.isInteger(value.low) &&
    value.low >= -2147483648 &&
    value.low <= 2147483647 &&
    Number.isInteger(value.high) &&
    value.high >= 0 &&
    value.high <= 2097151 &&
    typeof value.unsigned === 'boolean');
const bytes32 = (value: any) =>
  typeof value === 'string' &&
  Buffer.from(value, 'base64').length === 32 &&
  Buffer.from(value, 'base64').toString('base64') === value;

// Closed JPEG metadata shape observed in associated image children and image edit deltas.
// These native fields authorize only verified bytes; sidecars are never executed.
export function retainedNativeJPEGDescriptor(value: any): boolean {
  if (!object(value) || !boundedRetainedMetadata(value)) return false;
  const size =
    typeof value.fileLength === 'number'
      ? value.fileLength
      : object(value.fileLength) &&
          only(value.fileLength, ['low', 'high', 'unsigned']) &&
          value.fileLength.high === 0 &&
          typeof value.fileLength.unsigned === 'boolean'
        ? value.fileLength.low
        : NaN;
  return (
    only(value, [
      'url',
      'width',
      'height',
      'caption',
      'mediaKey',
      'mimetype',
      'directPath',
      'fileLength',
      'fileSha256',
      'annotations',
      'contextInfo',
      'scanLengths',
      'scansSidecar',
      'fileEncSha256',
      'mediaKeyTimestamp',
      'midQualityFileSha256',
      'interactiveAnnotations',
    ]) &&
    value.mimetype === 'image/jpeg' &&
    bytes32(value.fileSha256) &&
    bytes32(value.mediaKey) &&
    bytes32(value.fileEncSha256) &&
    Number.isSafeInteger(size) &&
    size > 0 &&
    size <= 64 * 1024 * 1024 &&
    [value.width, value.height].every(
      (dimension) => Number.isInteger(dimension) && dimension > 0 && dimension <= 65535,
    ) &&
    typeof value.url === 'string' &&
    /^https:\/\//.test(value.url) &&
    typeof value.directPath === 'string' &&
    value.directPath.startsWith('/') &&
    !value.directPath.startsWith('//') &&
    !/[\\\s]/.test(value.directPath) &&
    long(value.mediaKeyTimestamp) &&
    (value.caption === undefined || typeof value.caption === 'string') &&
    (value.contextInfo === undefined || object(value.contextInfo)) &&
    ['annotations', 'scanLengths', 'interactiveAnnotations'].every(
      (name) => value[name] === undefined || Array.isArray(value[name]),
    ) &&
    (value.scansSidecar === undefined || typeof value.scansSidecar === 'string') &&
    (value.midQualityFileSha256 === undefined || bytes32(value.midQualityFileSha256))
  );
}

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
  if (record.messageType === 'keepInChatMessage') {
    const keep = body.keepInChatMessage;
    const key = keep?.key;
    return (
      only(body, ['keepInChatMessage', 'messageContextInfo']) &&
      placeholderContext(body.messageContextInfo) &&
      object(keep) &&
      only(keep, ['key', 'keepType', 'timestampMs']) &&
      object(key) &&
      only(key, ['id', 'remoteJid', 'fromMe']) &&
      typeof key.id === 'string' &&
      key.id.length > 0 &&
      key.id.length <= 256 &&
      typeof key.remoteJid === 'string' &&
      /^(?:[1-9]\d{4,19}@(s\.whatsapp\.net|lid)|[1-9]\d{4,19}(?:-\d{1,20})?@g\.us)$/.test(key.remoteJid) &&
      typeof key.fromMe === 'boolean' &&
      [1, 2].includes(keep.keepType) &&
      long(keep.timestampMs)
    );
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
  if (body.messageHistoryNotice !== undefined || body.messageHistoryBundle !== undefined) {
    const bundle = body.messageHistoryBundle !== undefined;
    const name = bundle ? 'messageHistoryBundle' : 'messageHistoryNotice';
    const value = body[name];
    const metadata = value?.messageHistoryMetadata;
    return (
      only(body, [name, 'messageContextInfo', 'senderKeyDistributionMessage']) &&
      (context === undefined ||
        (boundedRetainedMetadata(context) &&
          Array.isArray(context.threadId) &&
          !context.threadId.length &&
          (context.messageSecret === undefined || bytes32(context.messageSecret)))) &&
      object(value) &&
      only(
        value,
        bundle
          ? [
              'mimetype',
              'fileSha256',
              'mediaKey',
              'fileEncSha256',
              'directPath',
              'mediaKeyTimestamp',
              'contextInfo',
              'messageHistoryMetadata',
            ]
          : ['contextInfo', 'messageHistoryMetadata'],
      ) &&
      (value.contextInfo === undefined || boundedRetainedMetadata(value.contextInfo)) &&
      (!bundle ||
        (typeof value.mimetype === 'string' &&
          value.mimetype === 'application/protobuf' &&
          bytes32(value.fileSha256) &&
          bytes32(value.fileEncSha256) &&
          bytes32(value.mediaKey) &&
          long(value.mediaKeyTimestamp) &&
          typeof value.directPath === 'string' &&
          value.directPath.startsWith('/') &&
          !value.directPath.startsWith('//') &&
          !/[\\\s]/.test(value.directPath))) &&
      object(metadata) &&
      only(metadata, ['messageCount', 'historyReceivers', 'oldestMessageTimestamp']) &&
      long(metadata.messageCount) &&
      long(metadata.oldestMessageTimestamp) &&
      Array.isArray(metadata.historyReceivers) &&
      metadata.historyReceivers.length > 0 &&
      metadata.historyReceivers.length <= 512 &&
      metadata.historyReceivers.every((jid: any) => typeof jid === 'string' && jid.length > 0 && jid.length <= 256)
    );
  }
  if (
    !object(context) ||
    !Array.isArray(context.threadId) ||
    context.threadId.length ||
    !bytes32(context.messageSecret)
  )
    return false;
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

export function retainedTemplate(body: any): { text: string; metadata: Record<string, any>; video?: any; image?: any } {
  const template = body?.templateMessage;
  if (
    !object(body) ||
    !only(body, ['templateMessage', 'messageContextInfo', 'senderKeyDistributionMessage']) ||
    !object(template) ||
    !only(template, ['templateId', 'hydratedTemplate', 'interactiveMessageTemplate', 'contextInfo']) ||
    typeof template.templateId !== 'string' ||
    !template.templateId ||
    (template.contextInfo !== undefined && !boundedRetainedMetadata(template.contextInfo))
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
      'imageMessage',
    ]) &&
    hydrated.templateId === template.templateId &&
    Array.isArray(hydrated.hydratedButtons) &&
    hydrated.hydratedButtons.length <= 10 &&
    hydrated.hydratedButtons.every(
      (button: any) =>
        object(button) &&
        only(button, ['index', 'urlButton']) &&
        Number.isInteger(button.index) &&
        button.index >= 0 &&
        button.index <= 10 &&
        object(button.urlButton) &&
        only(button.urlButton, ['url', 'displayText']) &&
        typeof button.urlButton.displayText === 'string' &&
        button.urlButton.displayText.length > 0 &&
        typeof button.urlButton.url === 'string' &&
        /^https?:\/\//.test(button.urlButton.url),
    ) &&
    (hydrated.imageMessage === undefined || object(hydrated.imageMessage)) &&
    typeof hydrated.hydratedContentText === 'string' &&
    hydrated.hydratedContentText.length > 0 &&
    (hydrated.hydratedTitleText === undefined || typeof hydrated.hydratedTitleText === 'string') &&
    (hydrated.hydratedFooterText === undefined || typeof hydrated.hydratedFooterText === 'string')
  ) {
    return {
      text: [
        hydrated.hydratedTitleText,
        hydrated.hydratedContentText,
        hydrated.hydratedFooterText,
        ...hydrated.hydratedButtons.map((button: any) => `${button.urlButton.displayText}: ${button.urlButton.url}`),
      ]
        .filter(Boolean)
        .join('\n'),
      metadata: { template_id: template.templateId, hydrated_template: hydrated },
      image: hydrated.imageMessage,
    };
  }
  // Text-only CTA templates retain their source metadata; no media or actions are executed.
  if (
    hydrated === undefined &&
    object(interactive) &&
    object(interactive.header) &&
    interactive.header.hasMediaAttachment !== true &&
    interactive.header.imageMessage === undefined &&
    interactive.header.videoMessage === undefined
  ) {
    const header = interactive.header;
    const footer = interactive.footer;
    const flow = interactive.nativeFlowMessage;
    if (
      !only(interactive, ['body', 'header', 'footer', 'nativeFlowMessage']) ||
      !boundedRetainedMetadata(interactive) ||
      !object(interactive.body) ||
      !only(interactive.body, ['text']) ||
      typeof interactive.body.text !== 'string' ||
      !interactive.body.text ||
      !only(header, ['title', 'hasMediaAttachment']) ||
      (header.title !== undefined && typeof header.title !== 'string') ||
      (header.hasMediaAttachment !== undefined && header.hasMediaAttachment !== false) ||
      (footer !== undefined && (!object(footer) || !only(footer, ['text']) || typeof footer.text !== 'string')) ||
      !object(flow) ||
      !only(flow, ['buttons', 'messageParamsJson']) ||
      !Array.isArray(flow.buttons) ||
      flow.buttons.length !== 1 ||
      !object(flow.buttons[0]) ||
      !only(flow.buttons[0], ['name', 'buttonParamsJson']) ||
      flow.buttons[0].name !== 'cta_url' ||
      typeof flow.buttons[0].buttonParamsJson !== 'string' ||
      typeof flow.messageParamsJson !== 'string'
    )
      throw new Error('Retained text template content is unsupported');
    const button = JSON.parse(flow.buttons[0].buttonParamsJson);
    const params = JSON.parse(flow.messageParamsJson);
    const safeURL = (value: any): boolean => {
      if (
        typeof value !== 'string' ||
        !value ||
        /\s/.test(value) ||
        [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        return false;
      try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
      } catch {
        return false;
      }
    };
    if (
      !boundedRetainedMetadata(button) ||
      !only(button, [
        'display_text',
        'url',
        'consented_users_url',
        'webview_presentation',
        'payment_link_preview',
        'merchant_payment_link_preview',
        'landing_page_url',
        'webview_interaction',
      ]) ||
      typeof button.display_text !== 'string' ||
      !button.display_text ||
      !safeURL(button.url) ||
      ['consented_users_url', 'landing_page_url'].some((key) => button[key] !== undefined && !safeURL(button[key])) ||
      (button.webview_presentation !== undefined && button.webview_presentation !== null) ||
      ['payment_link_preview', 'merchant_payment_link_preview', 'webview_interaction'].some(
        (key) => button[key] !== undefined && typeof button[key] !== 'boolean',
      ) ||
      !boundedRetainedMetadata(params) ||
      !only(params, [
        'bottom_sheet',
        'tap_target_configuration',
        'tap_target_list',
        'text_truncation_length_limit_in_lines',
      ])
    )
      throw new Error('Retained text template actions are unsupported');
    return {
      text: [header.title, interactive.body.text, footer?.text, `${button.display_text}: ${button.url}`]
        .filter(Boolean)
        .join('\n'),
      metadata: { template_id: template.templateId, header, body: interactive.body, footer, native_flow: flow },
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
    !only(interactive.header, ['videoMessage', 'imageMessage', 'hasMediaAttachment']) ||
    interactive.header.hasMediaAttachment !== true ||
    Number(object(interactive.header.videoMessage)) + Number(object(interactive.header.imageMessage)) !== 1 ||
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
    image: interactive.header.imageMessage,
  };
}

// Only a validated import copy is unwrapped. The persisted native row remains the authority and is never rewritten.
export function retainedButtons(body: any): { text: string; metadata: Record<string, any> } {
  const value = body?.buttonsMessage;
  if (
    !object(body) ||
    !only(body, ['buttonsMessage', 'messageContextInfo', 'senderKeyDistributionMessage']) ||
    !object(value) ||
    !only(value, ['buttons', 'headerType', 'contentText', 'footerText']) ||
    value.headerType !== 1 ||
    typeof value.contentText !== 'string' ||
    !value.contentText ||
    (value.footerText !== undefined && typeof value.footerText !== 'string') ||
    !Array.isArray(value.buttons) ||
    !value.buttons.length ||
    value.buttons.length > 10 ||
    !value.buttons.every(
      (b: any) =>
        object(b) &&
        only(b, ['type', 'buttonId', 'buttonText']) &&
        b.type === 1 &&
        typeof b.buttonId === 'string' &&
        b.buttonId.length > 0 &&
        object(b.buttonText) &&
        only(b.buttonText, ['displayText']) &&
        typeof b.buttonText.displayText === 'string' &&
        b.buttonText.displayText.length > 0,
    )
  )
    throw new Error('Retained buttons content is unsupported');
  return {
    text: [value.contentText, value.footerText, ...value.buttons.map((b: any) => b.buttonText.displayText)]
      .filter(Boolean)
      .join('\n'),
    metadata: value,
  };
}

export function retainedHistoryMedia(message: Message): { type: string; descriptor: any } {
  const body = message.message as any;
  if (message.messageType === 'ephemeralMessage') {
    if (
      !object(body) ||
      !only(body, ['documentMessage', 'messageContextInfo', 'mediaUrl', 'senderKeyDistributionMessage']) ||
      !object(body.documentMessage)
    )
      throw new Error('Retained flattened ephemeral document is unsupported');
    // The native wrapper type remains in the full source fingerprint; only display/media type is normalized.
    return { type: 'documentMessage', descriptor: body.documentMessage };
  }
  if (message.messageType === 'lottieStickerMessage') {
    const wrapper = body?.lottieStickerMessage;
    const sticker = wrapper?.message?.stickerMessage;
    if (
      !object(body) ||
      !only(body, ['lottieStickerMessage', 'messageContextInfo']) ||
      !object(wrapper) ||
      !only(wrapper, ['message']) ||
      !object(wrapper.message) ||
      !only(wrapper.message, ['stickerMessage']) ||
      !object(sticker) ||
      sticker.isLottie !== true ||
      sticker.mimetype !== 'application/was'
    )
      throw new Error('Retained lottie sticker wrapper is unsupported');
    // WAS animation bytes are retained as a file; no raster conversion or animation execution.
    return { type: 'documentMessage', descriptor: sticker };
  }
  if (message.messageType === 'associatedChildMessage') {
    const child = body?.associatedChildMessage;
    if (
      !object(body) ||
      !only(body, ['associatedChildMessage', 'messageContextInfo']) ||
      !object(child) ||
      !only(child, ['message']) ||
      !object(child.message) ||
      Object.keys(child.message).length !== 1 ||
      !(
        (object(child.message.videoMessage) && only(child.message, ['videoMessage'])) ||
        (only(child.message, ['imageMessage']) && retainedNativeJPEGDescriptor(child.message.imageMessage))
      )
    )
      throw new Error('Retained associated media wrapper is unsupported');
    return child.message.imageMessage
      ? { type: 'imageMessage', descriptor: child.message.imageMessage }
      : { type: 'videoMessage', descriptor: child.message.videoMessage };
  }
  if (message.messageType === 'templateMessage') {
    const template = retainedTemplate(body);
    if (template.image) return { type: 'imageMessage', descriptor: template.image };
    if (!template.video) throw new Error('cached_media_native_digest_unavailable');
    return { type: 'videoMessage', descriptor: template.video };
  }
  return { type: message.messageType, descriptor: body?.[message.messageType] };
}

export function retainedHistoryDisplayBody(message: Message): any {
  if (message.messageType === 'associatedChildMessage')
    return {
      [retainedHistoryMedia(message).type]: retainedHistoryMedia(message).descriptor,
      ...((message.message as any)?.messageContextInfo
        ? { messageContextInfo: (message.message as any).messageContextInfo }
        : {}),
    };
  return message.message;
}
