import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { Prisma } from '@prisma/client';
import ts from 'typescript';

import * as editHelpers from '../src/api/integrations/channel/whatsapp/normalized-whatsapp-edit';
import * as timestampHelpers from '../src/api/integrations/channel/whatsapp/whatsapp-edit-restrictions';

// Exercise the literal class-field callback and private method, without opening a socket.
const file = fs.readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'utf8');
const ast = ts.createSourceFile('service.ts', file, ts.ScriptTarget.Latest, true);
let update: ts.Expression;
let apply: ts.MethodDeclaration;
let registration: ts.MethodDeclaration;
const visit = (node: ts.Node) => {
  if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text === 'messages.update')
    update = node.initializer;
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'applyNativeWhatsappEdit') apply = node;
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'eventHandler') registration = node;
  ts.forEachChild(node, visit);
};
visit(ast);
assert(update && apply && registration);
const method = apply.getText(ast).replace(/^private async applyNativeWhatsappEdit/, 'async function');
const registrationMethod = registration.getText(ast).replace(/^private eventHandler/, 'function');
const code = ts.transpileModule(
  `const update = ${update.getText(ast)}; const apply = ${method}; const registration = ${registrationMethod};`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  },
).outputText;
const bindings = {
  ...editHelpers,
  ...timestampHelpers,
  Prisma,
  createHash,
  isDeepStrictEqual,
  status: { 2: 'SERVER_ACK', 4: 'READ' },
  Events: { MESSAGES_EDITED: 'messages.edited', MESSAGES_UPDATE: 'messages.update' },
};
const factory = new Function(...Object.keys(bindings), `${code}; return {update, apply, registration};`);

function harness(fromMe = false, original: Record<string, any> = { conversation: 'before' }) {
  const key = {
    id: 'same-provider-id',
    remoteJid: '120363000000001@g.us',
    fromMe,
    participant: 'author@s.whatsapp.net',
  };
  const source: any = {
    id: 'native-original',
    instanceId: 'receiver-1',
    key,
    messageType: Object.keys(original)[0],
    message: { ...original, messageContextInfo: { messageSecret: 'retained-secret', threadId: 'original-thread' } },
    contextInfo: { originalContext: true },
    messageTimestamp: 1700000000,
    status: 'SERVER_ACK',
    chatwootMessageId: 11,
    chatwootConversationId: 22,
    chatwootInboxId: 42,
    chatwootContactInboxSourceId: 'native-contact',
    chatwootIsRead: true,
  };
  const before = structuredClone(source);
  const cache = new Map();
  const calls = { edits: [] as any[], nativeWrites: 0, audits: 0, genericUpdates: 0, reads: [] as any[] };
  let failures = 0;
  let rows = 1;
  let CAS = true;
  let ack: any = { providerEditApplied: true };
  const tx = {
    message: {
      updateMany: async ({ where, data }: any) => {
        assert.equal(where.id, source.id);
        assert.equal(where.instanceId, source.instanceId);
        assert.deepEqual(where.key.equals, source.key);
        assert.deepEqual(where.message.equals, source.message);
        assert.equal(where.messageTimestamp, source.messageTimestamp);
        if (!CAS) return { count: 0 };
        Object.assign(source, structuredClone(data));
        calls.nativeWrites++;
        return { count: 1 };
      },
    },
    messageUpdate: {
      create: async () => {
        calls.audits++;
      },
    },
  };
  const context: any = {
    instance: { id: 'receiver-1', name: 'synthetic' },
    instanceId: 'receiver-1',
    nativeEditQueue: new editHelpers.NativeWhatsappEditQueue(),
    UPDATE_CACHE_TTL_SECONDS: 1800,
    localChatwoot: { enabled: true },
    logger: { verbose() {}, info() {}, warn() {}, error() {} },
    eventProcessingQueue: Promise.resolve(),
    findSettings: async () => ({}),
    configService: { get: () => ({ ENABLED: true, SAVE_DATA: { NEW_MESSAGE: true } }) },
    baileysCache: { get: async (k: string) => cache.get(k), set: async (k: string, v: any) => cache.set(k, v) },
    prismaRepository: {
      message: {
        findMany: async ({ where }: any) => {
          calls.reads.push(where);
          const matches = (condition: any): boolean =>
            condition.OR ? condition.OR.some(matches) : key[condition.key.path[0]] === condition.key.equals;
          const exact = where.instanceId === source.instanceId && (where.id === source.id || where.AND?.every(matches));
          return exact ? Array.from({ length: rows }, () => structuredClone(source)) : [];
        },
      },
      messageUpdate: { findFirst: async () => (calls.audits ? { status: 'EDITED' } : null) },
      $transaction: async (work: any) => work(tx),
    },
    chatwootService: {
      eventWhatsapp: async (event: string, instance: any, body: any) => {
        calls.edits.push({ event, instance, body });
        if (failures-- > 0) throw new Error('synthetic lost ACK');
        return ack;
      },
    },
    sendDataWebhook: async (event: string) => {
      if (event === 'messages.update') calls.genericUpdates++;
    },
    updateChatUnreadMessages: async () => {},
  };
  const methods = factory.call(context, ...Object.values(bindings));
  context.applyNativeWhatsappEdit = methods.apply;
  const deliver = (message: any, timestamp = 1700000010, suppliedKey = key) =>
    methods.update(
      [{ key: suppliedKey, update: { message: { editedMessage: { message } }, messageTimestamp: timestamp } }],
      {},
    );
  return {
    source,
    before,
    key,
    calls,
    cache,
    deliver,
    failures: (n: number) => {
      failures = n;
    },
    rows: (n: number) => {
      rows = n;
    },
    CAS: (value: boolean) => {
      CAS = value;
    },
    registeredDeliver: async (body: any, timestamp = 1700000010) => {
      let callback: any;
      context.client = {
        ev: {
          process: (handler: any) => {
            callback = handler;
          },
        },
      };
      context.messageHandle = { 'messages.update': methods.update };
      methods.registration.call(context);
      await callback({
        'messages.update': [
          { key, update: { message: { editedMessage: { message: body } }, messageTimestamp: timestamp } },
        ],
      });
      await context.eventProcessingQueue;
    },
    disableChatwoot: () => {
      context.localChatwoot.enabled = false;
    },
    ack: (value: any) => {
      ack = value;
    },
  };
}

