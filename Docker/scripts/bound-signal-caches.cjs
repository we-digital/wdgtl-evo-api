'use strict';
// Narrow, integrity-bound repair of the pinned controlled Baileys release.
// Both caches are derived from persistent Signal keys; eviction is a cache miss.
const { readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const root = join(__dirname, '../../node_modules/baileys/lib/Signal');
const files = [
  ['lid-mapping.js', '5fb880f2ae40f3f35b751de4aaf7a415d62432bd6f872ee70e1df235894641e4', 8],
  ['libsignal.js', 'e1950117537c23c8499c54c7c49379fb8a4545271888f629efbfc8dacc51f37d', 4],
];
const digest = value => createHash('sha256').update(value).digest('hex');
const changes = files.map(([name, expected, spaces]) => {
  const filename = join(root, name);
  const source = readFileSync(filename, 'utf8');
  const indent = ' '.repeat(spaces);
  const before = `${indent}ttlAutopurge: true,`;
  const after = `${indent}max: 10000,\n${indent}ttlAutopurge: false,`;
  const original = source.includes(after) ? source.replace(after, before) : source;
  if (digest(original) !== expected || original.split(before).length !== 2) {
    throw new Error(`Unrecognized pinned Baileys cache source: ${name}`);
  }
  return [filename, original.replace(before, after)];
});
for (const [filename, patched] of changes) writeFileSync(filename, patched);
console.log('Verified pinned Baileys: two bounded timer-free Signal caches');
