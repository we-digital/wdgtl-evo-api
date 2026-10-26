import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = 'src/api/integrations/';
function load(source: string, imports: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const context = { exports, module: { exports }, require: (name: string) => {
    assert(name in imports, `Unexpected module ${name}`);
    return imports[name];
  }, ...extras };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, context);
  return exports;
}
const poolSource = fs.readFileSync(root + 'chatbot/chatwoot/libs/postgres.client.ts', 'utf8');
function wrapper(Pool: unknown, uri = 'postgresql://synthetic') {
  const errors: string[] = [];
  const exports = load(poolSource, {
    pg: { Pool },
    '@config/env.config': { configService: { get: () => ({ IMPORT: { DATABASE: { CONNECTION: { URI: uri } } } }) } },
    '@config/logger.config': { Logger: class { error(value: string) { errors.push(value); } } },
  });
  return { client: exports.postgresClient, errors };
}

test('idle PostgreSQL failures retain one shared pool and initialize replacement clients', async () => {
  const pools: FakePool[] = [];
  class FakePool extends EventEmitter {
    constructor(public options: any) { super(); pools.push(this); }
  }
  const { client, errors } = wrapper(FakePool);
  const held = client.getChatwootConnection();
  for (let i = 0; i < 20; i++) {
    held.emit('error', new Error('synthetic idle connection failure'));
    assert.equal(client.getChatwootConnection(), held);
  }
  assert.equal(pools.length, 1);
  assert.equal(errors.length, 20);
  assert.equal(held.options.connectionString, 'postgresql://synthetic');
  assert.equal(held.options.ssl.rejectUnauthorized, false);
  const initialized: string[] = [];
  for (let i = 0; i < 3; i++) held.emit('connect', { query: async (sql: string) => initialized.push(sql) });
  await Promise.resolve();
  assert.deepEqual(initialized, Array(3).fill('SET search_path TO public'));
  assert((await Promise.all(Array.from({ length: 30 }, () => client.getChatwootConnection()))).every(p => p === held));
});

const baileysSource = fs.readFileSync(root + 'channel/whatsapp/whatsapp.baileys.service.ts', 'utf8');
function unreadMethod() {
  const ast = ts.createSourceFile('channel.ts', baileysSource, ts.ScriptTarget.Latest, true);
  const klass = ast.statements.find(ts.isClassDeclaration)!;
  const method = klass.members.find(m => m.name?.getText(ast) === 'updateChatUnreadMessages')!.getText(ast);
  return load(`export class Subject { ${method} }`, {}, { status: { 3: 'DELIVERY_ACK' } }).Subject;
}
for (const peer of ['synthetic@s.whatsapp.net', '120363000000000000@g.us']) {
  test(`unread bookkeeping updates only the exact instance/peer owner: ${peer}`, async () => {
    const Subject = unreadMethod();
    const instance = new Subject(); instance.instanceId = 'instance-B';
    const chats = [{ id: 'chat-A', instanceId: 'instance-A', remoteJid: peer, unreadMessages: 9 },
      { id: 'chat-B', instanceId: 'instance-B', remoteJid: peer, unreadMessages: 0 }];
    const updates: any[] = [];
    instance.prismaRepository = {
      chat: {
        findUnique: async ({ where }: any) => chats.find(x => x.instanceId === where.instanceId_remoteJid.instanceId && x.remoteJid === where.instanceId_remoteJid.remoteJid),
        findFirst: async () => chats[0], // Reproduces the old incorrect cross-instance selection.
        update: async (args: any) => { updates.push(args); chats.find(x => x.id === args.where.id)!.unreadMessages = args.data.unreadMessages; },
      },
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        assert.deepEqual(values, ['instance-B', peer, 'DELIVERY_ACK']);
        return [{ count: 3 }];
      },
    };
    assert.equal(await instance.updateChatUnreadMessages(peer), 3);
    assert.equal(chats[0].unreadMessages, 9);
    assert.equal(chats[1].unreadMessages, 3);
    assert.equal(updates.length, 1);
    await instance.updateChatUnreadMessages(peer);
    assert.equal(updates.length, 1, 'unchanged counter must not cause another write');
    instance.instanceId = 'missing';
    instance.prismaRepository.$queryRaw = async () => [{ count: 0 }];
    assert.equal(await instance.updateChatUnreadMessages(peer), 0);
    assert.equal(updates.length, 1, 'missing owned chat must not update another instance');
  });
}

