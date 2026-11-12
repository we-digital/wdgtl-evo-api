import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Guards for the pinned we:Digital Baileys build. They fail fast when a re-pin
// silently loses a property production depends on.
const baileysRoot = path.dirname(require.resolve('baileys/package.json'));
const lib = (file: string) => fs.readFileSync(path.join(baileysRoot, 'lib', file), 'utf8');

test('pinned Baileys loads from CommonJS, including its Rust bridge', () => {
  const baileys = require('baileys');
  assert.equal(typeof baileys.makeWASocket, 'function');
  assert.equal(typeof require('whatsapp-rust-bridge').expandAppStateKeys, 'function');
});

test('pinned Baileys is the we:Digital fork with group sender-key repair', () => {
  const pkg = require('baileys/package.json');
  assert.match(pkg.version, /-wdgtl\.\d+$/);
  assert.match(lib('Socket/messages-send.js'), /repairGroupSenderKeyDistribution/);
});

test('pinned Baileys sends group phash and recovers only on a real mismatch', () => {
  assert.match(lib('Socket/messages-send.js'), /groupParticipantHash\(/);
  assert.match(lib('Socket/messages-recv.js'), /participantHashAckAction\(/);
});

test('pinned Baileys drops spoofed self-only protocol messages (GHSA-qvv5-jq5g-4cgg)', () => {
  assert.match(lib('Utils/process-message.js'), /dropping spoofed self-only protocolMessage/);
});

test('pinned Baileys keeps both Signal LRU caches bounded and timer-free', () => {
  for (const file of ['Signal/lid-mapping.js', 'Signal/libsignal.js']) {
    const source = lib(file);
    assert.match(source, /max: 10000,\s*ttlAutopurge: false/, file);
    assert.doesNotMatch(source, /ttlAutopurge: true/, file);
  }
});
