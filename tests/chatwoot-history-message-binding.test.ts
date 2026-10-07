import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileHistoryMessageBinding } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-message-binding';

const peer = '120363000000001@g.us';
const native = () => ({
  id: 'native-1', instanceId: 'instance-1', key: { id: 'SOURCE1', remoteJid: peer, fromMe: false },
  message: { conversation: 'Synthetic history' }, messageType: 'conversation', messageTimestamp: 1700000000,
  status: 'READ', chatwootMessageId: null, chatwootInboxId: null, chatwootConversationId: null,
  chatwootContactInboxSourceId: null, chatwootIsRead: null,
});
const destination = () => ({
  conversation_id: 900, source_id: 'WAID:SOURCE1', message_type: 0, private: false,
});
function fixture(options: { row?: any; target?: any; aliases?: any[]; canonical?: any; nativeRows?: any[]; boundPeer?: string } = {}) {
  const expected = native();
  const row = options.row || structuredClone(expected);
  const events: string[] = [];
  const writes: any[] = [];
  const target = options.target || destination();
  const canonical = options.canonical || { id: 900, display_id: 37, inbox_id: 42, source_id: 'ci-source' };
  const aliases = options.aliases || [{ id: 101 }];
  const client = {
    query: async (sql: string, values?: any[]) => {
      events.push(sql);
      if (sql.startsWith('SELECT conversation_id')) {
        assert.deepEqual(values, [101, 1, 42]);
        return { rows: [target] };
      }
      if (sql.startsWith('SELECT public.provider_message_conversation_route')) {
        assert.deepEqual(values, [1, 42, 900]);
        return { rows: [{ id: 900 }] };
      }
      if (sql.startsWith('SELECT id FROM messages')) return { rows: aliases };
      if (sql.startsWith('SELECT c.id')) return { rows: [canonical] };
      if (sql.includes('SELECT b.peer')) return { rows: [{ peer: options.boundPeer || peer }] };
      return { rows: [] };
    },
    release: () => events.push('release'),
  };
  const pool = {
    query: async (_sql: string, values: any[]) => {
      assert.deepEqual(values, [1, 42, ['SOURCE1', 'WAID:SOURCE1']]);
      return { rows: aliases };
    },
    connect: async () => client,
  };
  const prisma = {
    $transaction: async (work: any) => work({
      $queryRaw: async (sql: any) => {
        events.push('native-lock');
        assert.match(sql.text, /FOR UPDATE/);
        assert.deepEqual(sql.values, ['instance-1', 'SOURCE1']);
        return options.nativeRows || [row];
      },
      message: { updateMany: async (data: any) => {
        events.push('native-write');
        writes.push(data);
        return { count: data.where.id.in.length };
      } },
    }),
  };
  const run = (dryRun = false, source: any = expected) => reconcileHistoryMessageBinding(pool as any, prisma as any, source, 1, 42, dryRun);
  return { run, row, expected, writes, events };
}

test('binds exact native ID under canonical peer lock, using display_id and leaving payload/read/status untouched', async () => {
  const f = fixture();
  const before = structuredClone(f.row);
  assert.deepEqual(await f.run(), { sourceId: 'WAID:SOURCE1', status: 'bound', messageId: 101, conversationId: 37, nativeRows: 1, boundRows: 1 });
  assert.deepEqual(f.writes, [{ where: { id: { in: ['native-1'] }, instanceId: 'instance-1' }, data: {
    chatwootMessageId: 101, chatwootInboxId: 42, chatwootConversationId: 37, chatwootContactInboxSourceId: 'ci-source',
  } }]);
  assert.deepEqual(f.row, before);
  assert.ok(f.events.findIndex((sql) => sql.includes('provider_message_conversation_route')) < f.events.indexOf('native-write'));
  assert.ok(f.events.indexOf('native-write') < f.events.indexOf('COMMIT'));
});

