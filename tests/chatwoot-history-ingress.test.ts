import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import ts from 'typescript';

import { persistHistoryIngress } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-ingress';
import { ChatwootInboundPrismaStore } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-prisma-store';
import { inboundDeliveryId, inboundPayloadHash } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';

function source(index = 0) {
  return { instanceId: 'history-synthetic', key: { id: `source-${index}`, remoteJid: '10000000001@s.whatsapp.net', fromMe: false },
    message: { conversation: `Synthetic ${index}` }, messageType: 'conversation', source: 'web', messageTimestamp: 1793340000 + index };
}
function intent(body: any): any {
  return { id: inboundDeliveryId(body.instanceId, body), instanceId: body.instanceId, instanceName: 'synthetic',
    providerId: 'synthetic', providerFingerprint: 'a'.repeat(64), accountId: 1, inboxId: null,
    peer: body.key.remoteJid, sourceId: `WAID:${body.key.id}`, fromMe: false, payload: body,
    payloadHash: inboundPayloadHash(body), state: 'history_pending', attempts: 0, nextAttemptAt: new Date(),
    leaseOwner: null, leaseExpiresAt: null };
}

test('received batches use bounded atomic writes; replay preserves live ownership and confirmed receipts', async () => {
  let native: any[] = [], queued: any[] = [];
  let fail = false;
  const sizes: number[] = [];
  const repository = { $transaction: async (run: any) => {
    const n = structuredClone(native), q = structuredClone(queued);
    const result = await run({
      message: {
        findMany: async ({ where }: any) => {
          assert.equal(where.instanceId, 'history-synthetic');
          assert.ok(where.OR.length <= 50);
          return n.filter(row => where.OR.some((term: any) => term.AND.every((q: any) => row.key[q.key.path[0]] === q.key.equals)));
        },
        createMany: async ({ data }: any) => { sizes.push(data.length); n.push(...structuredClone(data)); },
      },
      chatwootInboundDelivery: { createMany: async ({ data }: any) => {
        if (fail) throw new Error('synthetic ledger failure');
        for (const row of data) if (!q.some(existing => existing.id === row.id)) q.push(structuredClone(row));
      } },
    });
    native = n; queued = q; return result;
  } };
  const input = Array.from({length: 121}, (_, i) => source(i));
  queued.push({...intent(input[0]), state:'confirmed', attempts:3});
  assert.equal((await persistHistoryIngress(repository, 'history-synthetic', input, intent)).length, 121);
  assert.deepEqual(sizes, [50, 50, 21]);
  assert.equal(queued.length, 121);
  assert.equal(queued[0].state, 'confirmed');
  assert.equal(queued[0].attempts, 3);
  assert.equal((await persistHistoryIngress(repository, 'history-synthetic', input, intent)).length, 0);
  fail = true;
  await assert.rejects(persistHistoryIngress(repository, 'history-synthetic', [source(122)], intent), /ledger failure/);
  assert.equal(native.length, 121); assert.equal(queued.length, 121);
  fail=false;
  const shared=[source(200),{...source(200),key:{...source(200).key,remoteJid:'10000000002@s.whatsapp.net'}},{...source(200),key:{...source(200).key,fromMe:true}}];
  assert.equal((await persistHistoryIngress(repository,'history-synthetic',shared,intent)).length,3);
  assert.equal((await persistHistoryIngress(repository,'history-synthetic',shared,intent)).length,0);

});

test('indexed due lanes reserve history progress without increasing eight-row fetch or two-writer contract', async () => {
  const calls: any[] = [];
  const store = new ChatwootInboundPrismaStore({chatwootInboundDelivery:{findMany:async (args:any) => {
    calls.push(args); return args.where.state === 'pending' ? [{id:'live-a'},{id:'live-b'}] : [{id:'history'}];
  }}} as any);
  assert.deepEqual((await store.due(new Date(),8)).map(row=>row.id),['live-a','history','live-b']);
  assert.deepEqual(calls.map(call=>call.take),[7,1]);
  assert.ok(calls.every(call=>call.where.nextAttemptAt && call.where.OR && call.orderBy));
});

