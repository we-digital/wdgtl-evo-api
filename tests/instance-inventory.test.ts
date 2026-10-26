import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the literal production methods without booting provider sockets or schedulers.
function methods(path: string, names: string[], globals: Record<string, unknown> = {}) {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const cls = file.statements.find(ts.isClassDeclaration)!;
  const code = names.map(name => cls.members.find(m => m.name?.getText(file) === name)!.getText(file)).join('\n');
  const context = { module: { exports: undefined as any }, ...globals };
  vm.runInNewContext(ts.transpileModule(`module.exports = class { ${code} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return new context.module.exports();
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function fixture() {
  let connectionStatus = 'open';
  const calls: any[] = [];
  const row = { id: 'id-one', name: 'one', clientName: 'client', token: 'scoped', number: '100' };
  const repository = { instance: {
    findMany: async (args: any) => {
      calls.push(plain(args));
      const where = args.where;
      if (where.token) return where.token === 'scoped' && (!where.id || where.id === row.id) &&
        (!where.name || where.name === row.name) ? [row] : [];
      return [{ ...row, connectionStatus, Chatwoot: { enabled: true },
        ...(args.include._count ? { _count: { Message: 17, Contact: 3, Chat: 2 } } : {}) }];
    },
    findFirst: async ({ where }: any) => where.id === row.id || where.number === row.number ? row : null,
  } };
  const configService = { get: (key: string) => key === 'DATABASE' ?
    { CONNECTION: { CLIENT_NAME: 'client' } } : { API_KEY: { KEY: 'global' } } };
  const monitor = methods('src/api/services/monitor.service.ts', ['instanceInfo', 'instanceInfoById'],
    { NotFoundException: Error });
  Object.assign(monitor, { prismaRepository: repository, configService, waInstances: { one: {} } });
  const controller = methods('src/api/controllers/instance.controller.ts', ['fetchInstances'],
    { UnauthorizedException: Error });
  Object.assign(controller, { prismaRepository: repository, configService, waMonitor: monitor });
  const file = ts.createSourceFile('router.ts', readFileSync('src/api/routes/instance.router.ts', 'utf8'),
    ts.ScriptTarget.Latest, true);
  let callback: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' && node.arguments[0]?.getText(file).includes("'fetchInstances'")) {
      callback = node.arguments[node.arguments.length - 1];
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(callback);
  const context = { module: { exports: undefined as any }, instanceController: controller,
    BadRequestException: Error, InstanceDto: class {}, HttpStatus: { OK: 200 } };
  vm.runInNewContext(ts.transpileModule(`module.exports = function() { return ${callback!.getText(file)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  async function request(query: any = {}, key = 'global') {
    let body: any;
    const router = { dataValidate: async ({ execute }: any) => execute(query) };
    const res = { status: (code: number) => { assert.equal(code, 200); return res; }, json: (data: any) => { body = data; } };
    await context.module.exports.call(router)({ query, get: () => key }, res);
    return plain(body);
  }
  return { request, calls, monitor, setState: (value: string) => { connectionStatus = value; } };
}

test('omitted and true preserve exact counts; false omits only counts, not integration fields', async () => {
  const f = fixture();
  const full = await f.request();
  assert.deepEqual(await f.request({ includeCounts: 'true' }), full);
  const light = await f.request({ includeCounts: 'false' });
  const { _count, ...rest } = full[0];
  assert.deepEqual(_count, { Message: 17, Contact: 3, Chat: 2 });
  assert.deepEqual(light, [rest]);
  assert.equal(f.calls.at(-1).include._count, false);
  assert.equal(f.calls.at(-1).where.clientName, 'client');
  f.setState('close');
  assert.equal((await f.request({ includeCounts: 'false' }))[0].connectionStatus, 'close');
});

for (const key of ['global', 'scoped']) {
  for (const query of [{}, { instanceName: 'one' }, { instanceId: 'id-one' }, { number: '100' }]) {
    test(`lightweight inventory retains ${key} authorization/filter path ${JSON.stringify(query)}`, async () => {
      const f = fixture();
      const full = await f.request(query, key);
      const light = await f.request({ ...query, includeCounts: 'false' }, key);
      const { _count, ...rest } = full[0];
      assert.deepEqual(light, [rest]);
      assert.equal(f.calls.at(-1).include._count, false);
      if (key === 'scoped') {
        assert.ok(f.calls.some(call => call.where.token === 'scoped'));
        assert.deepEqual(f.calls.at(-1).where.name, { in: ['one'] });
      }
    });
  }
}

test('invalid tokens and non-owned names/IDs do not gain access through lightweight mode', async () => {
  const f = fixture();
  for (const query of [{}, { instanceName: 'one' }, { instanceId: 'id-one' }]) {
    await assert.rejects(f.request({ ...query, includeCounts: 'false' }, 'invalid'));
  }
  for (const query of [{ instanceName: 'other' }, { instanceId: 'other' }]) {
    await assert.rejects(f.request({ ...query, includeCounts: 'false' }, 'scoped'));
  }
  for (const query of [{ instanceName: 'other' }, { instanceId: 'other' }, { number: '999' }]) {
    await assert.rejects(f.request({ ...query, includeCounts: 'false' }));
  }
});

test('invalid, repeated and structured includeCounts fail before querying', async () => {
  const f = fixture();
  for (const value of ['', '0', 'False', 'yes', false, null, ['false', 'true'], { mode: 'false' }]) {
    await assert.rejects(f.request({ includeCounts: value }), /includeCounts must be true or false/);
  }
  assert.deepEqual(f.calls, []);
});

test('no instances remains an empty inventory, not a fabricated healthy instance', async () => {
  const f = fixture();
  f.monitor.prismaRepository.instance.findMany = async () => [];
  assert.deepEqual(await f.request({ includeCounts: 'false' }), []);
});

test('synthetic PostgreSQL: identical fields, fresh state and no history counts in lightweight polling',
  { skip: process.env.INSTANCE_INVENTORY_SYNTHETIC !== '1' }, async () => {
    const url = new URL(process.env.DATABASE_CONNECTION_URI!);
    assert.equal(url.hostname, 'postgres');
    assert.equal(url.searchParams.get('schema'), 'optimization1792990698');
    const { PrismaClient } = await import('@prisma/client');
    const queries: string[] = [];
    const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    db.$on('query', event => queries.push(event.query));
    const monitor = methods('src/api/services/monitor.service.ts', ['instanceInfo', 'instanceInfoById'],
      { NotFoundException: Error });
    Object.assign(monitor, { prismaRepository: db, waInstances: { synthetic: {} },
      configService: { get: () => ({ CONNECTION: { CLIENT_NAME: 'optimization-synthetic' } }) } });
    try {
      await db.instance.create({ data: { id: 'synthetic', name: 'synthetic', clientName: 'optimization-synthetic',
        connectionStatus: 'open' } });
      // Generated history in a task-owned schema; never use restored/customer tables.
      await db.$executeRawUnsafe(`INSERT INTO "Message" (id, key, message, "messageType", "messageTimestamp", "instanceId", "source")
        SELECT 'm-' || i, '{}'::jsonb, '{}'::jsonb, 'conversation', 1700000000, 'synthetic', 'web'
        FROM generate_series(1, 100000) i`);
      await db.$executeRawUnsafe('ANALYZE "Message"');
      const full = plain(await monitor.instanceInfo());
      assert.equal(full[0]._count.Message, 100000);
      queries.length = 0;
      const timings: number[] = [];
      for (let i = 0; i < 12; i++) {
        const start = performance.now();
        const light = plain(await monitor.instanceInfo(undefined, false));
        timings.push(performance.now() - start);
        const { _count, ...rest } = full[0];
        assert.deepEqual(light, [rest]);
      }
      assert.equal(queries.filter(q => /\bCOUNT\s*\(/i.test(q)).length, 0);
      assert.equal(queries.filter(q => /"(Message|Contact|Chat)"/.test(q)).length, 0);
      const lightMs = timings.reduce((a, b) => a + b, 0);
      queries.length = 0;
      const start = performance.now();
      for (let i = 0; i < 12; i++) await monitor.instanceInfo();
      const fullMs = performance.now() - start;
      assert.equal(queries.filter(q => /\bCOUNT\s*\(/i.test(q)).length, 12);
      await db.instance.update({ where: { id: 'synthetic' }, data: { connectionStatus: 'close' } });
      assert.equal((await monitor.instanceInfo(undefined, false))[0].connectionStatus, 'close');
      const named = plain(await monitor.instanceInfo(['synthetic'], false));
      assert.equal(named.length, 1);
      assert.equal('_count' in named[0], false);
      console.log(JSON.stringify({ syntheticRows: 100000, requestsPerMode: 12, fullCountQueries: 12,
        lightCountQueries: 0, fullMs, lightMs, connectionStateFresh: true }));
    } finally { await db.$disconnect(); }
  });
