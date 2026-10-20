import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { LIDMappingStore } from '../node_modules/baileys/lib/Signal/lid-mapping.js';
import { addTransactionCapability } from '../node_modules/baileys/lib/Utils/auth-utils.js';
assert.equal(typeof global.gc, 'function', 'run with --expose-gc');
const logger = { trace(){}, debug(){}, warn(){}, error(){} };
const durable = {};
const keys = addTransactionCapability({
  async get(type, ids) {
    if (type === 'synthetic-payload') return Object.fromEntries(ids.map(id => [id, randomBytes(16384).toString('hex')]));
    return Object.fromEntries(ids.filter(id => durable[type]?.[id] !== undefined).map(id => [id, durable[type][id]]));
  },
  async set(data) { for (const [type, values] of Object.entries(data)) Object.assign(durable[type] ??= {}, values); }
}, logger, { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
const mappings = new LIDMappingStore(keys, logger);
assert.equal(mappings.mappingCache.max, 10000);
assert.equal(mappings.mappingCache.ttlAutopurge, false);
assert.equal(mappings.mappingCache.ttl, 259200000);
let timers = 0;
const hook = createHook({ init(id, type) { if (type === 'Timeout') timers++; } });
async function gc() { for(let i=0;i<4;i++){ await new Promise(setImmediate); global.gc(); } }
await gc(); const before = process.memoryUsage().heapUsed;
hook.enable();
for(let i=0;i<2000;i++) await keys.transaction(async () => {
  await keys.get('synthetic-payload', ['context']);
  await mappings.storeLIDPNMappings([{lid:`${1000000+i}@lid`,pn:`${2000000+i}@s.whatsapp.net`}]);
}, 'synthetic');
hook.disable(); await gc();
const retainedMiB = (process.memoryUsage().heapUsed - before) / 2**20;
assert.equal(timers, 0, 'Signal transaction contexts must not be captured by TTL timers');
assert.ok(retainedMiB < 12, `unexpected retained transaction heap ${retainedMiB} MiB`);
for(let i=2000;i<6000;i++) await mappings.storeLIDPNMappings([{lid:`${1000000+i}@lid`,pn:`${2000000+i}@s.whatsapp.net`}]);
assert.equal(mappings.mappingCache.size, 10000);
assert.equal(mappings.mappingCache.has('pn:2000000'), false, 'old mapping must be evicted');
assert.equal(await mappings.getLIDForPN('2000000@s.whatsapp.net'), '1000000@lid', 'eviction must recover persistent mapping');
assert.equal(mappings.mappingCache.size, 10000);
console.log(JSON.stringify({pass:true, transactions:2000, createdTimers:timers, retainedMiB, boundedEntries:10000, durableFallback:true, networkCalls:0}));
mappings.mappingCache.clear();
