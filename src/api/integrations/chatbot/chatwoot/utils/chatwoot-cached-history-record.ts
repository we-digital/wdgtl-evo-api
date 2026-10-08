import { albumImageCount } from './chatwoot-history-album';
import {
  boundedRetainedMetadata,
  knownHistoryMetadataControl,
  retainedButtons,
  retainedHistoryMedia,
  retainedNativeJPEGDescriptor,
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

/** A retained plaintext edit is a delta for its explicit target, never a new message. */
export function isKnownPlaintextHistoryEdit(record: { messageType: string; message: unknown; key?: unknown }): boolean {
  const body = record.message as any;
  const source = record.key as any;
  const protocol = body?.protocolMessage;
  const target = protocol?.key;
  const edit = protocol?.editedMessage;
  const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
  const timestamp = protocol?.timestampMs;
  const validTimestamp =
    (Number.isSafeInteger(timestamp) && timestamp > 0) ||
    (object(timestamp) &&
      Object.keys(timestamp).every((name) => ['low', 'high', 'unsigned'].includes(name)) &&
      Number.isInteger(timestamp.low) &&
      timestamp.low >= -2147483648 &&
      timestamp.low <= 2147483647 &&
      Number.isInteger(timestamp.high) &&
      timestamp.high >= 0 &&
      timestamp.high <= 2097151 &&
      typeof timestamp.unsigned === 'boolean' &&
      timestamp.high * 4294967296 + (timestamp.low >>> 0) > 0);
  return Boolean(
    record.messageType === 'protocolMessage' &&
      object(body) &&
      boundedRetainedMetadata(body) &&
      Object.keys(body).every((name) => ['protocolMessage', 'messageContextInfo'].includes(name)) &&
      object(protocol) &&
      Object.keys(protocol).every((name) => ['type', 'key', 'timestampMs', 'editedMessage'].includes(name)) &&
      protocol.type === 14 &&
      validTimestamp &&
      object(source) &&
      typeof source.id === 'string' &&
      source.id.length > 0 &&
      typeof source.remoteJid === 'string' &&
      source.remoteJid.length > 0 &&
      typeof source.fromMe === 'boolean' &&
      object(target) &&
      Object.keys(target).every((name) => ['id', 'remoteJid', 'fromMe', 'participant'].includes(name)) &&
      typeof target.id === 'string' &&
      target.id.length > 0 &&
      target.id !== source.id &&
      target.remoteJid === source.remoteJid &&
      target.fromMe === source.fromMe &&
      (target.participant === undefined || (typeof target.participant === 'string' && target.participant.length > 0)) &&
      object(edit) &&
      Object.keys(edit).length === 1 &&
      ((typeof edit.conversation === 'string' && edit.conversation.length > 0) ||
        (object(edit.extendedTextMessage) &&
          Object.keys(edit.extendedTextMessage).every((name) =>
            [
              'text',
              'contextInfo',
              'endCardTiles',
              'title',
              'matchedText',
              'previewType',
              'inviteLinkGroupTypeV2',
            ].includes(name),
          ) &&
          typeof edit.extendedTextMessage.text === 'string' &&
          edit.extendedTextMessage.text.length > 0 &&
          ['title', 'matchedText'].every(
            (name) =>
              edit.extendedTextMessage[name] === undefined || typeof edit.extendedTextMessage[name] === 'string',
          ) &&
          ['previewType', 'inviteLinkGroupTypeV2'].every(
            (name) => edit.extendedTextMessage[name] === undefined || edit.extendedTextMessage[name] === 0,
          ) &&
          (edit.extendedTextMessage.contextInfo === undefined || object(edit.extendedTextMessage.contextInfo)) &&
          (edit.extendedTextMessage.endCardTiles === undefined ||
            (Array.isArray(edit.extendedTextMessage.endCardTiles) &&
              edit.extendedTextMessage.endCardTiles.length === 0))) ||
        retainedNativeJPEGDescriptor(edit.imageMessage)),
  );
}

export function classifyCachedHistoryRecord(
  record: {
    messageType: string;
    message: unknown;
    key?: unknown;
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
  | 'plaintext_edit'
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
  if (isKnownPlaintextHistoryEdit(record)) return 'plaintext_edit';
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
  // A decoded sender-key envelope may retain an explicitly empty conversation field.
  // Require the complete positive envelope; ordinary text or media must never be skipped.
  if (
    !edited &&
    record.messageType === 'conversation' &&
    (payload as any).conversation === '' &&
    keys.includes('senderKeyDistributionMessage') &&
    keys.every((key) => ['conversation', 'senderKeyDistributionMessage', 'messageContextInfo'].includes(key)) &&
    validSenderKeySidecar(payload) &&
    typeof (payload as any).senderKeyDistributionMessage?.groupId === 'string' &&
    (payload as any).senderKeyDistributionMessage.groupId.length > '@g.us'.length &&
    (payload as any).senderKeyDistributionMessage.groupId.endsWith('@g.us') &&
    (record.key as any)?.remoteJid === (payload as any).senderKeyDistributionMessage.groupId
  )
    return 'encryption_control';
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
