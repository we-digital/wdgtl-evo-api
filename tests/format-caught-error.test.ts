import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCaughtError } from '@utils/formatCaughtError';

test('formats Error instances with their message', () => {
  assert.match(formatCaughtError(new Error('request failed')), /request failed/);
});

test('formats structured API errors without logging request credentials', () => {
  const error: any = {
    code: 'ERR_BAD_RESPONSE',
    response: { status: 422, data: { error: 'invalid identifier' } },
    config: { headers: { apiKey: 'must-not-leak' } },
  };
  error.self = error;

  const formatted = formatCaughtError(error);

  assert.match(formatted, /ERR_BAD_RESPONSE/);
  assert.match(formatted, /422/);
  assert.match(formatted, /invalid identifier/);
  assert.doesNotMatch(formatted, /must-not-leak/);
  assert.doesNotMatch(formatted, /config/);
  assert.match(formatted, /\[circular\]/);
});
