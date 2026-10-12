import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Message } from '@prisma/client';

import { classifyCachedHistoryRecord } from './chatwoot-cached-history-record';
import { recoverEncryptedHistoryEdit } from './chatwoot-encrypted-history-edit';
import { toChatwootSourceId } from './chatwoot-history-sync';
import { assertIgnoredEditOriginalIdentity } from './chatwoot-ignored-history-edit';

export const SUPERSEDED_HISTORY_EDIT_REASON = 'preserved_existing_newer_source_edit';
export type EncryptedHistoryEditState = {
  sourceRows: Message[];
  targetUpdates: unknown[];
  competitors: Message[];
};
export type SupersededHistoryEdit = {
  newer: Message;
  recovered: Message;
  olderState: EncryptedHistoryEditState;
  newerState: EncryptedHistoryEditState;
  audit: {
    version: 1;
    reason: typeof SUPERSEDED_HISTORY_EDIT_REASON;
    olderSourceId: string;
    olderNativeVersionSHA256: string;
    olderTimestamp: number;
    newerSourceId: string;
    newerNativeId: string;
    newerNativeVersionSHA256: string;
    newerTimestamp: number;
    recoveredVersionSHA256: string;
    orderingVersionSHA256: string;
    contentSHA256: string;
  };
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Both envelopes authenticate against one unchanged original; this grants no edit write. */
export function qualifySupersededHistoryEdit(
  older: Message,
  original: Message,
  olderState: EncryptedHistoryEditState,
  newerState: EncryptedHistoryEditState,
): SupersededHistoryEdit {
  assertIgnoredEditOriginalIdentity(older, original);
  const newer = olderState.competitors[0];
  const exactPair = (state: EncryptedHistoryEditState, envelope: Message) =>
    state.sourceRows.length === 2 &&
    state.sourceRows.some((row) => isDeepStrictEqual(row, envelope)) &&
    state.sourceRows.some((row) => isDeepStrictEqual(row, original));
  if (
    olderState.competitors.length !== 1 ||
    !newer ||
    newer.id === older.id ||
    typeof (newer.key as any)?.id !== 'string' ||
    !(newer.key as any).id ||
    (newer.key as any).id === (older.key as any).id ||
    (newer.key as any).id === (original.key as any).id ||
    newer.messageType !== 'secretEncryptedMessage' ||
    older.messageType !== 'secretEncryptedMessage' ||
    !Number.isSafeInteger(older.messageTimestamp) ||
    !Number.isSafeInteger(newer.messageTimestamp) ||
    newer.messageTimestamp <= older.messageTimestamp ||
    olderState.targetUpdates.length !== 0 ||
    newerState.targetUpdates.length !== 0 ||
    newerState.competitors.length !== 0 ||
    !exactPair(olderState, older) ||
    !exactPair(newerState, newer)
  )
    throw new Error('Superseded provider edit lacks exact unambiguous newer native ordering');
  if (
    Buffer.byteLength(JSON.stringify(newer.message), 'utf8') > 64 * 1024 ||
    classifyCachedHistoryRecord(newer, newer.status === 'EDITED') !== 'encrypted_edit'
  )
    throw new Error('Superseded provider edit newer native envelope is unsupported or oversized');
  // Authentication also checks the raw peer, business direction, original author,
  // exact target key and retained message secret. Neither payload is applied.
  recoverEncryptedHistoryEdit(older, original);
  const recovered = recoverEncryptedHistoryEdit(newer, original);
  const content = supersededHistoryEditContent(recovered);
  return {
    newer,
    recovered,
    olderState,
    newerState,
    audit: {
      version: 1,
      reason: SUPERSEDED_HISTORY_EDIT_REASON,
      olderSourceId: toChatwootSourceId((older.key as any).id),
      olderNativeVersionSHA256: digest(older),
      olderTimestamp: older.messageTimestamp,
      newerSourceId: toChatwootSourceId((newer.key as any).id),
      newerNativeId: newer.id,
      newerNativeVersionSHA256: digest(newer),
      newerTimestamp: newer.messageTimestamp,
      recoveredVersionSHA256: digest(recovered),
      orderingVersionSHA256: digest({ olderState, newerState }),
      contentSHA256: createHash('sha256').update(content).digest('hex'),
    },
  };
}

export function supersededHistoryEditContent(recovered: Message): string {
  const body = recovered.message as any;
  const content = body?.conversation ?? body?.extendedTextMessage?.text ?? body?.documentMessage?.caption;
  if (typeof content !== 'string' || content.length === 0)
    throw new Error('Superseded provider edit latest authenticated content is unavailable');
  return content;
}
