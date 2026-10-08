import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { formatWhatsappGroupContent } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-group-display';
import { isLidJid, toCanonicalHistoryJid } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import { ChatwootIngressDeliveryFence } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-delivery-fence';
import {
  chatwootEvoRouteBindingsEqual,
  extractChatwootIngressMentionJids,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';
import {
  inboundDeliveryId,
  inboundPayloadHash,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';

import { requireTrustedChatwootUrl } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-trusted-egress';

function literalService() {
  const source = fs.readFileSync(
    path.resolve('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts'),
    'utf8',
  );
  const file = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const klass = file.statements.find(ts.isClassDeclaration)!;
  const methods = ['isDurableInboundBody', 'inboundProviderFingerprint', 'deliverQueuedInbound', 'createMessage'].map(
    (name) => klass.members.find((m) => m.name?.getText(file) === name)!.getText(file),
  );
  const js = ts.transpileModule(`module.exports=class Consumer {${methods.join('\n')}}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = {
    module: { exports: undefined as any },
    Buffer,
    createHash,
    classifyCachedHistoryRecord,
    inboundPayloadHash,
    inboundDeliveryId,
    isLidJid,
    toCanonicalHistoryJid,
    chatwootEvoRouteBindingsEqual,
    formatWhatsappGroupContent,
    extractChatwootIngressMentionJids,
    Prisma: { AnyNull: 'synthetic-any-null' },
    requireTrustedChatwootUrl,
    axios: { post: async (..._args: any[]) => ({ data: { id: 9 } }) },
    i18next: { t: () => 'Contact' },
    formatIncomingWhatsappMentions: (value: string) => value,
  };
  vm.runInNewContext(js, context);
  const service = new context.module.exports();
  service.testAxios = context.axios;
  return service;
}
function fixture() {
  const service = literalService();
  const peer = '120363000000000000@g.us';
  const native: any = {
    id: 'native-A',
    instanceId: 'one',
    key: { id: 'A', remoteJid: peer, fromMe: false },
    messageType: 'conversation',
    message: { conversation: 'synthetic' },
    messageTimestamp: 1700000000,
    pushName: 'sender',
    contextInfo: null,
    participant: null,
    status: 'READ',
    chatwootMessageId: null,
    chatwootInboxId: null,
    chatwootConversationId: null,
    chatwootContactInboxSourceId: null,
  };
  const provider = {
    id: 'provider',
    instanceId: 'one',
    accountId: '1',
    url: 'https://cw.synthetic',
    nameInbox: 'synthetic',
    enabled: true,
  };
  const binding = {
    version: 1,
    provider: 'evo_whatsapp',
    inbox_id: 42,
    instance_id: 'one',
    instance_name: 'one',
    receiver_fingerprint: 'a'.repeat(64),
  };
  const item: any = {
    id: inboundDeliveryId('one', native),
    instanceId: 'one',
    instanceName: 'one',
    providerId: 'provider',
    providerFingerprint: service.inboundProviderFingerprint(provider),
    accountId: 1,
    inboxId: 42,
    peer,
    sourceId: 'WAID:A',
    fromMe: false,
    payload: structuredClone(native),
    payloadHash: inboundPayloadHash(native),
    attempts: 1,
    leaseOwner: 'owner',
  };
  let rows: any[] = [];
  let creates = 0;
  const updates: any[] = [];
  const queries: any[] = [];
  const owner = () => ({
    id: 9,
    inbox_id: 42,
    message_type: 0,
    private: false,
    content: formatWhatsappGroupContent(native, native.message.conversation, 'Contact'),
    content_attributes: { we_digital_ingress: { source_payload_sha256: inboundPayloadHash(native) } },
    source_id: 'WAID:A',
    conversation_id: 77,
    account_id: 1,
    ci_inbox_id: 42,
    ci_contact_id: 3,
    contact_id: 3,
    contact_account_id: 1,
    identifier: peer,
    provider: 'whatsapp',
    peer,
    attachments: 0,
    contact_inbox_source_id: 'source-ci',
  });
  service.prismaRepository = {
    instance: { findUnique: async () => ({ name: 'one' }) },
    chatwoot: { findUnique: async () => provider },
    message: {
      findMany: async () => [structuredClone(native)],
      updateMany: async (params: any) => {
        updates.push(params);
        return { count: 1 };
      },
    },
  };
  service.waMonitor = { waInstances: { one: { connectionStatus: { state: 'open' } } } };
  service.getInbox = async () => ({ id: 42 });
  service.buildEvoRouteBinding = () => binding;
  service.inboxRouteBinding = () => binding;
  service.inboundStore = {
    bindInbox: async (id: string, ownerName: string, inbox: number) => {
      assert.equal(id, item.id);
      assert.equal(ownerName, 'owner');
      assert.equal(inbox, 42);
      return true;
    },
  };
  service.createConversation = async () => 77;
  service.getConversationMessage = async (msg: any) => msg.conversation;
  service.isMediaMessage = (msg: any) => Boolean(msg.imageMessage || msg.documentMessage);
  service.inboundDeliveryFence = new ChatwootIngressDeliveryFence();
  service.durableInboundBodies = new WeakSet();
  service.pgClient = {
    query: async (sql: string, params: any[]) => {
      queries.push({ sql, params });
      assert.equal(params[0], 1);
      assert.equal(params[1], 42);
      assert.equal(params[2][0], 'WAID:A');
      assert.ok(sql.includes('m.account_id=$1 AND m.inbox_id=$2'));
      return { rows: structuredClone(rows) };
    },
  };
  service.processWhatsappEvent = async (_event: string, _instance: any, body: any) => {
    assert.equal(service.durableInboundBodies.has(body), true);
    creates++;
    rows = [owner()];
    return { id: 9 };
  };
  return {
    service,
    item,
    native,
    provider,
    owner,
    get rows() {
      return rows;
    },
    set rows(value: any[]) {
      rows = value;
    },
    get creates() {
      return creates;
    },
    updates,
    queries,
  };
}

test('literal delivery reads scoped aliases before POST then fresh native version before exact-PK CAS', async () => {
  const f = fixture();
  const ack = await f.service.deliverQueuedInbound(f.item);
  assert.equal(ack.id, 9);
  assert.equal(f.creates, 1);
  assert.equal(f.queries.length, 2);
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].where.id, 'native-A');
  assert.equal(f.updates[0].where.key.equals.remoteJid, f.item.peer);
  assert.equal(f.updates[0].data.chatwootInboxId, 42);
  assert.equal(f.updates[0].data.chatwootContactInboxSourceId, 'source-ci');
});
test('lost POST ACK is recovered by unique scoped readback without another write', async () => {
  const f = fixture();
  f.service.processWhatsappEvent = async () => {
    f.rows = [f.owner()];
    throw new Error('lost ACK');
  };
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /lost ACK/);
  const ack = await f.service.deliverQueuedInbound(f.item);
  assert.equal(ack.id, 9);
  assert.equal(f.creates, 0);
});
test('root restored unique legacy text satisfies pending source without another POST', async () => {
  const f = fixture();
  const owner = f.owner();
  owner.content_attributes = {};
  f.rows = [owner];
  await f.service.deliverQueuedInbound(f.item);
  assert.equal(f.creates, 0);
});
for (const [label, change] of [
  ['crosspeer', { peer: '120363999999999999@g.us' }],
  ['differentinbox', { inbox_id: 33 }],
  ['wrongdirection', { message_type: 1 }],
  ['private', { private: true }],
  ['wrongCI', { ci_contact_id: 99 }],
  ['wrongContactAccount', { contact_account_id: 2 }],
  ['wrongGroupIdentifier', { identifier: 'foreign@g.us' }],
  ['differentbody', { content: 'foreign' }],
])
  test(`literal ${label} owner refuses without POST/native pointer change`, async () => {
    const f = fixture();
    f.rows = [{ ...f.owner(), ...(change as object) }];
    await assert.rejects(f.service.deliverQueuedInbound(f.item));
    assert.equal(f.creates, 0);
    assert.equal(f.updates.length, 0);
  });
test('ambiguous two owners refuses instead of choosing a winner', async () => {
  const f = fixture();
  f.rows = [f.owner(), { ...f.owner(), id: 10 }];
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /Ambiguous/);
  assert.equal(f.creates, 0);
});
test('same source alias only in another inbox does not suppress current destination', async () => {
  const f = fixture();
  await f.service.deliverQueuedInbound(f.item);
  assert.ok(f.queries.every((q) => q.params[1] === 42));
  assert.equal(f.creates, 1);
});
test('current native edit replaces stale queued body before first destination creation', async () => {
  const f = fixture();
  f.native.message.conversation = 'latest edit';
  f.native.status = 'EDITED';
  await f.service.deliverQueuedInbound(f.item);
  assert.equal(f.creates, 1);
  assert.equal(f.updates[0].where.message.equals.conversation, 'latest edit');
});
test('unavailable native edit is retained and never rendered as an ordinary message', async () => {
  const f = fixture();
  f.native.message = null;
  f.native.status = 'EDITED';
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /PayloadUnavailable/);
  assert.equal(f.creates, 0);
  assert.equal(f.queries.length, 0);
});
test('source changes during POST leaves unconfirmed receipt and does not CAS pointers', async () => {
  const f = fixture();
  const original = f.service.processWhatsappEvent;
  f.service.processWhatsappEvent = async (...args: any[]) => {
    const ack = await original(...args);
    f.native.message.conversation = 'new edit during POST';
    return ack;
  };
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /ChangedDuringDelivery/);
  assert.equal(f.updates.length, 0);
});
test('closed native receiver holds delivery before any CW call', async () => {
  const f = fixture();
  f.service.waMonitor.waInstances.one.connectionStatus.state = 'close';
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /RouteNotReady/);
  assert.equal(f.queries.length, 0);
  assert.equal(f.creates, 0);
});
test('changed provider account or immutable route fingerprint holds, without retry to new receiver', async () => {
  const f = fixture();
  f.provider.accountId = '2';
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /RouteNotReady/);
  assert.equal(f.queries.length, 0);
});
test('native pointer contradiction is not overwritten after unique receiver readback', async () => {
  const f = fixture();
  f.native.chatwootMessageId = 999;
  f.rows = [f.owner()];
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /PointerContradiction/);
  assert.equal(f.updates.length, 0);
});

test('contradictory recorded source payload hash holds even when rendered text matches', async () => {
  const f = fixture();
  f.rows = [{ ...f.owner(), content_attributes: { we_digital_ingress: { source_payload_sha256: 'f'.repeat(64) } } }];
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /PayloadUnconfirmed/);
  assert.equal(f.creates, 0);
});
test('bounded native selection refuses overflow rather than assuming an unseen version matches', async () => {
  const f = fixture();
  f.service.prismaRepository.message.findMany = async () => Array.from({ length: 3 }, () => structuredClone(f.native));
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /Ambiguous/);
  assert.equal(f.creates, 0);
});
test('every durable retry rechecks receiver state, without a completed in-memory fence shortcut', async () => {
  const f = fixture();
  f.rows = [f.owner()];
  await f.service.deliverQueuedInbound(f.item);
  f.rows = [{ ...f.owner(), private: true }];
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /IdentityMismatch/);
});

for (const mode of ['ack', 'timeout', '502'])
  test(`literal queued text POST ${mode} uses trusted URL, bounded deadline and no legacy unscoped bind`, async () => {
    const f = fixture();
    let posts = 0,
      binds = 0;
    const body = structuredClone(f.native);
    f.service.durableInboundBodies.add(body);
    f.service.clientCw = async () => ({
      provider: { ...f.provider, token: 'synthetic-test-token' },
      client: {
        messages: {
          create: () => {
            throw Error('SDK path must not run');
          },
        },
      },
    });
    f.service.configService = { get: () => ({ TRUSTED_BASE_URL: 'https://cw.synthetic' }) };
    f.service.getReplyToIds = async () => ({ in_reply_to_external_id: 'WAID:parent' });
    f.service.ingressAttributes = async () => ({
      we_digital_ingress: { source_payload_sha256: inboundPayloadHash(body) },
    });
    f.service.bindInboundChatwootMessageId = async () => {
      binds++;
    };
    f.service.testAxios.post = async (url: string, data: any, config: any) => {
      posts++;
      assert.equal(url, 'https://cw.synthetic/api/v1/accounts/1/conversations/77/messages');
      assert.equal(config.timeout, 30000);
      assert.equal(config.maxRedirects, 0);
      assert.equal(config.headers['api-access-token'], 'synthetic-test-token');
      assert.equal(data.source_id, 'WAID:A');
      assert.equal(data.message_type, 'incoming');
      assert.equal(data.private, false);
      assert.equal(data.content_attributes.in_reply_to_external_id, 'WAID:parent');
      assert.equal(data.content_attributes.we_digital_ingress.source_payload_sha256, inboundPayloadHash(body));
      if (mode !== 'ack')
        throw Object.assign(new Error('synthetic receiver failure'), {
          name: mode === '502' ? 'HTTP502' : 'TimeoutError',
        });
      return { data: { id: 9 } };
    };
    const action = f.service.createMessage(
      { instanceId: 'one', instanceName: 'one' },
      77,
      'synthetic',
      'incoming',
      false,
      undefined,
      body,
      'WAID:A',
    );
    if (mode === 'ack') assert.equal((await action).id, 9);
    else await assert.rejects(action);
    assert.equal(posts, 1);
    assert.equal(binds, 0);
  });
