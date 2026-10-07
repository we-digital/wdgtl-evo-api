import { albumImageCount } from './chatwoot-history-album';
import {
  knownHistoryMetadataControl,
  retainedButtons,
  retainedHistoryMedia,
  retainedTemplate,
} from './chatwoot-retained-history-formats';

const ordinaryTypes = new Set([
  'conversation',
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
]);
const validSenderKeySidecar = (body: any) => {
  const value = body?.senderKeyDistributionMessage;
  return (
    value === undefined ||
    (value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => ['groupId', 'axolotlSenderKeyDistributionMessage'].includes(key)) &&
      typeof value.groupId === 'string' &&
      value.groupId.length > 0 &&
      typeof value.axolotlSenderKeyDistributionMessage === 'string' &&
      value.axolotlSenderKeyDistributionMessage.length > 0)
  );
};

const auxiliaryKeys = new Set(['mediaUrl', 'messageContextInfo', 'senderKeyDistributionMessage']);

export function classifyCachedHistoryRecord(
  record: {
    messageType: string;
    message: unknown;
  },
  edited: boolean,
):
  | 'ordinary'
  | 'reaction_control'
  | 'metadata_control'
  | 'encryption_control'
  | 'unavailable_image_edit'
  | 'unavailable_text_edit'
  | 'unavailable_document_edit'
  | 'unavailable_audio_edit'
  | 'unavailable_other_edit'
  | 'conflicting_text_edit'
  | 'encrypted_edit'
  | 'pin_control'
  | 'poll_control'
  | 'album_container' {
  const payload = record.message;
  // SQL JSON null is an unavailable retained edit, never an instruction to clear its destination.
  if (payload === null && edited && ['contactMessage', 'albumMessage'].includes(record.messageType))
    return 'unavailable_other_edit';
  if (payload === null && edited && record.messageType === 'documentMessage') return 'unavailable_document_edit';
  if (payload === null && edited && record.messageType === 'imageMessage') return 'unavailable_image_edit';
  if (
    (payload === null ||
      (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0)) &&
    edited &&
    ['conversation', 'extendedTextMessage'].includes(record.messageType)
  )
    return 'unavailable_text_edit';
  if (
    edited &&
    record.messageType === 'audioMessage' &&
    (payload === null ||
      (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0))
  )
    return 'unavailable_audio_edit';
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Cached history payload is unclassifiable');
  }
  if (record.messageType === 'albumMessage') {
    albumImageCount(record, 'container_only');
    return 'album_container';
  }
  const keys = Object.keys(payload);
  if (knownHistoryMetadataControl(record)) return 'metadata_control';
  if (
    record.messageType === 'templateMessage' &&
    Object.keys(payload).every((key) => key === 'templateMessage' || auxiliaryKeys.has(key))
  ) {
    retainedTemplate(payload);
    return 'ordinary';
  }
  if (record.messageType === 'buttonsMessage') {
    retainedButtons(payload);
    return 'ordinary';
  }
  if (['associatedChildMessage', 'lottieStickerMessage', 'ephemeralMessage'].includes(record.messageType)) {
    retainedHistoryMedia(record as any);
    return 'ordinary';
  }
  if (
    record.messageType === 'contactMessage' &&
    keys.includes('contactMessage') &&
    keys.every((key) => key === 'contactMessage' || auxiliaryKeys.has(key)) &&
    typeof (payload as any).contactMessage?.vcard === 'string' &&
    /^BEGIN:VCARD\r?\n[\s\S]+\r?\nEND:VCARD\s*$/.test((payload as any).contactMessage.vcard)
  )
    return 'ordinary';
  if (keys.length === 0 && edited && record.messageType === 'imageMessage') return 'unavailable_image_edit';
  if (
    record.messageType === 'reactionMessage' &&
    keys.includes('reactionMessage') &&
    keys.every((key) => key === 'reactionMessage' || auxiliaryKeys.has(key))
  ) {
    const reaction = (payload as Record<string, any>).reactionMessage;
    if (
      reaction &&
      typeof reaction === 'object' &&
      !Array.isArray(reaction) &&
      (reaction.text == null || typeof reaction.text === 'string') &&
      typeof reaction.key?.id === 'string' &&
      reaction.key.id.length > 0 &&
      typeof reaction.key?.remoteJid === 'string'
    )
      return 'reaction_control';
    throw new Error('Cached reaction control is unclassifiable');
  }
  if (
    edited &&
    record.messageType === 'conversation' &&
    keys.includes('extendedTextMessage') &&
    keys.every((key) => key === 'extendedTextMessage' || auxiliaryKeys.has(key)) &&
    typeof (payload as any).extendedTextMessage?.text === 'string'
  )
    return 'conflicting_text_edit';
  const primary = (payload as Record<string, any>)[record.messageType];
  const validTarget = (key: any) =>
    key &&
    typeof key.id === 'string' &&
    key.id.length > 0 &&
    typeof key.remoteJid === 'string' &&
    typeof key.fromMe === 'boolean';
  if (
    record.messageType === 'secretEncryptedMessage' &&
    keys.every(
      (key) => key === record.messageType || key === 'messageContextInfo' || key === 'senderKeyDistributionMessage',
    ) &&
    validSenderKeySidecar(payload) &&
    primary?.secretEncType === 2 &&
    validTarget(primary.targetMessageKey) &&
    primary.encIv != null &&
    primary.encPayload != null
  )
    return 'encrypted_edit';
  if (
    record.messageType === 'pinInChatMessage' &&
    keys.every(
      (key) => key === record.messageType || key === 'messageContextInfo' || key === 'senderKeyDistributionMessage',
    ) &&
    validSenderKeySidecar(payload) &&
    validTarget(primary?.key) &&
    [1, 2].includes(primary.type)
  )
    return 'pin_control';
  if (
    record.messageType === 'pollUpdateMessage' &&
    keys.every((key) => key === record.messageType || auxiliaryKeys.has(key)) &&
    validTarget(primary?.pollCreationMessageKey) &&
    primary.vote?.encIv != null &&
    primary.vote?.encPayload != null
  )
    return 'poll_control';
  if (
    record.messageType === 'unknown' &&
    keys.includes('senderKeyDistributionMessage') &&
    keys.every((key) => key === 'senderKeyDistributionMessage' || key === 'messageContextInfo')
  ) {
    const metadata = (payload as Record<string, any>).senderKeyDistributionMessage;
    if (
      metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata) &&
      typeof metadata.groupId === 'string' &&
      metadata.groupId.length > 0 &&
      metadata.axolotlSenderKeyDistributionMessage != null
    )
      return 'encryption_control';
    throw new Error('Cached encryption control is unclassifiable');
  }
  if (
    ordinaryTypes.has(record.messageType) &&
    keys.includes(record.messageType) &&
    keys.every((key) => key === record.messageType || auxiliaryKeys.has(key))
  ) {
    const primary = (payload as Record<string, unknown>)[record.messageType];
    const valid =
      record.messageType === 'conversation'
        ? typeof primary === 'string'
        : primary !== null && typeof primary === 'object' && !Array.isArray(primary) && Object.keys(primary).length > 0;
    if (
      !valid ||
      (record.messageType === 'extendedTextMessage' && typeof (primary as Record<string, unknown>).text !== 'string')
    ) {
      throw new Error('Cached ordinary payload is unclassifiable');
    }
    return 'ordinary';
  }
  throw new Error('Cached history contains an unknown or contradictory record');
}