test('dry run qualifies real scoped destination and locks source without writing', async () => {
  const f = fixture();
  assert.equal((await f.run(true)).status, 'would_bind');
  assert.equal(f.writes.length, 0);
});

test('exact existing pointers are idempotent; delivery-only native status change is harmless', async () => {
  const row = { ...native(), status: 'DELIVERY_ACK', chatwootMessageId: 101, chatwootInboxId: 42,
    chatwootConversationId: 37, chatwootContactInboxSourceId: 'ci-source' };
  const f = fixture({ row });
  assert.equal((await f.run()).status, 'existing');
  assert.equal(f.writes.length, 0);
});

for (const field of ['chatwootMessageId', 'chatwootInboxId', 'chatwootConversationId', 'chatwootContactInboxSourceId']) {
  test(`refuses a conflicting ${field}, including dry run, without overwriting it`, async () => {
    const f = fixture({ row: { ...native(), [field]: field.endsWith('SourceId') ? 'foreign' : 999 } });
    await assert.rejects(f.run(true), /conflicting native pointers/);
    assert.equal(f.writes.length, 0);
    assert.ok(f.events.includes('ROLLBACK'));
  });
}
for (const [label, options] of [
  ['wrong direction', { target: { ...destination(), message_type: 1 } }],
  ['private destination', { target: { ...destination(), private: true } }],
  ['wrong source', { target: { ...destination(), source_id: 'WAID:FOREIGN' } }],
  ['missing alias', { aliases: [] }],
  ['duplicate raw/WAID alias', { aliases: [{ id: 101 }, { id: 102 }] }],
  ['wrong canonical peer', { boundPeer: '120363999999999@g.us' }],
  ['divergent duplicate native key', { nativeRows: [native(), { ...native(), id: 'native-2', message: { conversation: 'Different source' } }] }],
  ['foreign native instance', { row: { ...native(), instanceId: 'foreign' } }],
  ['source message changed', { row: { ...native(), message: { conversation: 'Edited since admission' } } }],
] as const) {
  test(`refuses ${label} before native write`, async () => {
    const f = fixture(options);
    await assert.rejects(f.run());
    assert.equal(f.writes.length, 0);
  });
}

test('LID peer uses only exact stored PN alternative; no alias inference', async () => {
  const source = { ...native(), key: { ...native().key, remoteJid: '999999999@lid', remoteJidAlt: '14155552671@s.whatsapp.net' } };
  const f = fixture({ row: source, boundPeer: '14155552671@s.whatsapp.net' });
  assert.equal((await f.run(false, source)).status, 'bound');
  const unresolved = { ...source, key: { ...source.key, remoteJidAlt: undefined } };
  await assert.rejects(fixture({ row: unresolved, boundPeer: '14155552671@s.whatsapp.net' }).run(false, unresolved), /peer/);
});

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { Validator } from 'jsonschema';
import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { historyRecoveryDestination, matchesHistoryRecoveryDestination } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import { chatwootHistoryMappingReconcileSchema } from '../src/api/integrations/chatbot/chatwoot/validate/chatwoot.schema';