for (const fromMe of [false, true]) {
  test(`SDK normalized text edit updates original and dispatches once (fromMe=${fromMe})`, async () => {
    const h = harness(fromMe);
    await h.deliver({ conversation: 'after' });
    assert.equal(h.source.message.conversation, 'after');
    assert.deepEqual(h.source.message.messageContextInfo, h.before.message.messageContextInfo);
    for (const field of [
      'id',
      'instanceId',
      'key',
      'messageType',
      'messageTimestamp',
      'chatwootMessageId',
      'chatwootInboxId',
      'chatwootConversationId',
      'chatwootContactInboxSourceId',
      'chatwootIsRead',
    ])
      assert.deepEqual(h.source[field], h.before[field]);
    assert.equal(h.source.contextInfo.originalContext, true);
    assert.equal(h.source.contextInfo[timestampHelpers.ORIGINAL_WHATSAPP_TIMESTAMP], 1700000000);
    assert.equal(h.source.status, 'EDITED');
    assert.equal(h.calls.genericUpdates, 0);
    assert.equal(h.calls.edits.length, 1);
    assert.equal(h.calls.edits[0].body.key.fromMe, fromMe);
    await h.deliver({ conversation: 'after' });
    assert.equal(h.calls.edits.length, 1);
    assert.equal(h.calls.audits, 1);
  });
}

for (const type of ['imageMessage', 'videoMessage', 'documentMessage']) {
  test(`${type} empty caption preserves file, reply and native context`, async () => {
    const descriptor = {
      caption: 'before',
      mediaKey: Buffer.alloc(32, 1).toString('base64'),
      fileSha256: Buffer.alloc(32, 2).toString('base64'),
      fileLength: { low: 123, high: 0, unsigned: true },
      mimetype: 'application/octet-stream',
      contextInfo: { stanzaId: 'reply', mentionedJid: ['original'] },
    };
    const h = harness(false, { [type]: descriptor });
    await h.deliver({ [type]: { ...descriptor, caption: '' } });
    assert.deepEqual(h.source.message[type], { ...descriptor, caption: '' });
    assert.deepEqual(h.source.message.messageContextInfo, h.before.message.messageContextInfo);
    assert.equal(h.calls.edits[0].body.editedMessage[type].caption, '');
  });
}

