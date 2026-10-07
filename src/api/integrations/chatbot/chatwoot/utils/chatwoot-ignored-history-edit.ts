import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Message } from '@prisma/client';

export const IGNORED_HISTORY_EDIT_REASON = 'preserved_existing_ignored_provider_edit';

export type IgnoredHistoryEditKind = 'unavailable' | 'conflicting';
export type IgnoredHistoryEditProof = {
  version: 1;
  kind: IgnoredHistoryEditKind;
  rejection: string;
  editRepresentation?: 'same_native_type_conflict';
  editSourceId: string;
  editNativeId: string;
  targetSourceId: string;
  targetNativeId: string;
  peer: string;
  direction: 'incoming' | 'outgoing';
  accountId: number;
  inboxId: number;
  destinationMessageId: number;
  destinationConversationId: number;
  nativeVersionSHA256: string;
  destinationVersionSHA256: string;
};

export const CONFLICTING_TEXT_EDIT_REJECTION = 'Retained provider edit body conflicts with its declared original type';

export function isSameNativeTextEditConflict(message: Message): boolean {
  const body = message.message as any;
  return (
    message.status === 'EDITED' &&
    message.messageType === 'conversation' &&
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).includes('extendedTextMessage') &&
    Object.keys(body).every((key) =>
      ['extendedTextMessage', 'messageContextInfo', 'senderKeyDistributionMessage', 'mediaUrl'].includes(key),
    ) &&
    typeof body.extendedTextMessage?.text === 'string'
  );
}

/** The rejected edit's target metadata never grants authority to change a message. */
export function assertIgnoredEditOriginalIdentity(envelope: Message, original: Message): void {
  const key = envelope.key as any;
  const originalKey = original.key as any;
  const encrypted = (envelope.message as any)?.secretEncryptedMessage;
  if (
    envelope.id === original.id &&
    envelope.instanceId === original.instanceId &&
    isSameNativeTextEditConflict(envelope) &&
    isSameNativeTextEditConflict(original) &&
    isDeepStrictEqual(envelope, original) &&
    typeof key?.id === 'string' &&
    key.id.length > 0 &&
    key.id === originalKey?.id &&
    typeof key.fromMe === 'boolean' &&
    key.fromMe === originalKey.fromMe &&
    typeof key.remoteJid === 'string' &&
    key.remoteJid.length > 0 &&
    key.remoteJid === originalKey.remoteJid
  )
    return;
  if (
    envelope.instanceId !== original.instanceId ||
    encrypted?.secretEncType !== 2 ||
    typeof key?.id !== 'string' ||
    !key.id ||
    typeof originalKey?.id !== 'string' ||
    !originalKey.id ||
    encrypted.targetMessageKey?.id !== originalKey.id ||
    typeof key.fromMe !== 'boolean' ||
    key.fromMe !== originalKey.fromMe ||
    typeof key.remoteJid !== 'string' ||
    key.remoteJid !== originalKey.remoteJid
  )
    throw new Error('Ignored provider edit lacks a proven original native identity');
}

/** Only known edit-content failures may use preservation. Programming/network errors still fail. */
export function ignoredHistoryEditFailure(error: unknown): IgnoredHistoryEditKind | undefined {
  if (!(error instanceof Error)) return undefined;
  if (
    new Set([
      'Retained encrypted edit target identity differs',
      'Retained encrypted edit ordering is unavailable or older than the current original',
      'Retained encrypted edit original author differs',
      'Retained encrypted edit inner target differs',
    ]).has(error.message)
  )
    return 'conflicting';
  if (
    new Set([
      'Retained encrypted edit has invalid bytes',
      'Retained encrypted edit lacks an explicit provider sender',
      'Retained encrypted edit has invalid authenticated lengths',
      'Retained encrypted edit authentication failed',
      'Retained encrypted edit has unknown protobuf data',
      'Retained encrypted edit authenticated metadata is unsupported',
      'Retained encrypted edit content is unsupported',
    ]).has(error.message)
  )
    return 'unavailable';
  return undefined;
}

export const UNAVAILABLE_ORIGINAL_EDIT_REASON = 'ignored_unavailable_provider_edit_original';

export type UnavailableOriginalEditState = {
  sourceRows: Message[];
  targetUpdates: Array<{ instanceId: string; messageId: string; status: string }>;
  competitors: Message[];
};

export type UnavailableOriginalEditProof = {
  version: 1;
  kind:
    | 'null_image_original'
    | 'encrypted_edit_null_image_original'
    | 'null_text_original'
    | 'encrypted_edit_null_text_original';
  sourceId: string;
  sourceNativeId: string;
  targetSourceId: string;
  targetNativeId: string;
  instanceId: string;
  accountId: number;
  inboxId: number;
  peer: string;
  direction: 'incoming' | 'outgoing';
  destinationAbsent: true;
  targetDirectionDiscrepancy?: 'target_key_differs_from_native_original';
  sourceNativeJSON: string;
  targetNativeJSON: string;
  orderingJSON: string;
  sourceNativeVersionSHA256: string;
  targetNativeVersionSHA256: string;
  orderingSHA256: string;
};

