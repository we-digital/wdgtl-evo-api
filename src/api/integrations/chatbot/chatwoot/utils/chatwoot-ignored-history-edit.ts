import { Message } from '@prisma/client';

export const IGNORED_HISTORY_EDIT_REASON = 'preserved_existing_ignored_provider_edit';

export type IgnoredHistoryEditKind = 'unavailable' | 'conflicting';
export type IgnoredHistoryEditProof = {
  version: 1;
  kind: IgnoredHistoryEditKind;
  rejection: string;
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

/** The rejected edit's target metadata never grants authority to change a message. */
export function assertIgnoredEditOriginalIdentity(envelope: Message, original: Message): void {
  const key = envelope.key as any;
  const originalKey = original.key as any;
  const encrypted = (envelope.message as any)?.secretEncryptedMessage;
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
