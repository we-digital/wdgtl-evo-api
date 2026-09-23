/**
 * Contract guards for native forward fail-closed behavior and archive stub refusal.
 * These call the production guard functions directly without spinning up
 * Baileys sockets.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAmbiguousNativeForwardError,
  isUsableArchiveMessageKey,
  resolveArchiveChatJid,
  resolveNativeChatProbeId,
  shouldAttemptNativeForward,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-native-guards';

test('ambiguous native forward errors must not fall back to content re-send', () => {
  assert.equal(isAmbiguousNativeForwardError('request timeout after 20s'), true);
  assert.equal(isAmbiguousNativeForwardError('ECONNRESET'), true);
  assert.equal(isAmbiguousNativeForwardError('socket hang up'), true);
  assert.equal(isAmbiguousNativeForwardError('network unreachable'), true);
  // Deterministic application errors may still return null and allow content path.
  assert.equal(isAmbiguousNativeForwardError('Message not found'), false);
  assert.equal(isAmbiguousNativeForwardError('forbidden'), false);
});

test('archive refuses synthetic stub message keys', () => {
  assert.equal(isUsableArchiveMessageKey(undefined), false);
  assert.equal(isUsableArchiveMessageKey(''), false);
  assert.equal(isUsableArchiveMessageKey('archive-stub-1710000000'), false);
  assert.equal(isUsableArchiveMessageKey('3EB0ABCDEF'), true);
});

test('native forwarding consumes explicit delivery mode with legacy fallback', () => {
  assert.equal(shouldAttemptNativeForward({ delivery_mode: 'native_forward', same_inbox: true }), true);
  assert.equal(shouldAttemptNativeForward({ delivery_mode: 'copy', same_inbox: true }), false);
  assert.equal(shouldAttemptNativeForward({ same_inbox: true }), true);
  assert.equal(shouldAttemptNativeForward({ same_inbox: false }), false);
});

test('archive chat JID prefers last message remoteJid over phone probe id', () => {
  assert.equal(
    resolveArchiveChatJid({
      chat: '5511999999999@s.whatsapp.net',
      lastMessageRemoteJid: '123456789012345@lid',
    }),
    '123456789012345@lid',
  );
  assert.equal(
    resolveArchiveChatJid({
      chat: '5511999999999',
      lastMessageRemoteJid: null,
    }),
    '5511999999999',
  );
  assert.equal(resolveArchiveChatJid({ chat: '', lastMessageRemoteJid: '  ' }), null);
});

test('native chat probe id prefers contact_inbox source_id then sender fields', () => {
  assert.equal(
    resolveNativeChatProbeId({
      contact_inbox: { source_id: '5511888777666' },
      meta: { sender: { identifier: '999@lid', phone_number: '+5511999999999' } },
    }),
    '5511888777666',
  );
  assert.equal(
    resolveNativeChatProbeId({
      meta: { sender: { identifier: 'abc@lid', phone_number: '+5511999999999' } },
    }),
    'abc@lid',
  );
  assert.equal(
    resolveNativeChatProbeId({
      meta: { sender: { phone_number: '+5511999999999' } },
    }, 'fallback'),
    '5511999999999',
  );
  assert.equal(resolveNativeChatProbeId({ meta: { sender: { identifier: '123456' } } }, 'ok'), 'ok');
  assert.equal(resolveNativeChatProbeId({}, ''), '');
});
