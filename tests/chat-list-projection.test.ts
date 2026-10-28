import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { Prisma } from '@prisma/client';
import pg from 'pg';
import ts from 'typescript';

function subject(source = fs.readFileSync('src/api/services/channel.service.ts', 'utf8')) {
  const ast = ts.createSourceFile('channel.ts', source, ts.ScriptTarget.Latest, true);
  const klass = ast.statements.find(ts.isClassDeclaration)!;
  const methods = ['fetchChats', 'cleanMessageData'].map(name =>
    klass.members.find(member => member.name?.getText(ast) === name)!.getText(ast)).join('\n');
  const context = { module: { exports: undefined as any }, Prisma, isArray: Array.isArray,
    createJid: (value: string) => `${value}@s.whatsapp.net` };
  vm.runInNewContext(ts.transpileModule(`module.exports = class { ${methods} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  const instance = new context.module.exports();
  instance.instanceId = 'synthetic-A';
  return instance;
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('chat list keeps scope, parameter binding, timestamp range and pagination', async () => {
  const instance = subject();
  const calls: Prisma.Sql[] = [];
  instance.prismaRepository = { $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(Prisma.sql(strings, ...values));
    return [];
  } };
  assert.deepEqual(plain(await instance.fetchChats({ where: { remoteJid: "peer'@g.us",
    messageTimestamp: { gte: '2026-01-01', lte: '2026-01-02' } }, take: 10, skip: 20 })), []);
  const query = calls[0];
  assert(!query.text.includes("peer'@g.us"));
  assert.deepEqual(query.values, ['synthetic-A', "peer'@g.us", 1767225600, 1767312000, 10, 20]);
});

const databaseUrl = process.env.EVO_CHAT_LIST_SYNTHETIC_URL;
test('real PostgreSQL preserves chat selection and payloads while reducing history before hydration',
  { skip: !databaseUrl }, async () => {
    const url = new URL(databaseUrl!);
    assert.equal(url.hostname, 'postgres');
    assert.equal(url.pathname, '/postgres');
    const database = new pg.Client({ connectionString: databaseUrl });
    await database.connect();
    try {
      await database.query(`CREATE TEMP TABLE "Message" (
        id text PRIMARY KEY, "instanceId" text, key jsonb, "messageTimestamp" integer,
        "pushName" text, participant text, "messageType" text, message jsonb, "contextInfo" jsonb,
        source text, "sessionId" text, status text);
        CREATE TEMP TABLE "Contact" (id text, "instanceId" text, "remoteJid" text, "pushName" text,
        "profilePicUrl" text, "updatedAt" timestamp, UNIQUE("instanceId","remoteJid"));
        CREATE TEMP TABLE "Chat" ("instanceId" text, "remoteJid" text, name text, "createdAt" timestamp,
        "unreadMessages" integer, UNIQUE("instanceId","remoteJid"));`);
      const entries = [
        ['old', 'synthetic-A', '100@s.whatsapp.net', 100, false],
        ['new', 'synthetic-A', '100@s.whatsapp.net', 200, true],
        ['foreign', 'synthetic-B', '100@s.whatsapp.net', 300, false],
        ['group', 'synthetic-A', '200@g.us', 150, false],
        ['missing-chat', 'synthetic-A', '300@s.whatsapp.net', 120, false],
      ];
      for (const [id, owner, peer, timestamp, fromMe] of entries) {
        await database.query(`INSERT INTO "Message" VALUES($1,$2,$3,$4,'Synthetic sender','participant','conversation',
          '{"conversation":"Synthetic body","mediaUrl":"local"}','{}','web',null,'READ')`,
        [id, owner, JSON.stringify({ remoteJid: peer, fromMe }), timestamp]);
      }
      await database.query(`INSERT INTO "Contact" VALUES
        ('contact-A','synthetic-A','100@s.whatsapp.net','Saved name',null,now()),
        ('contact-B','synthetic-B','100@s.whatsapp.net','Foreign name',null,now()),
        ('no-message','synthetic-A','400@s.whatsapp.net','No history',null,now());
        INSERT INTO "Chat" VALUES('synthetic-A','100@s.whatsapp.net','Direct',now(),3),
        ('synthetic-A','200@g.us','Group',now(),5),('synthetic-B','100@s.whatsapp.net','Foreign',now(),9);`);
      const instance = subject();
      const statements: Prisma.Sql[] = [];
      instance.prismaRepository = { $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = Prisma.sql(strings, ...values);
        statements.push(query);
        return (await database.query(query.text, query.values)).rows;
      } };
      const result = plain(await instance.fetchChats({}));
      assert.deepEqual(result.map((row: any) => row.lastMessage.id), ['new', 'group', 'missing-chat']);
      assert.equal(result[0].lastMessage.pushName, 'Você');
      assert.equal(result[0].unreadCount, 3);
      assert.equal(result[1].pushName, 'Group');
      assert.equal(result[1].isSaved, false);
      assert.equal(result[2].id, null);
      assert.deepEqual(plain(await instance.fetchChats({ take: 1, skip: 1 })), [result[1]]);
      assert.deepEqual(plain(await instance.fetchChats({ where: { remoteJid: '100' } })), [result[0]]);
      const historical = plain(await instance.fetchChats({ where: { remoteJid: '100',
        messageTimestamp: { gte: new Date(90_000), lte: new Date(110_000) } } }));
      assert.equal(historical[0].lastMessage.id, 'old');
      assert.equal(historical[0].lastMessage.instanceId, 'synthetic-A');
      assert.equal(statements.length, 4);
      if (process.env.EVO_CHAT_LIST_BENCHMARK === '1') {
        await database.query('TRUNCATE pg_temp."Message", pg_temp."Chat", pg_temp."Contact"');
        await database.query(`INSERT INTO "Contact" SELECT 'contact-'||g,'synthetic-A',g||'@s.whatsapp.net',
          'Synthetic',null,now() FROM generate_series(0,999) g;
          INSERT INTO "Chat" SELECT 'synthetic-A',g||'@s.whatsapp.net','Synthetic',now(),1 FROM generate_series(0,999) g;`);
        for (let offset = 0; offset < 100000; offset += 1000) {
          await database.query(`INSERT INTO "Message" SELECT 'message-'||g, 'synthetic-A',
            jsonb_build_object('remoteJid',(g%1000)||'@s.whatsapp.net','fromMe',false),g,
            'Synthetic',null,'conversation',jsonb_build_object('conversation',repeat(md5(g::text),100)),
            '{}','web',null,'READ' FROM generate_series($1::int,$2::int) g`, [offset + 1, offset + 1000]);
        }
        await database.query('ANALYZE pg_temp."Message"; ANALYZE pg_temp."Contact"; ANALYZE pg_temp."Chat"');
        const baseline = subject(fs.readFileSync(process.env.EVO_CHAT_LIST_BASELINE_SOURCE!, 'utf8'));
        baseline.prismaRepository = instance.prismaRepository;
        const timings: Record<string, number[]> = { baseline: [], candidate: [] };
        for (let sample = 0; sample < 4; sample++) {
          const outputs: unknown[] = [];
          for (const [name, reader] of [['baseline', baseline], ['candidate', instance]] as const) {
            const start = performance.now();
            outputs.push(plain(await reader.fetchChats({ take: 20 })));
            timings[name].push(Number((performance.now() - start).toFixed(2)));
          }
          assert.deepEqual(outputs[1], outputs[0]);
        }
        const plans = [];
        for (const query of statements.slice(-2)) {
          const plan = await database.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query.text, query.values);
          plans.push(plan.rows[0]['QUERY PLAN']);
        }
        if (process.env.EVO_CHAT_LIST_PLAN_PATH) fs.writeFileSync(process.env.EVO_CHAT_LIST_PLAN_PATH, JSON.stringify(plans));
        console.log('EVO_CHAT_LIST_PERFORMANCE ' + JSON.stringify({ chats: 1000, messages: 100000, timings }));
      }
    } finally {
      await database.end(); // Session-local tables disappear, including on assertion failure.
    }
  });