const text = fs.readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts','utf8');
const ast = ts.createSourceFile('service.ts',text,ts.ScriptTarget.Latest,true);
const callbacks: Record<string,string> = {};
function visit(node:ts.Node) {
  if(ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && ['messages.upsert','messaging-history.set'].includes(node.name.text))
    callbacks[node.name.text] = node.initializer.getText(ast);
  ts.forEachChild(node,visit);
}
visit(ast);
function callback(name:string, context:any, extra:any={}) {
  const bindings = {Long:{isLong:()=>false},proto:{Message:{ProtocolMessage:{Type:{MESSAGE_EDIT:14}}},HistorySync:{HistorySyncType:{ON_DEMAND:6}}},Events:{MESSAGES_SET:'messages.set'},console:{log(){}},...extra};
  const code = ts.transpileModule(`const handler=${callbacks[name]}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  return new Function(...Object.keys(bindings),code+';return handler').call(context,...Object.values(bindings));
}
function receiver() {
  const calls={saved:0,edits:0,errors:0,events:[] as string[]};
  const context:any={
    instance:{name:'synthetic'},instanceId:'history-synthetic',localChatwoot:{enabled:true,importMessages:true,daysLimitImportMessages:30},
    configService:{get:(key:string)=>key==='CHATWOOT'?{ENABLED:true}:{SAVE_DATA:{HISTORIC:true,CHATS:true}}},
    prismaRepository:{chat:{findMany:async()=>[],createMany:async()=>{},findFirst:async()=>null}},
    baileysCache:{set:async()=>{}},prepareMessage:(message:any)=>({...message,instanceId:'history-synthetic'}),
    chatwootService:{persistReceivedHistory:async (_instance:any,messages:any[])=>{calls.saved+=messages.length;return messages}},
    sendDataWebhook:(event:string)=>calls.events.push(event),completeHistorySyncBootstrap:async()=>{},
    contactHandle:{'contacts.upsert':async()=>{}},
    applyNativeWhatsappEdit:async()=>{calls.edits++;throw new Error('synthetic bad edit')},
    logger:{error:()=>{calls.errors++},info(){}},
  };
  return {calls,context};
}
for(const syncType of [0,2,3,6]) test(`native history type ${syncType} reaches durable ingress with managed history enabled`,async()=>{
  const f=receiver();f.context.isManagedHistoryReconciliation=()=>true;
  await callback('messaging-history.set',f.context)({messages:[{...source(),pushName:'Synthetic',messageTimestamp:Math.floor(Date.now()/1000)}],chats:[],contacts:[],syncType,isLatest:true},{});
  assert.equal(f.calls.saved,1);assert.equal(f.calls.errors,0);
});
test('non-edit protocol is not an edit; malformed actual edit does not abort the following append',async()=>{
  const f=receiver();const handler=callback('messages.upsert',f.context);
  await handler({type:'append',messages:[
    {key:{id:'control'},message:{protocolMessage:{type:5}}},
    {key:{id:'bad-edit'},message:{protocolMessage:{type:14}}},
    source(),
  ]},{});
  assert.equal(f.calls.edits,1);assert.equal(f.calls.errors,1);assert.equal(f.calls.saved,1);
  assert.deepEqual(f.calls.events,['messages.set']);
});

test('real PostgreSQL/Prisma source+intent rollback, restart, replay, and history claim/ACK',
  {skip:process.env.BBC_HISTORY_INGRESS_SYNTHETIC_PG !== '1'},async()=>{
    const uri=new URL(process.env.DATABASE_CONNECTION_URI!);
    assert.ok(['postgres','localhost','127.0.0.1'].includes(uri.hostname));
    const schema=`history_ingress_${process.pid}`;
    const client=new pg.Client({connectionString:uri.toString()});await client.connect();
    let prisma:PrismaClient|undefined;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      for(const table of ['Message','ChatwootInboundDelivery'])
        await client.query(`CREATE TABLE ${schema}."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      await client.query(`CREATE TYPE ${schema}."DeviceMessage" AS ENUM ('ios','android','web','unknown','desktop')`);
      await client.query(`ALTER TABLE ${schema}."Message" ALTER COLUMN source TYPE ${schema}."DeviceMessage" USING source::text::${schema}."DeviceMessage"`);
      uri.searchParams.set('schema',schema);prisma=new PrismaClient({datasourceUrl:uri.toString()});
      await assert.rejects(persistHistoryIngress(prisma,'history-synthetic',[source()],()=>{throw new Error('after source write')}),/after source write/);
      assert.equal(await prisma.message.count(),0);
      await persistHistoryIngress(prisma,'history-synthetic',[source()],intent);
      await prisma.$disconnect();prisma=new PrismaClient({datasourceUrl:uri.toString()});
      await persistHistoryIngress(prisma,'history-synthetic',[source()],intent);
      assert.equal(await prisma.message.count(),1);
      const store=new ChatwootInboundPrismaStore(prisma as any);
      const rows=await store.due(new Date(),8);assert.equal(rows.length,1);
      const now=new Date();assert.equal(await store.claim(rows[0].id,'synthetic-owner',now,new Date(+now+60000)),true);
      assert.equal(await store.bindInbox(rows[0].id,'synthetic-owner',42),true);
      assert.equal(await store.finish(rows[0].id,'synthetic-owner',{id:1,inbox_id:42,conversation_id:9}),true);
      await persistHistoryIngress(prisma,'history-synthetic',[source()],intent);
      assert.equal((await store.due(new Date(),8)).length,0);
    } finally {await prisma?.$disconnect();await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await client.end();}
  });