test('text form conversion retains original extended-text reply metadata', async () => {
  const h = harness(false, { extendedTextMessage: { text: 'before', contextInfo: { stanzaId: 'reply' } } });
  await h.deliver({ conversation: 'after' });
  assert.deepEqual(h.source.message.extendedTextMessage, { text: 'after', contextInfo: { stanzaId: 'reply' } });
});

test('native 64-bit file size and SDK buffer representation retain exact authority', async () => {
  const size = { low: 1, high: 2097152, unsigned: true }; // 2^53 + 1, never rounded through Number.
  const digest = Buffer.alloc(32, 2);
  const h = harness(false, {
    documentMessage: { caption: 'before', fileLength: size, fileSha256: digest.toString('base64') },
  });
  await h.deliver({ documentMessage: { caption: 'after', fileLength: size, fileSha256: digest } });
  assert.deepEqual(h.source.message.documentMessage.fileLength, size);
  await assert.rejects(
    h.deliver({ documentMessage: { caption: 'wrong', fileLength: { ...size, low: 0 } } }),
    /metadata conflicts/,
  );
});

test('a later delivery READ status does not repeat an already acknowledged edit or erase read state', async () => {
  const h = harness();
  await h.deliver({ conversation: 'after' });
  h.source.status = 'READ';
  await h.deliver({ conversation: 'after' });
  assert.equal(h.calls.edits.length, 1);
  assert.equal(h.source.status, 'READ');
  assert.equal(h.source.chatwootIsRead, true);
});

test('different same-second edits serialize; stale epochs do not overwrite latest', async () => {
  const h = harness();
  await Promise.all([h.deliver({ conversation: 'first' }), h.deliver({ conversation: 'second' })]);
  assert.equal(h.source.message.conversation, 'second');
  assert.equal(h.calls.edits.length, 2);
  await h.deliver({ conversation: 'older' }, 1700000009);
  assert.equal(h.source.message.conversation, 'second');
  assert.equal(h.calls.edits.length, 2);
});

test('failed Chatwoot ACK does not mark dedup; retry dispatches without repeated native audit', async () => {
  const h = harness();
  h.failures(1);
  await assert.rejects(h.deliver({ conversation: 'after' }), /lost ACK/);
  assert.equal(h.cache.size, 0);
  await h.deliver({ conversation: 'after' });
  assert.equal(h.calls.edits.length, 2);
  assert.equal(h.calls.audits, 1);
  assert.equal(h.cache.size, 1);
});

test('missing client/no success marker remains unacked and retryable', async () => {
  const h = harness();
  h.ack(undefined);
  await assert.rejects(h.deliver({ conversation: 'after' }), /ACK is unavailable/);
  assert.equal(h.cache.size, 0);
  h.ack({ providerEditApplied: true });
  await h.deliver({ conversation: 'after' });
  assert.equal(h.calls.edits.length, 2);
});

test('missing/ambiguous source, foreign peer/direction and CAS rotation stop before CW', async () => {
  for (const mutate of [(h: any) => h.rows(0), (h: any) => h.rows(2), (h: any) => h.CAS(false)]) {
    const h = harness();
    mutate(h);
    await assert.rejects(h.deliver({ conversation: 'after' }));
    assert.equal(h.calls.edits.length, 0);
    assert.equal(h.cache.size, 0);
  }
  for (const supplied of [{ remoteJid: 'other@g.us' }, { fromMe: true }, { participant: 'foreign@author' }]) {
    const h = harness();
    await assert.rejects(h.deliver({ conversation: 'after' }, 1700000010, { ...h.key, ...supplied }));
    assert.equal(h.calls.edits.length, 0);
  }
});

test('NULL/missing/nontext payloads cannot clear original; changed media authority refuses', async () => {
  for (const body of [null, {}, { conversation: null }, { conversation: '' }, { imageMessage: {} }]) {
    const h = harness();
    await assert.rejects(h.deliver(body));
    assert.deepEqual(h.source, h.before);
  }
  const h = harness(false, { imageMessage: { caption: 'before', fileSha256: 'original', fileLength: 1 } });
  await assert.rejects(h.deliver({ imageMessage: { caption: 'after', fileSha256: 'foreign' } }), /authority conflicts/);
  assert.deepEqual(h.source, h.before);
});

