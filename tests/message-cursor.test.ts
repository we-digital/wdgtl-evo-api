import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMessageCursorPage,
  MESSAGE_CURSOR_CONTRACT_VERSION,
  MESSAGE_CURSOR_MAX_PAGE_SIZE,
} from '@api/utils/message-cursor';
import { messageCursorValidateSchema } from '@validate/chat.schema';
import { validate } from 'jsonschema';

test('accepts only a bounded versioned keyset cursor request', () => {
  const valid = {
    contractVersion: MESSAGE_CURSOR_CONTRACT_VERSION,
    limit: MESSAGE_CURSOR_MAX_PAGE_SIZE,
    since: '1970-01-01T00:00:00.000Z',
    until: '2026-08-12T00:00:00.000Z',
    cursor: { messageTimestamp: 1_700_000_000, id: 'database-id' },
  };

  assert.equal(validate(valid, messageCursorValidateSchema).valid, true);
  assert.equal(validate({ ...valid, contractVersion: 'latest' }, messageCursorValidateSchema).valid, false);
  assert.equal(validate({ ...valid, limit: 501 }, messageCursorValidateSchema).valid, false);
  assert.equal(validate({ ...valid, since: 'not-a-date' }, messageCursorValidateSchema).valid, false);
});

test('emits a stable cursor from the last returned record', () => {
  const records = [
    { id: 'c', messageTimestamp: 10 },
    { id: 'b', messageTimestamp: 10 },
    { id: 'a', messageTimestamp: 9 },
  ];

  assert.deepEqual(createMessageCursorPage(records, 2), {
    contractVersion: MESSAGE_CURSOR_CONTRACT_VERSION,
    records: records.slice(0, 2),
    nextCursor: { messageTimestamp: 10, id: 'b' },
    hasMore: true,
  });
  assert.deepEqual(createMessageCursorPage(records.slice(0, 2), 2).nextCursor, null);
});