for (const importEnabled of [true,false]) test(`append retains native S3 bytes without live delivery (import=${importEnabled})`,async()=>{
  const f=receiver();let uploaded=0, retained=0, updated=0;
  const message={...source(),messageType:'imageMessage',message:{imageMessage:{url:'synthetic'}}};
  f.context.localChatwoot.enabled=importEnabled;
  f.context.configService={get:(name:string)=>name==='S3'?{ENABLE:true,SAVE_VIDEO:true}:name==='CHATWOOT'?{ENABLED:importEnabled}:{SAVE_DATA:{HISTORIC:true,NEW_MESSAGE:true}}};
  f.context.instance.id='history-synthetic';
  f.context.prismaRepository.message={findMany:async()=>[{...message,id:'retained-source'}],update:async({where}:any)=>{assert.equal(where.id,'retained-source');updated++}};
  f.context.prismaRepository.media={findFirst:async()=>null,create:async({data}:any)=>{assert.equal(data.messageId,'retained-source');retained++}};
  f.context.hasValidMediaContent=()=>true;
  f.context.getBase64FromMediaMessage=async()=>({buffer:Buffer.from('synthetic'),mediaType:'image',fileName:'synthetic.jpg',size:{fileLength:{low:9}}});
  const klass=ast.statements.find(ts.isClassDeclaration)!;
  const method=klass.members.find(m=>m.name?.getText(ast)==='retainNativeMessageMedia')!.getText(ast);
  const code=ts.transpileModule('class C {'+method+'}; return C.prototype.retainNativeMessageMedia',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  f.context.retainNativeMessageMedia=new Function('s3Service','mimeTypes','join',code)({uploadFile:async()=>{uploaded++},getObjectUrl:async()=> 'https://synthetic.invalid/media'},{lookup:()=> 'image/jpeg'},(...parts:string[])=>parts.join('/'));
  await callback('messages.upsert',f.context)({type:'append',messages:[message]},{});
  assert.equal(f.calls.errors,0);assert.equal(f.calls.saved,1);assert.equal(uploaded,1);assert.equal(retained,1);assert.equal(updated,1);
  assert.deepEqual(f.calls.events,['messages.set']);
});
