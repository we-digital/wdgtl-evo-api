#!/usr/bin/env node
// The official 2026-10-21 Node LTS security release, including its npm HTTP client.
const assert = require('node:assert/strict');
const actual = {
  node: process.versions.node,
  openssl: process.versions.openssl,
  builtinUndici: process.versions.undici,
  npmUndici: require('undici/package.json').version,
};
const expected = { node: '24.22.1', openssl: '3.5.9', builtinUndici: '7.30.1', npmUndici: '7.30.1' };
for (const [name, version] of Object.entries(expected)) {
  assert.equal(actual[name], version, `Unqualified security runtime: ${name}`);
}
console.log(JSON.stringify({ securityRuntimeVerified: true, ...actual }));
