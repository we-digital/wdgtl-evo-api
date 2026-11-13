import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { buildChatwootEvoRouteBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';
import { canReusePreparedOutboundSnapshot } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-fence';

// Runs the real fence methods of ChatwootService against synthetic rows.
function fenceConsumer() {
  const source = fs.readFileSync(
    path.resolve('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts'),
    'utf8',
  );
  const file = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const klass = file.statements.find(ts.isClassDeclaration)!;
  const methods = ['outboundFenceBinding', 'reusablePreparedOutboundContext', 'revalidateQueuedOutboundTransport'].map(
    (name) => klass.members.find((member) => member.name?.getText(file) === name)!.getText(file),
  );
  const javascript = ts.transpileModule(`module.exports=class Consumer {${methods.join('\n')}}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = {
    // The provider bus is off in these sandboxes (utils/chatwoot-bus.ts).
    busInstanceEnabled: () => false,
    BUS_CAPTURE_CONVERSATION: -1, module: { exports: undefined as any }, canReusePreparedOutboundSnapshot, Date };
  vm.runInNewContext(javascript, context);
  return new context.module.exports();
}

function setup() {
  const consumer = fenceConsumer();
  const socket = { instanceId: 'synthetic-instance', connectionStatus: { state: 'open' } };
  const instance = {
    instanceId: 'synthetic-instance',
    instanceName: 'synthetic',
    ownerJid: null,
    number: '10000000000',
  };
  const provider = {
    id: 'provider-1',
    enabled: true,
    url: 'https://chatwoot.invalid',
    token: 'synthetic-token',
    accountId: '1',
    nameInbox: 'synthetic',
    updatedAt: new Date(1_000),
  };
  const rows = { instance: { ...instance }, provider: { ...provider } };
  const calls = { exactReads: 0, rowReads: 0 };
  consumer.outboundFenceSnapshotMaxAgeMs = 1_500;
  consumer.waMonitor = { waInstances: { synthetic: socket } };
  consumer.outboundInstance = async () => {
    calls.rowReads += 1;
    return { ...rows.instance };
  };
  consumer.prismaRepository = { chatwoot: { findUnique: async () => ({ ...rows.provider }) } };
  consumer.buildEvoRouteBinding = (i: any, p: any, inboxId: number) =>
    buildChatwootEvoRouteBinding({
      inboxId,
      instanceId: i.instanceId,
      instanceName: i.instanceName,
      receiverNumber: i.number,
      signingKey: p.token,
    });
  const operation = { instanceId: 'synthetic-instance', payload: { origin: { inboxId: 45 } } };
  const prepared = (startedAt = Date.now() - 300) => ({
    instance,
    waInstance: socket,
    provider,
    authoritativelyDeleted: false,
    snapshotStartedAt: startedAt,
    fenceBinding: consumer.outboundFenceBinding(instance, provider, 45, socket),
    providerContext: { snapshot_fingerprint: 'prepared' },
  });
  consumer.currentOutboundContext = async () => {
    calls.exactReads += 1;
    return { ...prepared(), providerContext: { snapshot_fingerprint: 'fresh' } };
  };
  return { consumer, operation, prepared, rows, calls, socket };
}

const signal = new AbortController().signal;

test('the transport fence reuses a fresh preparation snapshot without a second exact Chatwoot read', async () => {
  const { consumer, operation, prepared, calls } = setup();
  const result = await consumer.revalidateQueuedOutboundTransport(operation, signal, prepared());
  assert.equal(result.validation, 'valid');
  assert.equal(result.providerContext.snapshot_fingerprint, 'prepared');
  assert.equal(result.snapshotReused, true);
  assert.deepEqual(calls, { exactReads: 0, rowReads: 1 });
});

test('the transport fence reads the exact message again for a stale snapshot or a changed binding', async () => {
  const stale = setup();
  const staleResult = await stale.consumer.revalidateQueuedOutboundTransport(
    stale.operation,
    signal,
    stale.prepared(Date.now() - 1_600),
  );
  assert.equal(staleResult.snapshotReused, false);
  assert.equal(staleResult.providerContext.snapshot_fingerprint, 'fresh');
  assert.deepEqual(stale.calls, { exactReads: 1, rowReads: 0 });

  const changed = setup();
  const preparedContext = changed.prepared();
  changed.rows.provider.updatedAt = new Date(2_000);
  const changedResult = await changed.consumer.revalidateQueuedOutboundTransport(
    changed.operation,
    signal,
    preparedContext,
  );
  assert.equal(changedResult.snapshotReused, false);
  assert.equal(changed.calls.exactReads, 1);

  const renamed = setup();
  const renamedContext = renamed.prepared();
  renamed.rows.instance.instanceName = 'renamed';
  const renamedResult = await renamed.consumer.revalidateQueuedOutboundTransport(
    renamed.operation,
    signal,
    renamedContext,
  );
  assert.equal(renamedResult.snapshotReused, false);
  assert.equal(renamed.calls.exactReads, 1);

  const disabled = setup();
  disabled.consumer.outboundFenceSnapshotMaxAgeMs = 0;
  await disabled.consumer.revalidateQueuedOutboundTransport(disabled.operation, signal, disabled.prepared());
  assert.deepEqual(disabled.calls, { exactReads: 1, rowReads: 0 });
});

test('the reused fence still refuses a socket that is no longer open and a vanished binding', async () => {
  const closed = setup();
  const closedContext = closed.prepared();
  closed.socket.connectionStatus.state = 'close';
  await assert.rejects(
    closed.consumer.revalidateQueuedOutboundTransport(closed.operation, signal, closedContext),
    (error: Error) => error.name === 'WhatsappNotReady',
  );

  const gone = setup();
  const goneContext = gone.prepared();
  gone.consumer.prismaRepository = { chatwoot: { findUnique: async () => null } };
  gone.consumer.currentOutboundContext = async () => {
    gone.calls.exactReads += 1;
    return null;
  };
  const result = await gone.consumer.revalidateQueuedOutboundTransport(gone.operation, signal, goneContext);
  assert.equal(result.validation, 'mismatch');
  assert.equal(gone.calls.exactReads, 1);
});
