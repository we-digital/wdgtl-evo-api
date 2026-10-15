import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import dayjs from 'dayjs';
import ts from 'typescript';
import {
  findStoredHistoryIds,
  HISTORY_PAGE_SIZE,
  historySourceFingerprint,
  storedHistoryPages,
  withLockedHistoryDependencies,
} from '../src/api/integrations/chatbot/chatwoot/utils/history-memory-budget';
import * as normalization from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import * as coordinator from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync-coordinator';
import { metricsPeerAllowed, createRuntimeMetrics } from '../src/utils/runtime-metrics';

const fixture = (count = 1100) =>
  Array.from({ length: count }, (_, i) => ({
    id: String(i).padStart(8, '0'),
    instanceId: 'a',
    key: {
      id: i === 550 ? 'native-1' : `native-${i}`,
      remoteJid:
        i % 5 === 0
          ? '120363000000000001@g.us'
          : i % 7 === 0
            ? '9000@lid'
            : i % 11 === 0
              ? '9999@lid'
              : '628100000001@s.whatsapp.net',
      ...(i === 1099 ? { remoteJid: '9000@lid', remoteJidAlt: '628100000002@s.whatsapp.net' } : {}),
      fromMe: i % 2 === 0,
    },
    messageTimestamp: 1700000000 + Math.floor(i / 300),
    messageType: 'conversation',
    message: { conversation: `synthetic-${i}` },
    pushName: 'Synthetic',
  })) as any[];

function matches(row: any, where: any): boolean {
  if (!where) return true;
  if (where.AND && !where.AND.every((clause: any) => matches(row, clause))) return false;
  if (where.OR && !where.OR.some((clause: any) => matches(row, clause))) return false;
  if (where.instanceId && row.instanceId !== where.instanceId) return false;
  if (where.Instance && row.instanceId !== 'a') return false;
  for (const field of ['id', 'messageTimestamp']) {
    const term = where[field];
    if (term === undefined) continue;
    if (typeof term !== 'object') {
      if (row[field] !== term) return false;
    } else
      for (const [op, value] of Object.entries(term)) {
        if (op === 'in' && !(value as unknown[]).includes(row[field])) return false;
        if (op === 'gt' && !(row[field] > value!)) return false;
        if (op === 'gte' && !(row[field] >= value!)) return false;
        if (op === 'lt' && !(row[field] < value!)) return false;
        if (op === 'lte' && !(row[field] <= value!)) return false;
      }
  }
  if (where.key && row.key.id !== where.key.equals) return false;
  return true;
}
function repository(rows: any[]) {
  const calls: any[] = [];
  return {
    calls,
    findMany: async (args: any) => {
      calls.push(args);
      let found = rows.filter((row) => matches(row, args.where));
      const order = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
      found.sort((a, b) => {
        for (const item of order)
          for (const [key, direction] of Object.entries(item)) {
            const delta = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
            if (delta) return delta * (direction === 'desc' ? -1 : 1);
          }
        return 0;
      });
      if (args.take !== undefined) found = found.slice(0, args.take);
      return found.map((row) =>
        args.select ? Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]])) : { ...row },
      );
    },
  };
}

