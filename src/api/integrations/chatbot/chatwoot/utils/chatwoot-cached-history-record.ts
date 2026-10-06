const ordinaryTypes = new Set([
  'conversation',
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
]);
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
  | 'encryption_control'
  | 'unavailable_image_edit'
  | 'unavailable_text_edit'
  | 'unavailable_document_edit'
  | 'encrypted_edit'
  | 'pin_control'
  | 'poll_control' {
  const payload = record.message;
  // SQL JSON null is an unavailable retained edit, never an instruction to clear its destination.
  if (payload === null && edited && record.messageType === 'documentMessage') return 'unavailable_document_edit';
  if (payload === null && edited && record.messageType === 'imageMessage') return 'unavailable_image_edit';
  if (
    (payload === null ||
      (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0)) &&
    edited &&
    ['conversation', 'extendedTextMessage'].includes(record.messageType)
  )
    return 'unavailable_text_edit';
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Cached history payload is unclassifiable');
  }
  const keys = Object.keys(payload);
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
      typeof reaction.text === 'string' &&
      typeof reaction.key?.id === 'string' &&
      reaction.key.id.length > 0 &&
      typeof reaction.key?.remoteJid === 'string'
    )
      return 'reaction_control';
    throw new Error('Cached reaction control is unclassifiable');
  }
  const primary = (payload as Record<string, any>)[record.messageType];
  const validTarget = (key: any) =>
    key &&
    typeof key.id === 'string' &&
    key.id.length > 0 &&
    typeof key.remoteJid === 'string' &&
    typeof key.fromMe === 'boolean';
  if (
    record.messageType === 'secretEncryptedMessage' &&
    keys.every((key) => key === record.messageType || key === 'messageContextInfo') &&
    primary?.secretEncType === 2 &&
    validTarget(primary.targetMessageKey) &&
    primary.encIv != null &&
    primary.encPayload != null
  )
    return 'encrypted_edit';
  if (
    record.messageType === 'pinInChatMessage' &&
    keys.every((key) => key === record.messageType || key === 'messageContextInfo') &&
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