function publicConsumer(options: { changed?: any; edited?: boolean; busy?: boolean; inbox?: number; source?: any } = {}) {
  const source = { ...native(), ...options.source };
  const code = fs.readFileSync(path.resolve('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts'), 'utf8');
  const parsed = ts.createSourceFile('service.ts', code, ts.ScriptTarget.Latest, true);
  const klass = parsed.statements.find(ts.isClassDeclaration)!;
  const method = klass.members.find((member) => member.name?.getText(parsed) === 'reconcileStoredHistoryMappings')!.getText(parsed);
  const javascript = ts.transpileModule(`module.exports=class Consumer {${method}}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const calls: any[] = [];
  let releases = 0;
  const context = {
    module: { exports: undefined as any },
    BadRequestException: Error,
    tryAcquireHistoryWriter: () => options.busy ? null : () => releases++,
    matchesHistoryRecoveryDestination, historyRecoveryDestination, classifyCachedHistoryRecord,
    toChatwootSourceId: (id: string) => `WAID:${id}`,
    isDeepStrictEqual: (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b),
    postgresClient: { getChatwootConnection: () => 'synthetic-pool' },
    reconcileHistoryMessageBinding: async (...args: any[]) => {
      calls.push(args);
      return { sourceId: 'WAID:SOURCE1', status: 'would_bind' };
    },
  };
  vm.runInNewContext(javascript, context);
  const consumer = new context.module.exports();
  consumer.isImportHistoryAvailable = () => true;
  consumer.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true }) };
  consumer.getProvider = async () => ({ accountId: '1', importMessages: true, enabled: true });
  consumer.getStoredHistoryRecoveryInbox = async () => ({ id: options.inbox || 42 });
  consumer.prismaRepository = {
    message: { findMany: async (query: any) => {
      assert.equal(query.where.Instance.name, 'synthetic');
      return [{ ...source, ...options.changed }];
    } },
    messageUpdate: { findMany: async () => options.edited ? [{ messageId: source.id }] : [] },
  };
  const data = { contractVersion: '2026-10-08', dryRun: true,
    ...{ expectedDestinationKey: historyRecoveryDestination('1', 42).destinationKey, expectedInboxId: 42 },
    messages: [{ sourceId: 'WAID:SOURCE1', expectedDirection: 'incoming', message: source }] };
  return { data, calls, run: () => consumer.reconcileStoredHistoryMappings({ instanceName: 'synthetic' }, data), releases: () => releases };
}

test('actual service endpoint binds only exact ordinary current instance source, explicit destination and dry-run', async () => {
  const f = publicConsumer();
  const result = await f.run();
  assert.equal(result.selectedMessages, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][3], 1);
  assert.equal(f.calls[0][4], 42);
  assert.equal(f.calls[0][5], true);
  assert.equal(f.releases(), 1);
});

for (const [label, options] of [
  ['destination rotation', { inbox: 43 }],
  ['changed native payload', { changed: { message: { conversation: 'Latest source' } } }],
  ['unavailable NULL edit record', { edited: true, source: { message: null, status: 'EDITED' } }],
  ['existing active history writer', { busy: true }],
] as const) {
  test(`actual endpoint rejects ${label} without entering mapping`, async () => {
    const f = publicConsumer(options);
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 0);
    assert.equal(f.releases(), options.busy ? 0 : 1);
  });
}

test('public schema bounds250 and requires explicit dryRun and all source-version fields', () => {
  const data = publicConsumer().data;
  const validator = new Validator();
  assert.equal(validator.validate(data, chatwootHistoryMappingReconcileSchema).valid, true);
  for (const field of ['dryRun', 'expectedInboxId']) {
    const copy = structuredClone(data);
    delete copy[field];
    assert.equal(validator.validate(copy, chatwootHistoryMappingReconcileSchema).valid, false);
  }
  const oversized = { ...data, messages: Array(251).fill(data.messages[0]) };
  assert.equal(validator.validate(oversized, chatwootHistoryMappingReconcileSchema).valid, false);
  const missingVersion = structuredClone(data);
  delete missingVersion.messages[0].message.messageTimestamp;
  assert.equal(validator.validate(missingVersion, chatwootHistoryMappingReconcileSchema).valid, false);
});


test('exact duplicate native copies bind together; every pointer must be null or exact and critical payloads equal', async () => {
  const rows = [native(), { ...native(), id: 'native-2', status: 'DELIVERY_ACK' }];
  const f = fixture({ nativeRows: rows });
  const result = await f.run();
  assert.equal(result.nativeRows, 2);
  assert.equal(result.boundRows, 2);
  assert.deepEqual(f.writes[0].where.id.in, ['native-1', 'native-2']);
  await assert.rejects(fixture({ nativeRows: [rows[0], { ...rows[1], chatwootInboxId: 99 }] }).run(), /conflicting/);
});
