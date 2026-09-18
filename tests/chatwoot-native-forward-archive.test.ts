/**
 * Contract guards for native forward fail-closed behavior and archive stub refusal.
 * These mirror the production branching in chatwoot.service / baileys archiveChat
 * without spinning up Baileys sockets.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

function isAmbiguousForwardError(errorMessage: string): boolean {
  return /timeout|timed?\s*out|ECONNRESET|socket|abort|network/i.test(errorMessage);
}

function shouldRefuseArchiveLastKey(lastKeyId: string | undefined | null): boolean {
  const id = String(lastKeyId || '');
  return !id || id.startsWith('archive-stub-');
}

test('ambiguous native forward errors must not fall back to content re-send', () => {
  assert.equal(isAmbiguousForwardError('request timeout after 20s'), true);
  assert.equal(isAmbiguousForwardError('ECONNRESET'), true);
  assert.equal(isAmbiguousForwardError('socket hang up'), true);
  assert.equal(isAmbiguousForwardError('network unreachable'), true);
  // Deterministic application errors may still return null and allow content path.
  assert.equal(isAmbiguousForwardError('Message not found'), false);
  assert.equal(isAmbiguousForwardError('forbidden'), false);
});

test('archive refuses synthetic stub message keys', () => {
  assert.equal(shouldRefuseArchiveLastKey(undefined), true);
  assert.equal(shouldRefuseArchiveLastKey(''), true);
  assert.equal(shouldRefuseArchiveLastKey('archive-stub-1710000000'), true);
  assert.equal(shouldRefuseArchiveLastKey('3EB0ABCDEF'), false);
});
