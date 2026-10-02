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
): 'ordinary' | 'reaction_control' | 'encryption_control' | 'unavailable_image_edit' {
  const payload = record.message;
  // SQL JSON null is an unavailable retained edit, never an instruction to clear an image.
  if (payload === null && edited && record.messageType === 'imageMessage') return 'unavailable_image_edit';
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Cached history payload is unclassifiable');
  }
  const keys = Object.keys(payload);
  if (keys.length === 0 && edited && record.messageType === 'imageMessage') return 'unavailable_image_edit';
  if (record.messageType === 'reactionMessage' && keys.length === 1 && keys[0] === 'reactionMessage') {
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