const loggerSource = fs.readFileSync('src/config/logger.config.ts', 'utf8');
function logger(levels: string[]) {
  const output: unknown[][] = [];
  const configService = { get: () => ({ LEVEL: levels, COLOR: false }) };
  const { Logger } = load(loggerSource, {
    dayjs: () => ({ toDate: () => new Date(0) }),
    fs: { readFileSync: () => '{"version":"synthetic"}' },
    './env.config': { configService },
  }, { console: { log: (...args: unknown[]) => output.push(args) }, process: { pid: 1 } });
  return { logger: new Logger('synthetic'), output };
}
test('disabled diagnostics never evaluate serialization; enabled diagnostics and ordinary values retain output', () => {
  const { logger: quiet, output } = logger(['INFO']);
  let calls = 0;
  const expensive = () => { calls++; return 'formatted synthetic'; };
  quiet.verbose(expensive); quiet.debug(expensive);
  assert.equal(calls, 0); assert.equal(output.length, 0);
  quiet.info(expensive); assert.equal(calls, 1);
  assert.equal(output[0].at(-1), 'formatted synthetic');
  const { logger: enabled, output: enabledOutput } = logger(['DEBUG', 'VERBOSE', 'INFO']);
  enabled.debug(expensive); enabled.verbose(expensive);
  assert.equal(calls, 3);
  const object = { unchanged: true }; enabled.info(object);
  assert.equal(enabledOutput[2].at(-1), object);
});

test('per-message INFO metadata is bounded and never serializes native body/media', () => {
  const source = fs.readFileSync(root + 'chatbot/chatwoot/services/chatwoot.service.ts', 'utf8');
  const ast = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  let statement: string | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'this.logger.info' && node.getText(ast).includes("event: 'chatwoot_message_received'")) statement = node.getText(ast);
    ts.forEachChild(node, walk);
  };
  walk(ast); assert(statement);
  const logs: string[] = [];
  const body = { key: { id: 'X'.repeat(10000), fromMe: false }, messageType: 'Y'.repeat(10000),
    message: { imageMessage: { jpegThumbnail: 'sensitive'.repeat(100000) } },
    toJSON() { throw new Error('Native payload serialization is forbidden'); } };
  const before = body.message.imageMessage.jpegThumbnail;
  vm.runInNewContext(`(function(){${statement}}).call(subject)`, {
    subject: { logger: { info: (text: string) => logs.push(text) } }, body,
    event: 'messages.upsert', instance: { instanceId: 'synthetic' },
  });
  assert.equal(logs.length, 1); assert(logs[0].length < 400);
  assert.equal(JSON.parse(logs[0]).messageId.length, 100);
  assert.equal(JSON.parse(logs[0]).messageType.length, 64);
  assert(!logs[0].includes('sensitive')); assert.equal(body.message.imageMessage.jpegThumbnail, before);
});

const syntheticPool = process.env.POOL_LIFECYCLE_SYNTHETIC === '1';
test('real isolated PostgreSQL replaces a terminated idle client without replacing its shared pool', { skip: !syntheticPool }, async () => {
  const uri = process.env.POOL_LIFECYCLE_URL!;
  const url = new URL(uri);
  assert.equal(url.hostname, 'postgres'); assert.equal(url.pathname, '/synthetic');
  assert.equal(url.searchParams.get('sslmode'), 'disable');
  const pg = await import('pg');
  const { client } = wrapper(pg.default.Pool, uri);
  const pool = client.getChatwootConnection();
  const admin = new pg.default.Client({ connectionString: uri });
  try {
    await admin.connect();
    const first = await pool.query('SELECT pg_backend_pid() AS pid,current_schema() AS schema');
    assert.equal(first.rows[0].schema, 'public');
    const failed = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Idle-client error not observed')), 5000);
      pool.once('error', () => { clearTimeout(deadline); resolve(); });
    });
    await admin.query('SELECT pg_terminate_backend($1)', [first.rows[0].pid]);
    await failed;
    assert.equal(client.getChatwootConnection(), pool);
    const replacement = await pool.query('SELECT pg_backend_pid() AS pid,current_schema() AS schema');
    assert.notEqual(replacement.rows[0].pid, first.rows[0].pid);
    assert.equal(replacement.rows[0].schema, 'public');
    assert.equal(pool.totalCount, 1);
  } finally { await pool.end(); await admin.end(); }
});

