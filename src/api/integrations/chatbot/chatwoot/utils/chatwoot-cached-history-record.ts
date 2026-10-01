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
  )
    return 'ordinary';
  throw new Error('Cached history contains an unknown or contradictory record');
}
