import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import ts from 'typescript';

// Executes the literal production code: the socket's shouldIgnoreJid and the
// messages.upsert class-field handler, without a socket.
const text = fs.readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'utf8');
const ast = ts.createSourceFile('service.ts', text, ts.ScriptTarget.Latest, true);
let ignore: ts.Expression | undefined;
let upsert: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'shouldIgnoreJid')
    ignore = node.initializer;
  if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text === 'messages.upsert')
    upsert = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
assert(ignore && upsert);
const compile = (expression: ts.Expression) =>
  ts.transpileModule(`const fn = ${expression.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;

const isJidGroup = (jid: string) => jid.endsWith('@g.us');
const isJidBroadcast = (jid: string) => jid.endsWith('@broadcast');
const isJidNewsletter = (jid: string) => jid.endsWith('@newsletter');

function shouldIgnoreJid(localSettings: Record<string, boolean>) {
  return new Function('isJidGroup', 'isJidBroadcast', 'isJidNewsletter', `${compile(ignore!)}; return fn;`).call(
    { localSettings, historySyncFullRequestedForSocket: false },
    isJidGroup,
    isJidBroadcast,
    isJidNewsletter,
  );
}

test('statuses reach Baileys processing (receipt) even with readStatus off; other broadcasts stay ignored', () => {
  const off = shouldIgnoreJid({ readStatus: false, groupsIgnore: false });
  assert.equal(off('status@broadcast'), false);
  assert.equal(off('1234567890@broadcast'), true);
  assert.equal(off('120363000000000000@newsletter'), true);
  assert.equal(off('628000000000@s.whatsapp.net'), false);
  const on = shouldIgnoreJid({ readStatus: true, groupsIgnore: false });
  assert.equal(on('status@broadcast'), false);
  assert.equal(on('1234567890@broadcast'), false);
});

test('with readStatus off a status is dropped before anything is stored, forwarded or announced', async () => {
  const touched: string[] = [];
  const context = new Proxy({ localSettings: { readStatus: false } } as Record<string, any>, {
    get(target, property) {
      if (property in target) return target[property as string];
      touched.push(String(property));
      throw new Error(`touched ${String(property)}`);
    },
  });
  const handler = new Function(`${compile(upsert!)}; return fn;`).call(context);
  const status = {
    key: { id: 'SYNTHETICSTATUS', remoteJid: 'status@broadcast', fromMe: false, participant: '1@lid' },
    message: { imageMessage: { caption: 'synthetic' } },
    messageTimestamp: 1,
  };
  await handler({ messages: [status, status], type: 'notify' }, {});
  assert.deepEqual(touched, []);
});