test('real PostgreSQL preserves read boundaries and instance ownership for direct and group peers', { skip: !syntheticPool }, async () => {
  const uri = process.env.POOL_LIFECYCLE_URL!;
  const url = new URL(uri); assert.equal(url.hostname, 'postgres'); assert.equal(url.pathname, '/synthetic');
  const pg = await import('pg');
  const { PrismaClient } = await import('@prisma/client');
  const admin = new pg.default.Client({ connectionString: uri });
  const db = new PrismaClient({ datasourceUrl: uri });
  await admin.connect();
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename IN ('Chat','Message')")).rows[0].n, 0);
  try {
    await admin.query(`CREATE TABLE "Chat" (id text PRIMARY KEY, "instanceId" text NOT NULL, "remoteJid" varchar(100) NOT NULL,
      name varchar(100), labels jsonb, "createdAt" timestamp DEFAULT now(), "updatedAt" timestamp DEFAULT now(),
      "unreadMessages" integer NOT NULL DEFAULT 0, UNIQUE("instanceId","remoteJid"));
      CREATE TABLE "Message" (id text PRIMARY KEY,"instanceId" text NOT NULL,key jsonb,"messageTimestamp" integer,status varchar(30));`);
    const ast = ts.createSourceFile('channel.ts', baileysSource, ts.ScriptTarget.Latest, true);
    const klass = ast.statements.find(ts.isClassDeclaration)!;
    const methods = ['updateChatUnreadMessages', 'updateMessagesReadedByTimestamp'].map(name =>
      klass.members.find(m => m.name?.getText(ast) === name)!.getText(ast)).join('\n');
    const Subject = load(`export class Subject {${methods}}`, {}, { status: { 3: 'DELIVERY_ACK', 4: 'READ' } }).Subject;
    for (const [peerNumber, peer] of ['synthetic@s.whatsapp.net', '120363000000000000@g.us'].entries()) {
      const prefix = String(peerNumber);
      await admin.query('INSERT INTO "Chat" (id,"instanceId","remoteJid","unreadMessages") VALUES($1,$2,$3,9),($4,$5,$3,0)', [prefix+'A','A',peer,prefix+'B','B']);
      const rows = [
        ['null','B',false,10,null], ['boundary','B',false,20,'DELIVERY_ACK'], ['read','B',false,15,'READ'],
        ['outgoing','B',true,10,'DELIVERY_ACK'], ['future','B',false,21,'DELIVERY_ACK'], ['foreign','A',false,10,'DELIVERY_ACK'],
      ];
      for (const [id, instanceId, fromMe, timestamp, state] of rows) await admin.query(
        'INSERT INTO "Message" (id,"instanceId",key,"messageTimestamp",status) VALUES($1,$2,$3::jsonb,$4,$5)',
        [prefix+id, instanceId, JSON.stringify({ remoteJid: peer, fromMe }), timestamp, state]);
      const subject = new Subject(); subject.instanceId = 'B'; subject.prismaRepository = db;
      const refreshed: Promise<number>[] = [];
      const refresh = subject.updateChatUnreadMessages.bind(subject);
      subject.updateChatUnreadMessages = (jid: string) => { const promise = refresh(jid); refreshed.push(promise); return promise; };
      const forwards: unknown[] = [];
      subject.forwardChatwootOwnerRead = async (...args: unknown[]) => { forwards.push(args); };
      assert.equal(await refresh(peer), 2);
      assert.equal(await subject.updateMessagesReadedByTimestamp(peer, undefined), 0);
      assert.equal(await subject.updateMessagesReadedByTimestamp(peer, 20), 2);
      await Promise.all(refreshed);
      const states = (await admin.query('SELECT id,status FROM "Message" WHERE id LIKE $1 ORDER BY id',[prefix+'%'])).rows;
      assert.deepEqual(states.filter(x => x.status === 'READ').map(x => x.id).sort(), [prefix+'null',prefix+'boundary',prefix+'read'].sort());
      assert.equal(await refresh(peer), 1);
      const chats = (await admin.query('SELECT "instanceId","unreadMessages" FROM "Chat" WHERE "remoteJid"=$1 ORDER BY "instanceId"',[peer])).rows;
      assert.deepEqual(chats, [{ instanceId:'A',unreadMessages:9 },{ instanceId:'B',unreadMessages:1 }]);
      assert.equal(forwards.length, 1);
    }
  } finally { await db.$disconnect(); await admin.query('DROP TABLE IF EXISTS "Message","Chat"'); await admin.end(); }
});