test('normalized update is handled before generic delivery dedup and upsert shares the qualified dispatcher', () => {
  const updateBody = update.getText(ast);
  assert(updateBody.indexOf('applyNativeWhatsappEdit') < updateBody.indexOf('const updateKey'));
  assert.match(file, /await this\.applyNativeWhatsappEdit\(\s*editedMessage\.key,/);
});

test('actual Chatwoot edit service propagates failed ACK and returns success only after real edit request', async (t) => {
  const modulePath = require.resolve('../src/api/server.module.ts');
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  t.after(() => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  });
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service = Object.create(ChatwootService.prototype) as any;
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: false }) };
  service.waMonitor = { waInstances: { synthetic: {} } };
  service.clientCw = async () => ({ client: {}, provider: { accountId: '1', ignoreJids: [] } });
  service.logger = { info() {}, warn() {}, error() {} };
  service.getMessageByKeyId = async () => ({
    chatwootConversationId: 22,
    chatwootMessageId: 11,
    key: { fromMe: false },
  });
  let attempts = 0;
  service.privilegedChatwootRequest = async (_provider: any, request: any) => {
    attempts++;
    assert.equal(request.data.skip_native, true);
    assert.equal(request.data.provider_source, 'whatsapp');
    if (attempts === 1) throw new Error('synthetic HTTP failure');
  };
  const event = {
    key: { id: 'same-provider-id', remoteJid: 'synthetic@s.whatsapp.net', fromMe: false },
    editedMessage: { conversation: 'after' },
  };
  await assert.rejects(service.eventWhatsapp('messages.edit', { instanceName: 'synthetic' }, event), /HTTP failure/);
  assert.deepEqual(await service.eventWhatsapp('messages.edit', { instanceName: 'synthetic' }, event), {
    providerEditApplied: true,
  });
  assert.equal(attempts, 2);
});

test('explicit native PN/LID alias preserves raw original identity and shares successful dedup', async () => {
  const h = harness();
  Object.assign(h.key, { remoteJid: '113529055084610@lid', remoteJidAlt: '6281385255907@s.whatsapp.net' });
  const raw = structuredClone(h.key);
  await h.deliver({ conversation: 'after' }, 1700000010, { ...h.key, remoteJid: h.key.remoteJidAlt } as any);
  assert.deepEqual(h.source.key, raw);
  assert.deepEqual(h.calls.edits[0].body.key, raw);
  await h.deliver({ conversation: 'after' });
  assert.equal(h.calls.edits.length, 1);
  assert.equal(h.calls.audits, 1);
});

test('explicit native participantAlt accepts same author; group/foreign alternates refuse', async () => {
  const h = harness();
  Object.assign(h.key, { participant: '113529055084610@lid', participantAlt: '6281385255907@s.whatsapp.net' });
  await h.deliver({ conversation: 'after' }, 1700000010, { ...h.key, participant: h.key.participantAlt } as any);
  assert.equal(h.calls.edits.length, 1);
  for (const remoteJid of ['other@g.us', '6281385255907@s.whatsapp.net']) {
    const bad = harness();
    Object.assign(bad.key, { remoteJidAlt: remoteJid });
    await assert.rejects(bad.deliver({ conversation: 'after' }, 1700000010, { ...bad.key, remoteJid }));
    assert.equal(bad.calls.edits.length, 0);
    assert.equal(bad.calls.nativeWrites, 0);
  }
});

test('disabled Chatwoot cannot cache an unacknowledged edit as delivered', async () => {
  const h = harness();
  // The native-only integration still persists edits without a destination ACK.
  h.disableChatwoot();
  await h.deliver({ conversation: 'after' });
  assert.equal(h.calls.edits.length, 0);
  assert.equal(h.cache.size, 0);
});

test('literal SDK event registration dispatches normalized edits and retries an unacknowledged event', async () => {
  const h = harness();
  h.failures(1);
  await h.registeredDeliver({ conversation: 'after' });
  assert.equal(h.cache.size, 0);
  assert.equal(h.calls.edits.length, 1);
  await h.registeredDeliver({ conversation: 'after' });
  assert.equal(h.cache.size, 1);
  assert.equal(h.calls.edits.length, 2);
  assert.equal(h.calls.audits, 1);
});
