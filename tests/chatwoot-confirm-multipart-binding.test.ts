import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { withCanonicalChatwootMessageBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-canonical-message-binding';
import {
  acknowledgedMultipartPartsMatch,
  buildChatwootDeliverySuccessUpdate,
  isChatwootProviderDeliveryAcknowledged,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';
import { chatwootEvoRouteBindingsEqual } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';

const parts = [
  { partKey: 'first', partIndex: 0, partCount: 2, sourceId: 'A' },
  { partKey: 'second', partIndex: 1, partCount: 2, sourceId: 'B' },
];
const receipt = () => ({
  we_digital_api_inbox_status: {
    confirmed_status: 'sent',
    provider_delivery: {
      contract_version: 1,
      part_count: 2,
      acknowledgements: {
        first: { part_index: 0, source_id: 'A' },
        second: { part_index: 1, source_id: 'B' },
      },
    },
  },
});

function originalConsumer() {
  const source = fs.readFileSync(
    path.resolve('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts'),
    'utf8',
  );
  const file = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const klass = file.statements.find(ts.isClassDeclaration)!;
  const methods = ['confirmQueuedOutbound', 'persistLocalChatwootMessageBinding', 'validCallbackProviderContext'].map(
    (name) => klass.members.find((member) => member.name?.getText(file) === name)!.getText(file),
  );
  const javascript = ts.transpileModule(`module.exports=class Consumer {${methods.join('\n')}}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = {
    module: { exports: undefined as any },
    withCanonicalChatwootMessageBinding,
    buildChatwootDeliverySuccessUpdate,
    isChatwootProviderDeliveryAcknowledged,
    chatwootEvoRouteBindingsEqual,
    postgresClient: { getChatwootConnection: () => undefined as any },
  };
  vm.runInNewContext(javascript, context);
  return context;
}

async function runOriginalConsumer(rotateReceipt = false) {
  const context = originalConsumer();
  const consumer = new context.module.exports();
  const route = {
    version: 2,
    provider: 'evo_whatsapp',
    inbox_id: 45,
    instance_id: 'synthetic-instance',
    instance_name: 'synthetic',
    receiver_fingerprint: 'a'.repeat(64),
  };
  let source: string | null = null;
  let attrs: any = {};
  const acknowledged: typeof parts = [];
  const nativeWrites: string[] = [];
  const events: string[] = [];
  const client = {
    query: async (sql: string) => {
      events.push(sql);
      if (sql.startsWith('SELECT conversation_id,source_id')) {
        assert.equal(sql.endsWith(' FOR SHARE'), true);
        return { rows: [{ conversation_id: 8, source_id: source, message_type: 1, additional_attributes: attrs }] };
      }
      if (sql.startsWith('SELECT public.provider_message_conversation_route')) return { rows: [{ id: 8 }] };
      if (sql.startsWith('SELECT c.id'))
        return { rows: [{ id: 8, display_id: 84455, inbox_id: 45, source_id: 'synthetic-contact-source' }] };
      return { rows: [] };
    },
    release: () => events.push('release'),
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [{ routes: 'provider_conversation_routes', resolver: 'resolver' }] }),
  };
  context.postgresClient.getChatwootConnection = () => pool;
  consumer.prismaRepository = {
    chatwoot: { findUnique: async () => ({}) },
    $transaction: async (work: any) =>
      work({
        $executeRaw: async (_sql: any, ...values: any[]) => {
          assert.equal(values[0], 2498729);
          assert.equal(values[1], 84455);
          assert.equal(values[2], 45);
          assert.equal(values[4], false);
          nativeWrites.push(values.at(-1));
          return 1;
        },
      }),
  };
  consumer.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: true }) };
  consumer.outboundInstance = async () => ({ instanceId: 'synthetic-instance' });
  consumer.providerMatchesFrozenOutboundOrigin = () => true;
  consumer.buildEvoRouteBinding = () => route;
  consumer.clientCw = async () => ({ provider: { accountId: '1' } });
  consumer.getInbox = async () => ({ id: 45 });
  consumer.updateQueuedOutboundMessage = async (_provider: any, update: any) => {
    const p = parts.find((part) => part.partIndex === update.data.provider_delivery.part_index)!;
    acknowledged.push(p);
    if (acknowledged.length === 2) {
      source = 'A';
      attrs = receipt();
      if (rotateReceipt)
        attrs.we_digital_api_inbox_status.provider_delivery.acknowledgements.second.source_id = 'rotated';
    }
    return {
      id: 2498729,
      source_id: source,
      status: acknowledged.length === 2 ? 'sent' : 'failed',
      provider_delivery: {
        contract_version: 1,
        acknowledged: true,
        message_confirmed: acknowledged.length === 2,
        part_key: p.partKey,
        part_index: p.partIndex,
        part_count: 2,
        acknowledged_part_count: acknowledged.length,
        source_ids: acknowledged.map((part) => ({
          part_key: part.partKey,
          part_index: part.partIndex,
          source_id: part.sourceId,
        })),
      },
    };
  };
  consumer.currentOutboundContext = () => assert.fail('No legacy fallback');
  const confirm = () =>
    consumer.confirmQueuedOutbound(
      {
        instanceId: 'synthetic-instance',
        payload: {
          origin: {
            accountId: 1,
            messageId: 2498729,
            inboxId: 45,
            conversationId: 84455,
            routeBinding: route,
            contactInboxSourceId: 'synthetic-contact-source',
          },
        },
        callbackContext: { snapshot_version: 1, snapshot_fingerprint: 'b'.repeat(64), binding: route },
      },
      parts,
      new AbortController().signal,
    );
  if (rotateReceipt) {
    await assert.rejects(confirm(), /Canonical mapping message identity mismatch/);
    assert.deepEqual(nativeWrites, ['A']);
    assert.equal(events.filter((event) => event === 'COMMIT').length, 1);
    assert.equal(events.at(-2), 'ROLLBACK');
    return;
  }
  await confirm();
  assert.deepEqual(nativeWrites, ['A', 'B']);
  assert.equal(source, 'A');
  assert.equal(events.filter((event) => event === 'COMMIT').length, 2);
}

test('original confirm consumer persists both acknowledged parts while CW retains part zero source', () =>
  runOriginalConsumer());
test('original confirm consumer refuses the later part after receipt rotation and preserves its first confirmed binding', () =>
  runOriginalConsumer(true));

for (const defect of ['missing', 'extra', 'partKey', 'source', 'index', 'incoming', 'noExpectedParts']) {
  test(`later-part mapping refuses ${defect} before native write`, async () => {
    const attrs: any = receipt();
    const expected = structuredClone(parts);
    if (defect === 'missing') delete attrs.we_digital_api_inbox_status.provider_delivery.acknowledgements.second;
    if (defect === 'extra')
      attrs.we_digital_api_inbox_status.provider_delivery.acknowledgements.other = { part_index: 2, source_id: 'C' };
    if (defect === 'partKey') expected[1].partKey = 'foreign';
    if (defect === 'source') expected[1].sourceId = 'foreign';
    if (defect === 'index') attrs.we_digital_api_inbox_status.provider_delivery.acknowledgements.second.part_index = 0;
    let writes = 0;
    const statements: string[] = [];
    const pool: any = {
      connect: async () => ({
        query: async (sql: string) => {
          statements.push(sql);
          return sql.startsWith('SELECT conversation_id,source_id')
            ? {
                rows: [
                  {
                    conversation_id: 8,
                    source_id: 'A',
                    message_type: defect === 'incoming' ? 0 : 1,
                    additional_attributes: attrs,
                  },
                ],
              }
            : { rows: [] };
        },
        release: () => undefined,
      }),
    };
    await assert.rejects(
      withCanonicalChatwootMessageBinding(
        pool,
        {
          accountId: 1,
          inboxId: 45,
          messageId: 2498729,
          whatsappMessageId: 'B',
          acknowledgedParts: defect === 'noExpectedParts' ? undefined : expected,
        },
        async () => ++writes,
      ),
      /Canonical mapping message identity mismatch/,
    );
    assert.equal(writes, 0);
    assert.equal(statements.at(-1), 'ROLLBACK');
  });
}

test('complete receipts also require canonical part zero and exact frozen part keys', () => {
  assert.equal(acknowledgedMultipartPartsMatch(receipt(), 'A', parts), true);
  assert.equal(acknowledgedMultipartPartsMatch(receipt(), 'B', parts), false);
  assert.equal(acknowledgedMultipartPartsMatch('{bad', 'A', parts), false);
});