function service(source: string, rows: any[], existing = new Set<string>()) {
  const file = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const klass = file.statements.find(ts.isClassDeclaration)!;
  const method = klass.members.find((m) => m.name?.getText(file) === 'syncStoredHistory')!.getText(file);
  const imported: string[][] = [];
  const plans: any[] = [];
  let fail = false;
  let beforeLock: (() => void) | undefined;
  const context = {
    module: { exports: undefined as any },
    ...normalization,
    ...coordinator,
    storedHistoryPages,
    withLockedHistoryDependencies: (uri: string, name: string, ids: string[], verify: any, write: any) =>
      withLockedHistoryDependencies(uri, name, ids, verify, write, {
        clientFactory: () => ({
          on() {},
          end: async () => {},
          connect: async () => {
            beforeLock?.();
          },
          query: async (sql: string, values: any[]) => {
            if (!sql.startsWith('SELECT m.*')) return { rows: [] };
            assert.match(sql, /FOR SHARE OF m/);
            assert.ok(values[1].length <= 250);
            return {
              rows: rows
                .filter((row) => row.instanceId === 'a' && values[1].includes(row.id))
                .map((row) => structuredClone(row)),
            };
          },
        }),
      }),
    createHistoryDatabaseScope: () => ({ database: {}, close: async () => {} }),
    postgresClient: { getChatwootConnection: () => ({}) },
    HISTORY_PAGE_SIZE,
    historySourceFingerprint,
    createHash,
    dayjs,
    BadRequestException: Error,
    chatwootImport: {
      getExistingSourceIds: async (ids: string[]) =>
        new Set(ids.map(normalization.toChatwootSourceId).filter((id) => existing.has(id))),
      getChatwootUser: async () => ({ user_type: 'User', user_id: 1 }),
      getContentMessage: (_service: any, message: any) => message.message?.conversation,
      importHistoryMessages: async (_instance: any, _svc: any, _inbox: any, _provider: any, options: any) => {
        if (fail) throw new Error('synthetic destination failure');
        plans.push(options);
        imported.push(options.messages.map((m: any) => m.key.id));
        for (const m of options.messages) existing.add(normalization.toChatwootSourceId(m.key.id));
        return options.messages.length;
      },
    },
  };
  vm.runInNewContext(
    ts.transpileModule(`module.exports=class { ${method} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  );
  const svc = new context.module.exports();
  const repo = repository(rows);
  const read = repo.findMany;
  repo.findMany = async (args: any) => {
    if (args.where?.id?.in) beforeLock?.(); // also exercise the previous read-before-write path
    return read(args);
  };
  Object.assign(svc, {
    isImportHistoryAvailable: () => true,
    getProvider: async () => ({ importMessages: true, enabled: true }),
    clientCw: async () => ({}),
    getInbox: async () => ({ id: 42 }),
    prismaRepository: {
      message: repo,
      $transaction: async (work: any) => {
        beforeLock?.();
        return work({
          $queryRaw: async (sql: any) => {
            assert.match(sql.text, /FOR SHARE OF m/);
            const ids = sql.values.slice(1);
            assert.ok(ids.length <= 250);
            return rows
              .filter((row) => row.instanceId === 'a' && ids.includes(row.id))
              .map((row) => structuredClone(row));
          },
        });
      },
    },
    configService: {
      get: (category: string) =>
        category === 'DATABASE'
          ? { CONNECTION: { URI: 'postgresql://synthetic' } }
          : { PROVIDER_CONVERSATION_BINDINGS: true },
    },
    refreshKnownLidMappings: async () => ({ attemptedPhoneJids: 0, refreshedMappings: 0 }),
    resolvePhoneJidForLid: async () => null,
    getGroupIdentityNames: async () => new Map(),
    enableExtendedHistorySync: async () => {},
    waMonitor: { waInstances: {} },
  });
  return {
    svc,
    repo,
    imported,
    plans,
    setBeforeLock: (hook: () => void) => {
      beforeLock = hook;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}
const current = fs.readFileSync('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', 'utf8');
const baseline = execFileSync(
  'git',
  ['show', 'f544afce:src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts'],
  { encoding: 'utf8' },
);

test('incoming duplicate lookup is instance scoped and bounded even with duplicate persisted rows', async () => {
  const rows = fixture(800);
  rows.push(...fixture(700).map((r) => ({ ...r, id: `z${r.id}`, key: { id: 'native-1' } })), {
    id: 'foreign',
    instanceId: 'b',
    key: { id: 'foreign-only' },
  });
  const repo = repository(rows);
  const found = await findStoredHistoryIds(repo as any, 'a', [...rows.map((r) => r.key.id), 'absent']);
  assert.ok(found.has('native-1'));
  assert.ok(!found.has('absent'));
  assert.ok(!found.has('foreign-only'));
  assert.ok(repo.calls.every((call) => call.take === 250 && call.select.key && !call.select.message));
  assert.ok(repo.calls.every((call) => call.where.OR.length <= 250));
});

test('timestamp/id pagination has no omissions or duplicates across equal-timestamp pages', async () => {
  const rows = fixture(1100);
  const repo = repository(rows);
  const ids: string[] = [];
  for await (const page of storedHistoryPages(repo as any, { instanceId: 'a' })) {
    assert.ok(page.length <= 250);
    ids.push(...page.map((r) => r.id));
  }
  assert.deepEqual(
    ids,
    rows.map((r) => r.id),
  );
});

for (const args of [
  {},
  { scope: 'all', unresolvedLidMode: 'provisional' },
  { scope: 'groups', limit: 9 },
  { since: '2023-11-14T22:13:22Z', scope: 'all' },
  { remoteJid: '9000@lid' },
  { remoteJid: '9999@lid', unresolvedLidMode: 'provisional', scope: 'all' },
])
  test(`paged dry-run matches the previously released whole-history contract ${JSON.stringify(args)}`, async () => {
    const old = service(baseline, fixture(), new Set(['WAID:native-10']));
    const next = service(current, fixture(), new Set(['WAID:native-10']));
    const before = await old.svc.syncStoredHistory({ instanceName: 'synthetic' }, args);
    const after = await next.svc.syncStoredHistory({ instanceName: 'synthetic' }, args);
    assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
    assert.ok(next.repo.calls.every((call) => call.take <= 250));
    assert.equal(next.imported.length, 0);
  });

test('paged write preserves selected identities/global limit and retries idempotently after an error', async () => {
  const old = service(baseline, fixture());
  const next = service(current, fixture());
  const args = { scope: 'all', unresolvedLidMode: 'provisional', dryRun: false, limit: 777 };
  const before = await old.svc.syncStoredHistory({ instanceName: 'synthetic' }, args);
  const after = await next.svc.syncStoredHistory({ instanceName: 'synthetic' }, args);
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
  assert.deepEqual(next.imported.flat(), old.imported.flat());
  assert.ok(next.imported.every((batch) => batch.length <= 250));
  next.setFail(true);
  await assert.rejects(
    next.svc.syncStoredHistory({ instanceName: 'synthetic' }, { ...args, limit: 10 }),
    /synthetic destination failure/,
  );
  next.setFail(false);
  const retry = await next.svc.syncStoredHistory({ instanceName: 'synthetic' }, { ...args, limit: 10 });
  assert.equal(retry.appliedMessages, 10);
});

test('metrics allowlist binds actual TCP peer, including mapped loopback; memory belongs to this process', () => {
  assert.equal(metricsPeerAllowed('::ffff:127.0.0.1', '127.0.0.1,::1'), true);
  assert.equal(metricsPeerAllowed('10.0.0.1', '127.0.0.1,::1'), false);
  assert.equal(metricsPeerAllowed(undefined, '127.0.0.1'), false);
  const lines = createRuntimeMetrics()().join('\n');
  assert.match(lines, /evolution_process_rss_bytes [1-9][0-9]+/);
  assert.match(lines, /evolution_process_heap_used_bytes [1-9][0-9]+/);
});

test('planning retains whole-conversation last timestamp and first human name beyond the first page', async () => {
  const rows = fixture();
  for (const row of rows) row.pushName = '';
  rows[501].pushName = 'Late synthetic human';
  const next = service(current, rows);
  await next.svc.syncStoredHistory({ instanceName: 'synthetic' }, { scope: 'all', dryRun: false, limit: 777 });
  const plan = next.plans[0];
  assert.equal(plan.identityTimestamps.get('628100000001@s.whatsapp.net').last, 1700000002);
  assert.equal(plan.identityPushNames.get('628100000001@s.whatsapp.net'), 'Late synthetic human');
});

test('a source replacement at lock admission is refused before any destination write', async () => {
  const rows = fixture();
  const next = service(current, rows);
  next.setBeforeLock(() => {
    rows[1].message = { conversation: 'changed after planning' };
  });
  await assert.rejects(
    next.svc.syncStoredHistory({ instanceName: 'synthetic' }, { scope: 'all', dryRun: false }),
    /source changed/,
  );
  assert.equal(next.imported.length, 0);
});

test('adversarial out-of-order database IDs preserve chronological LID mapping evidence', async () => {
  const rows = fixture(2);
  rows[0].messageTimestamp = 1700000002;
  rows[1].messageTimestamp = 1700000001;
  rows[0].key = { id: 'first', remoteJid: '9000@lid', remoteJidAlt: '628100000002@s.whatsapp.net', fromMe: false };
  rows[1].key = { id: 'second', remoteJid: '9000@lid', remoteJidAlt: '628100000001@s.whatsapp.net', fromMe: false };
  const args = { remoteJid: '628100000002@s.whatsapp.net' };
  const old = await service(baseline, rows).svc.syncStoredHistory({ instanceName: 'synthetic' }, args);
  const next = await service(current, rows).svc.syncStoredHistory({ instanceName: 'synthetic' }, args);
  assert.equal(next.routeMessages, old.routeMessages);
});

for (const change of ['name', 'timestamp', 'delete'])
  test(`later metadata donor ${change} refuses before the first dependent import`, async () => {
    const rows = fixture(501).map((row, index) => ({
      ...row,
      key: { id: 'NATIVE-' + index, remoteJid: '628100000001@s.whatsapp.net', fromMe: false },
      messageTimestamp: 1700000000 + index,
      pushName: index === 500 ? 'Later donor' : '',
    }));
    const next = service(current, rows);
    next.setBeforeLock(() => {
      if (change === 'name') rows[500].pushName = 'Rotated donor';
      if (change === 'timestamp') rows[500].messageTimestamp++;
      if (change === 'delete') rows.splice(500, 1);
    });
    await assert.rejects(
      next.svc.syncStoredHistory({ instanceName: 'synthetic' }, { dryRun: false }),
      /dependency|source changed/,
    );
    assert.equal(next.imported.length, 0);
    assert.equal(next.plans.length, 0);
  });

test('changed key-only routing donor outside selected payload refuses before metadata writes', async () => {
  const rows = fixture(501).map((row, index) => ({
    ...row,
    key: {
      id: 'NATIVE-' + index,
      remoteJid: '9000@lid',
      fromMe: false,
      ...(index === 500 ? { remoteJidAlt: '628100000001@s.whatsapp.net' } : {}),
    },
    messageTimestamp: 1700000000 + index,
  }));
  const next = service(current, rows);
  next.setBeforeLock(() => {
    rows[500].key.remoteJidAlt = '628100000002@s.whatsapp.net';
  });
  await assert.rejects(
    next.svc.syncStoredHistory({ instanceName: 'synthetic' }, { dryRun: false, limit: 10 }),
    /routing dependency/,
  );
  assert.equal(next.imported.length, 0);
});

test('chronological LID precedence survives conflicting evidence on different pages and a fixed horizon', async () => {
  const rows = fixture(501).map((row, index) => ({
    ...row,
    key: { id: 'NATIVE-' + index, remoteJid: '9000@lid', fromMe: false },
    messageTimestamp: 1700000000 + index,
  }));
  rows[0].id = 'z';
  rows[0].key.remoteJidAlt = '628100000001@s.whatsapp.net';
  rows[500].id = 'a';
  rows[500].key.remoteJidAlt = '628100000002@s.whatsapp.net';
  const args = { remoteJid: '628100000002@s.whatsapp.net' };
  const before = await service(baseline, rows).svc.syncStoredHistory({ instanceName: 'synthetic' }, args);
  const after = await service(current, rows).svc.syncStoredHistory({ instanceName: 'synthetic' }, args);
  assert.equal(after.routeMessages, before.routeMessages);
  const repositoryRows = fixture(501);
  const repo = repository(repositoryRows);
  const visited: string[] = [];
  let inserted = false;
  for await (const page of storedHistoryPages(repo as any, { instanceId: 'a' }, { key: true })) {
    visited.push(...page.map((row) => row.id));
    if (!inserted) {
      repositoryRows.push({ ...fixture(1)[0], id: 'zz', messageTimestamp: 1800000000 });
      inserted = true;
    }
  }
  assert.equal(visited.length, 501);
  assert.equal(visited.includes('zz'), false);
});

test('raw SQL and Prisma property order do not rotate the immutable native source fingerprint', () => {
  const original = fixture(1)[0];
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.key = Object.fromEntries(Object.entries(original.key).reverse());
  assert.equal(historySourceFingerprint(reordered), historySourceFingerprint(original));
  assert.notEqual(historySourceFingerprint({ ...reordered, pushName: 'changed' }), historySourceFingerprint(original));
});
