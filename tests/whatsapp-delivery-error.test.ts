import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import ts from 'typescript';

// Execute the literal production class-field handler without starting a socket.
const text = fs.readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'utf8');
const ast = ts.createSourceFile('service.ts', text, ts.ScriptTarget.Latest, true);
let handler: ts.Expression;
function visit(node: ts.Node) {
  if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text === 'messages.update')
    handler = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
assert(handler);
const code = ts.transpileModule(`const update = ${handler.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function harness(saveUpdates = true) {
  const rows: any[] = [],
    webhooks: any[] = [],
    warnings: string[] = [];
  const cache = new Map();
  const context = {
    instance: { id: 'synthetic-instance' },
    instanceId: 'synthetic-instance',
    logger: { verbose() {}, info() {}, warn: (s: string) => warnings.push(s) },
    baileysCache: { get: async (k: string) => cache.get(k), set: async (k: string, v: any) => cache.set(k, v) },
    configService: { get: () => ({ ENABLED: false, SAVE_DATA: { NEW_MESSAGE: true, MESSAGE_UPDATE: saveUpdates } }) },
    prismaRepository: {
      $queryRaw: async () => [{ id: 'synthetic-native', status: 'PENDING' }],
      messageUpdate: {
        create: async ({ data }: any) => {
          rows.push(data);
        },
      },
      chat: { findFirst: async () => null },
    },
    sendDataWebhook: (event: string, data: any) => {
      webhooks.push({ event, data });
    },
    updateChatUnreadMessages: async () => {},
  };
  const update = new Function('status', 'Events', 'isJidGroup', `${code}; return update;`).call(
    context,
    { 0: 'ERROR', 2: 'SERVER_ACK', 4: 'READ' },
    { MESSAGES_UPDATE: 'messages.update' },
    (jid: string) => jid.endsWith('@g.us'),
  );
  const key = { id: 'WDSYNTHETIC', fromMe: true, remoteJid: '120363000000000000@g.us' };
  const deliver = (parameters: unknown, status = 0) =>
    update([{ key, update: { status, messageStubParameters: parameters, messageTimestamp: 1 } }], {});
  return { rows, webhooks, warnings, deliver };
}

test('distinct provider NACKs persist and same-event duplicate is suppressed; no global failed/resend transition', async () => {
  const h = harness();
  await h.deliver(['479']);
  await h.deliver(['479']);
  await h.deliver(['487']);
  assert.deepEqual(
    h.rows.map((r) => [r.status, r.providerErrorCode]),
    [
      ['ERROR', '479'],
      ['ERROR', '487'],
    ],
  );
  assert.deepEqual(
    h.rows.map((r) => r.messageId),
    ['synthetic-native', 'synthetic-native'],
  );
  assert.equal(h.webhooks.length, 2);
  assert.equal(h.warnings.length, 2);
  assert(h.warnings.every((s) => JSON.parse(s).event === 'whatsapp_delivery_error'));
});

for (const parameters of [
  undefined,
  [],
  ['sensitive raw provider text'],
  ['1234567'],
  [479],
  ['479\nsecret'],
  [' 479'],
]) {
  test(`malformed provider code never persists raw parameters: ${JSON.stringify(parameters)}`, async () => {
    const h = harness();
    await h.deliver(parameters);
    assert.equal(h.rows.length, 1);
    assert.equal(h.rows[0].providerErrorCode, undefined);
    assert.equal(JSON.parse(h.warnings[0]).providerErrorCode, null);
    assert(!JSON.stringify([...h.rows, ...h.webhooks, ...h.warnings]).includes('sensitive raw'));
  });
}

test('normal ACK never gains an error code; disabled update storage is honored', async () => {
  const h = harness();
  await h.deliver(['479'], 2);
  assert.equal(h.rows[0].status, 'SERVER_ACK');
  assert.equal(h.rows[0].providerErrorCode, undefined);
  assert.equal(h.warnings.length, 0);
  const disabled = harness(false);
  await disabled.deliver(['479']);
  assert.equal(disabled.rows.length, 0);
  assert.equal(disabled.webhooks[0].data.providerErrorCode, '479');
});