export function isUnavailableNullImageOriginal(message: Message): boolean {
  const key = message.key as { id?: unknown; fromMe?: unknown; remoteJid?: unknown };
  return (
    message.status === 'EDITED' &&
    message.messageType === 'imageMessage' &&
    message.message === null &&
    typeof message.id === 'string' &&
    message.id.length > 0 &&
    typeof message.instanceId === 'string' &&
    message.instanceId.length > 0 &&
    typeof key?.id === 'string' &&
    key.id.length > 0 &&
    typeof key.fromMe === 'boolean' &&
    typeof key.remoteJid === 'string' &&
    key.remoteJid.length > 0 &&
    Number.isSafeInteger(message.messageTimestamp) &&
    message.messageTimestamp > 0 &&
    message.chatwootMessageId === null &&
    message.chatwootConversationId === null &&
    message.chatwootInboxId === null
  );
}

export function isUnavailableNullTextOriginal(message: Message): boolean {
  if (!['conversation', 'extendedTextMessage'].includes(message.messageType)) return false;
  const key = message.key as { id?: unknown; fromMe?: unknown; remoteJid?: unknown };
  return (
    message.status === 'EDITED' &&
    message.message === null &&
    typeof message.id === 'string' &&
    message.id.length > 0 &&
    typeof message.instanceId === 'string' &&
    message.instanceId.length > 0 &&
    typeof key?.id === 'string' &&
    key.id.length > 0 &&
    typeof key.fromMe === 'boolean' &&
    typeof key.remoteJid === 'string' &&
    key.remoteJid.length > 0 &&
    Number.isSafeInteger(message.messageTimestamp) &&
    message.messageTimestamp > 0 &&
    message.chatwootMessageId === null &&
    message.chatwootConversationId === null &&
    message.chatwootInboxId === null
  );
}

export function isUnavailableNullEditOriginal(message: Message): boolean {
  return isUnavailableNullImageOriginal(message) || isUnavailableNullTextOriginal(message);
}

/** Records unavailable native evidence; it never asserts a decrypted edit or preserved destination. */
export function unavailableOriginalEditProof(
  source: Message,
  target: Message,
  state: UnavailableOriginalEditState,
  accountId: number,
  inboxId: number,
): UnavailableOriginalEditProof {
  if (
    !isUnavailableNullEditOriginal(target) ||
    ![accountId, inboxId].every((id) => Number.isSafeInteger(id) && id > 0) ||
    state.competitors.length !== 0 ||
    state.targetUpdates.length !== 1 ||
    state.targetUpdates[0].instanceId !== target.instanceId ||
    state.targetUpdates[0].messageId !== target.id ||
    state.targetUpdates[0].status !== 'EDITED'
  )
    throw new Error('Unavailable edit original lacks exact native update provenance');
  const sameSource = source.id === target.id;
  const key = source.key as { id: string; fromMe: boolean; remoteJid: string };
  const targetKey = target.key as typeof key;
  let discrepancy: UnavailableOriginalEditProof['targetDirectionDiscrepancy'];
  if (sameSource) {
    if (!isDeepStrictEqual(source, target) || state.sourceRows.length !== 1)
      throw new Error('Unavailable edit original source is ambiguous');
  } else {
    assertIgnoredEditOriginalIdentity(source, target);
    const encrypted = (source.message as any)?.secretEncryptedMessage;
    if (
      source.messageType !== 'secretEncryptedMessage' ||
      encrypted.targetMessageKey.remoteJid !== targetKey.remoteJid ||
      typeof encrypted.targetMessageKey.fromMe !== 'boolean' ||
      !Number.isSafeInteger(source.messageTimestamp) ||
      source.messageTimestamp <= target.messageTimestamp ||
      state.sourceRows.length !== 2
    )
      throw new Error('Unavailable encrypted edit original identity or ordering differs');
    if (encrypted.targetMessageKey.fromMe !== targetKey.fromMe) discrepancy = 'target_key_differs_from_native_original';
  }
  const expected = sameSource ? [source] : [source, target];
  if (
    new Set(state.sourceRows.map((row) => row.id)).size !== expected.length ||
    expected.some((row) => !state.sourceRows.some((current) => isDeepStrictEqual(current, row)))
  )
    throw new Error('Unavailable edit original native source rotated');
  const sourceNativeJSON = JSON.stringify(source);
  const targetNativeJSON = JSON.stringify(target);
  const orderingJSON = JSON.stringify(state);
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  return {
    version: 1,
    kind: isUnavailableNullTextOriginal(target)
      ? sameSource
        ? 'null_text_original'
        : 'encrypted_edit_null_text_original'
      : sameSource
        ? 'null_image_original'
        : 'encrypted_edit_null_image_original',
    sourceId: `WAID:${key.id}`,
    sourceNativeId: source.id,
    targetSourceId: `WAID:${targetKey.id}`,
    targetNativeId: target.id,
    instanceId: target.instanceId,
    accountId,
    inboxId,
    peer: key.remoteJid,
    direction: key.fromMe ? 'outgoing' : 'incoming',
    destinationAbsent: true,
    ...(discrepancy ? { targetDirectionDiscrepancy: discrepancy } : {}),
    sourceNativeJSON,
    targetNativeJSON,
    orderingJSON,
    sourceNativeVersionSHA256: sha(sourceNativeJSON),
    targetNativeVersionSHA256: sha(targetNativeJSON),
    orderingSHA256: sha(orderingJSON),
  };
}
