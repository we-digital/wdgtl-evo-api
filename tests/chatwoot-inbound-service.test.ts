import { legacyWhatsappGroupContent } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-group-display';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import {
  isGroupJid,
  isLidJid,
  toCanonicalHistoryJid,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import { ChatwootIngressDeliveryFence } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-delivery-fence';
import {
  chatwootEvoRouteBindingsEqual,
  extractChatwootIngressMentionJids,
  isChatwootLinkedClientSentEvent,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';
import {
  ChatwootInboundQueue,
  inboundDeliveryId,
  inboundPayloadHash,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';

import {
  inboundHistoryDocumentProjection,
  inboundNativeSnapshot,
  resolveInboundNativeBody,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-native-source';

import { extractWhatsappReplyStanzaId } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-reply-context';

import { requireTrustedChatwootUrl } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-trusted-egress';

function literalService() {
  const source = fs.readFileSync(
    path.resolve('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts'),
    'utf8',
  );
  const file = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const klass = file.statements.find(ts.isClassDeclaration)!;
  const methods = [
    'isDurableInboundBody',
    'inboundProviderFingerprint',
    'deliverQueuedInbound',
    'requestInboundConversation',
    'createMessage',
    'processWhatsappEvent',
  ].map((name) => klass.members.find((m) => m.name?.getText(file) === name)!.getText(file));
  const js = ts.transpileModule(`module.exports=class Consumer {${methods.join('\n')}}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = {
    module: { exports: undefined as any },
    Buffer,
    createHash,
    isDeepStrictEqual,
    legacyWhatsappGroupContent,
    classifyCachedHistoryRecord,
    inboundPayloadHash,
    inboundDeliveryId,
    inboundHistoryDocumentProjection,
    inboundNativeSnapshot,
    resolveInboundNativeBody,
    isLidJid,
    isGroupJid,
    isChatwootLinkedClientSentEvent,
    extractWhatsappReplyStanzaId,
    isChatwootOutboundEcho: async () => false,
    toCanonicalHistoryJid,
    chatwootEvoRouteBindingsEqual,
    extractChatwootIngressMentionJids,
    isChatwootLinkedClientSentEvent,
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
  const literalProcess = service.processWhatsappEvent;
  service.logger = { info() {}, warn() {}, error() {} };
  service.getAdsMessage = () => ({});
  service.getReactionMessage = () => null;
  service.isInteractiveButtonMessage = () => false;
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
    content: native.message.conversation,
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
  service.inboundCanonicalContexts = new WeakMap();
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
    assert.equal(service.requestInboundConversation({ instanceId: 'one', instanceName: 'one' }, provider, body), 77);
    creates++;
    rows = [owner()];
    return { id: 9 };
  };
  return {
    service,
    literalProcess,
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

function useLiteralProcess(f: ReturnType<typeof fixture>) {
  let resolutions = 0;
  let writes = 0;
  let deliveredBody: any;
  f.service.createConversation = async () => {
    resolutions++;
    return 77;
  };
  f.service.clientCw = async () => ({ client: {}, provider: f.provider });
  f.service.processWhatsappEvent = f.literalProcess;
  f.service.createMessage = async (
    _instance: any,
    conversation: number,
    content: string,
    direction: string,
    _private: boolean,
    _tags: any,
    body: any,
    sourceId: string,
  ) => {
    assert.equal(conversation, 77);
    assert.equal(content, f.owner().content);
    assert.equal(direction, 'incoming');
    assert.equal(sourceId, 'WAID:A');
    deliveredBody = body;
    writes++;
    f.rows = [f.owner()];
    return { id: 9 };
  };
  return {
    get resolutions() {
      return resolutions;
    },
    get writes() {
      return writes;
    },
    get deliveredBody() {
      return deliveredBody;
    },
  };
}

test('literal incoming consumer resolves once and preserves owner/native post-ACK checks', async () => {
  const f = fixture();
  const calls = useLiteralProcess(f);
  const ack = await f.service.deliverQueuedInbound(f.item);
  assert.equal(ack.id, 9);
  assert.equal(calls.resolutions, 1);
  assert.equal(calls.writes, 1);
  assert.equal(f.queries.length, 2);
  assert.equal(f.updates.length, 1);
  assert.equal(f.service.inboundCanonicalContexts.has(calls.deliveredBody), false);
});

for (const [label, mutate] of [
  [
    'provider account',
    (f: any, _body: any) => {
      f.provider.accountId = '2';
    },
  ],
  [
    'provider route',
    (f: any, _body: any) => {
      f.provider.nameInbox = 'moved';
    },
  ],
  [
    'registered receiver',
    (f: any, _body: any) => {
      f.service.buildEvoRouteBinding = () => ({
        version: 1,
        provider: 'evo_whatsapp',
        inbox_id: 42,
        instance_id: 'one',
        instance_name: 'one',
        receiver_fingerprint: 'b'.repeat(64),
      });
    },
  ],
  [
    'receiver disconnected',
    (f: any, _body: any) => {
      f.service.waMonitor.waInstances.one.connectionStatus.state = 'close';
    },
  ],
  [
    'native peer',
    (_f: any, body: any) => {
      body.key.remoteJid = '120363999999999999@g.us';
    },
  ],
  [
    'native direction',
    (_f: any, body: any) => {
      body.key.fromMe = true;
    },
  ],
  [
    'native source',
    (_f: any, body: any) => {
      body.key.id = 'OTHER';
    },
  ],
  [
    'native version',
    (_f: any, body: any) => {
      body.message.conversation = 'changed';
    },
  ],
] as const)
  test(`request-local ${label} rotation refuses before POST, never reuses a changed context`, async () => {
    const f = fixture();
    const calls = useLiteralProcess(f);
    let received: any;
    f.service.processWhatsappEvent = async function (event: string, instance: any, body: any) {
      received = body;
      mutate(f, body);
      return f.literalProcess.call(this, event, instance, body);
    };
    await assert.rejects(f.service.deliverQueuedInbound(f.item), /InboundRequestCanonicalChanged/);
    assert.equal(calls.resolutions, 1);
    assert.equal(calls.writes, 0);
    assert.equal(f.updates.length, 0);
    assert.equal(f.service.inboundCanonicalContexts.has(received), false);
  });

test('retry after lost ACK discards the request context and resolves again before alias readback', async () => {
  const f = fixture();
  const calls = useLiteralProcess(f);
  let delivered: any;
  f.service.createMessage = async (
    _instance: any,
    _conversation: number,
    _content: string,
    _direction: string,
    _private: boolean,
    _tags: any,
    body: any,
  ) => {
    delivered = body;
    f.rows = [f.owner()];
    throw new Error('lost ACK');
  };
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /lost ACK/);
  assert.equal(f.service.inboundCanonicalContexts.has(delivered), false);
  const ack = await f.service.deliverQueuedInbound(f.item);
  assert.equal(ack.id, 9);
  assert.equal(calls.resolutions, 2);
});

test('a cloned body or another receiver cannot inherit request-local canonical authority', async () => {
  const f = fixture();
  let received: any;
  f.service.processWhatsappEvent = async function (_event: string, instance: any, body: any) {
    received = body;
    assert.equal(this.requestInboundConversation(instance, f.provider, structuredClone(body)), null);
    assert.throws(
      () => this.requestInboundConversation({ ...instance, instanceId: 'other' }, f.provider, body),
      /InboundRequestCanonicalChanged/,
    );
    assert.throws(
      () => this.requestInboundConversation({ ...instance, instanceName: 'other' }, f.provider, body),
      /InboundRequestCanonicalChanged/,
    );
    f.rows = [f.owner()];
    return { id: 9 };
  };
  await f.service.deliverQueuedInbound(f.item);
  assert.equal(f.service.inboundCanonicalContexts.has(received), false);
});

test('direct/non-queued incoming and outgoing calls continue their original resolver path', async () => {
  for (const fromMe of [false, true]) {
    const f = fixture();
    const calls = useLiteralProcess(f);
    const body = structuredClone(f.native);
    body.key.fromMe = fromMe;
    f.service.createMessage = async () => ({ id: 9 });
    await f.service.processWhatsappEvent('messages.upsert', { instanceId: 'one', instanceName: 'one' }, body);
    assert.equal(calls.resolutions, 1);
    assert.equal(f.service.inboundCanonicalContexts.has(body), false);
  }
});

for (const blank of [false, true])
  test(`provider-original plaintext survives ${blank ? 'blank' : 'equivalent'} crypto transport copy`, async () => {
    const f = fixture();
    f.native.message.senderKeyDistributionMessage = {
      groupId: f.item.peer,
      axolotlSenderKeyDistributionMessage: 'AQID',
    };
    f.item.payload = structuredClone(f.native);
    f.item.payload.message.senderKeyDistributionMessage.axolotlSenderKeyDistributionMessage = { 0: 1, 1: 2, 2: 3 };
    f.item.payloadHash = inboundPayloadHash(f.item.payload);
    const copy = structuredClone(f.native);
    copy.id = 'native-B';
    copy.messageTimestamp += 4;
    copy.message.senderKeyDistributionMessage.axolotlSenderKeyDistributionMessage = 'BAUG';
    if (blank) copy.message.conversation = '';
    f.service.prismaRepository.message.findMany = async () => [structuredClone(f.native), structuredClone(copy)];
    f.service.processWhatsappEvent = async (_event: string, _instance: any, body: any) => {
      assert.equal(body.messageTimestamp, f.item.payload.messageTimestamp);
      assert.equal(body.message.conversation, 'synthetic');
      f.rows = [
        { ...f.owner(), content_attributes: { we_digital_ingress: { source_payload_sha256: f.item.payloadHash } } },
      ];
      return { id: 9 };
    };
    const ack = await f.service.deliverQueuedInbound(f.item);
    assert.equal(ack.id, 9);
    assert.equal(f.updates.length, 2);
    assert.equal(f.updates[1].where.message.equals.conversation, blank ? '' : 'synthetic');
  });

test('existing plaintext destination reconciles event/native byte representation without a POST', async () => {
  const f = fixture();
  f.native.message.messageContextInfo = { messageSecret: 'AQID' };
  f.item.payload = structuredClone(f.native);
  f.item.payload.message.messageContextInfo.messageSecret = { 0: 1, 1: 2, 2: 3 };
  f.item.payloadHash = inboundPayloadHash(f.item.payload);
  f.rows = [
    { ...f.owner(), content_attributes: { we_digital_ingress: { source_payload_sha256: f.item.payloadHash } } },
  ];
  await f.service.deliverQueuedInbound(f.item);
  assert.equal(f.creates, 0);
  assert.equal(f.updates.length, 1);
});

for (const [label, change] of [
  [
    'different text',
    (copy: any) => {
      copy.message.conversation = 'conflicting';
    },
  ],
  [
    'blank edit',
    (copy: any) => {
      copy.message.conversation = '';
      copy.status = 'EDITED';
    },
  ],
  [
    'different author',
    (copy: any) => {
      copy.pushName = 'foreign';
    },
  ],
  [
    'cross peer',
    (copy: any) => {
      copy.key.remoteJid = 'foreign@g.us';
    },
  ],
  [
    'unknown control',
    (copy: any) => {
      copy.message.protocolMessage = { type: 0 };
    },
  ],
] as const)
  test(`transport reconciliation refuses ${label}`, async () => {
    const f = fixture();
    f.native.message.senderKeyDistributionMessage = {
      groupId: f.item.peer,
      axolotlSenderKeyDistributionMessage: 'AQID',
    };
    f.item.payload = structuredClone(f.native);
    f.item.payloadHash = inboundPayloadHash(f.item.payload);
    const copy = structuredClone(f.native);
    copy.id = 'native-B';
    change(copy);
    f.service.prismaRepository.message.findMany = async () => [structuredClone(f.native), copy];
    await assert.rejects(f.service.deliverQueuedInbound(f.item), /Ambiguous/);
    assert.equal(f.creates, 0);
    assert.equal(f.updates.length, 0);
  });

test('transport-copy source rotation during receiver POST invalidates ACK before any native pointer CAS', async () => {
  const f = fixture();
  f.native.message.senderKeyDistributionMessage = { groupId: f.item.peer, axolotlSenderKeyDistributionMessage: 'AQID' };
  f.item.payload = structuredClone(f.native);
  f.item.payloadHash = inboundPayloadHash(f.item.payload);
  const copy = structuredClone(f.native);
  copy.id = 'native-B';
  copy.messageTimestamp += 4;
  f.service.prismaRepository.message.findMany = async () => [structuredClone(f.native), structuredClone(copy)];
  f.service.processWhatsappEvent = async () => {
    f.rows = [f.owner()];
    copy.messageTimestamp++;
    return { id: 9 };
  };
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /ChangedDuringDelivery/);
  assert.equal(f.updates.length, 0);
});

test('transport-copy reconciliation does not grant outgoing retries', () => {
  const stored = {
    key: { id: 'outbound', remoteJid: 'peer@s.whatsapp.net', fromMe: true },
    messageType: 'conversation',
    messageTimestamp: 1700000000,
    status: 'READ',
    message: {
      conversation: 'synthetic',
      senderKeyDistributionMessage: { axolotlSenderKeyDistributionMessage: 'AQID' },
    },
  };
  const transportCopy = structuredClone(stored);
  transportCopy.messageTimestamp += 4;
  assert.throws(() => resolveInboundNativeBody([stored, transportCopy], stored), /Ambiguous/);
});

async function recoveredDocumentFixture() {
  const f = fixture();
  const bytes = Buffer.alloc(32, 7).toString('base64');
  f.native.key = {
    id: 'A',
    fromMe: false,
    remoteJid: '100000000000000@lid',
    remoteJidAlt: '628123456789@s.whatsapp.net',
    participant: '',
  };
  f.native.messageType = 'documentMessage';
  f.native.message = {
    documentMessage: {
      caption: '',
      fileSha256: bytes,
      fileEncSha256: bytes,
      mediaKey: bytes,
      jpegThumbnail: 'AQID',
      fileLength: { low: 110906, high: 0, unsigned: true },
      mimetype: 'application/pdf',
      fileName: 'synthetic.pdf',
    },
    messageContextInfo: { messageSecret: bytes, deviceListMetadata: { recipientKeyHash: 'AQID' } },
    mediaUrl: 'https://storage.synthetic/native.pdf',
  };
  f.native.participant = null;
  f.native.pushName = 'synthetic author';
  f.item.payload = structuredClone(f.native);
  delete f.item.payload.message.mediaUrl;
  for (const field of ['fileSha256', 'fileEncSha256', 'mediaKey', 'jpegThumbnail'])
    f.item.payload.message.documentMessage[field] = Object.fromEntries(
      [...Buffer.from(f.native.message.documentMessage[field], 'base64')].map((value, index) => [String(index), value]),
    );
  f.item.payload.message.messageContextInfo.messageSecret = { type: 'Buffer', data: [...Buffer.alloc(32, 7)] };
  f.item.payload.message.messageContextInfo.deviceListMetadata.recipientKeyHash = { 0: 1, 1: 2, 2: 3 };
  f.item.peer = f.native.key.remoteJid;
  f.item.id = inboundDeliveryId('one', f.item.payload);
  f.item.payloadHash = inboundPayloadHash(f.item.payload);
  const projected = await inboundHistoryDocumentProjection(f.native, f.item.payload);
  f.service.getConversationMessage = async (msg: any) => msg.documentMessage.caption;
  f.service.getReplyToIds = async () => ({});
  const binding = f.service.buildEvoRouteBinding();
  f.rows = [
    {
      ...f.owner(),
      peer: projected.key.remoteJid,
      identifier: projected.key.remoteJid,
      content: '',
      attachments: 1,
      created_at_epoch: f.native.messageTimestamp,
      content_attributes: {
        we_digital_ingress: {
          source_payload_sha256: inboundPayloadHash(projected),
          provider: 'evo_whatsapp',
          scope: 'direct',
          from_me: false,
          direction: 'inbound',
          route: structuredClone(binding),
        },
        provider_history_native: {
          message_id: f.native.id,
          from_me: false,
          remote_jid: projected.key.remoteJid,
          participant: '',
          participant_alt: null,
          push_name: f.native.pushName,
        },
        external_created_at: f.native.messageTimestamp,
      },
    },
  ];
  let physical = 0;
  f.service.assertTaggedHistoryMediaStored = async (
    messages: any[],
    instance: any,
    provider: any,
    inbox: number,
    required: Set<string>,
  ) => {
    physical++;
    assert.equal(inbox, 42);
    assert.deepEqual([...required], ['WAID:A']);
    assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), JSON.parse(JSON.stringify(projected)));
    return new Set(['WAID:A']);
  };
  return {
    ...f,
    get rows() {
      return f.rows;
    },
    set rows(value: any[]) {
      f.rows = value;
    },
    get creates() {
      return f.creates;
    },
    get physical() {
      return physical;
    },
  };
}

test('exact cached document history projection confirms existing owner through full physical proof without POST', async () => {
  const f = await recoveredDocumentFixture();
  const original = JSON.stringify(f.item.payload);
  const native = JSON.stringify(f.native);
  const ack = await f.service.deliverQueuedInbound(f.item);
  assert.equal(ack.id, 9);
  assert.equal(f.creates, 0);
  assert.equal(f.physical, 1);
  assert.equal(f.queries.length, 2);
  assert.equal(JSON.stringify(f.item.payload), original);
  assert.equal(JSON.stringify(f.native), native);
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].data.chatwootMessageId, 9);
});

test('cached document fallback rejects semantic changes, malformed bytes, foreign owner and missing full proof', async () => {
  const changes = [
    (f: any) => (f.native.message.documentMessage.caption = 'changed'),
    (f: any) => (f.native.message.documentMessage.fileName = 'changed.pdf'),
    (f: any) => f.native.message.documentMessage.fileLength.low++,
    (f: any) => (f.native.message.unknownNode = { opaque: true }),
    (f: any) => (f.item.payload.message.documentMessage.fileSha256 = { 0: 999 }),
    (f: any) => (f.native.contextInfo = { stanzaId: 'foreign' }),
    (f: any) => (f.native.instanceId = 'foreign'),
    (f: any) => (f.native.status = 'EDITED'),
    (f: any) => f.native.messageTimestamp++,
    (f: any) => (f.native.messageType = 'imageMessage'),
  ];
  for (const mutate of changes) {
    const f = await recoveredDocumentFixture();
    mutate(f);
    f.item.payloadHash = inboundPayloadHash(f.item.payload);
    await assert.rejects(f.service.deliverQueuedInbound(f.item));
    assert.equal(f.creates, 0);
    assert.equal(f.updates.length, 0);
  }
  for (const mutate of [
    (r: any) => (r.inbox_id = 43),
    (r: any) => (r.message_type = 1),
    (r: any) => (r.private = true),
    (r: any) => (r.peer = 'foreign@g.us'),
    (r: any) => r.created_at_epoch++,
    (r: any) => r.content_attributes.external_created_at++,
    (r: any) => (r.content_attributes.provider_history_native.message_id = 'foreign'),
    (r: any) => (r.content_attributes.we_digital_ingress.route.receiver_fingerprint = 'f'.repeat(64)),
    (r: any) => (r.content_attributes.in_reply_to_external_id = 'WAID:foreign'),
    (r: any) => (r.content_attributes.we_digital_ingress.source_payload_sha256 = 'f'.repeat(64)),
  ]) {
    const f = await recoveredDocumentFixture();
    const rows = f.rows;
    mutate(rows[0]);
    f.rows = rows;
    await assert.rejects(f.service.deliverQueuedInbound(f.item));
    assert.equal(f.creates, 0);
    assert.equal(f.updates.length, 0);
  }
  const f = await recoveredDocumentFixture();
  f.service.assertTaggedHistoryMediaStored = async () => {
    throw Error('actual object missing or SHA changed');
  };
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /object missing/);
  assert.equal(f.updates.length, 0);
});

test('destination rotation or lease loss cannot finish a cached document reconciliation', async () => {
  const f = await recoveredDocumentFixture();
  f.service.assertTaggedHistoryMediaStored = async () => {
    const rows = f.rows;
    rows[0].content = 'changed';
    f.rows = rows;
    return new Set(['WAID:A']);
  };
  await assert.rejects(f.service.deliverQueuedInbound(f.item), /ChangedDuringConfirmation/);
  assert.equal(f.updates.length, 0);
  assert.equal(f.creates, 0);
  const next = await recoveredDocumentFixture();
  next.service.inboundStore.bindInbox = async () => false;
  await assert.rejects(next.service.deliverQueuedInbound(next.item), /DestinationChanged/);
  assert.equal(next.physical, 0);
  assert.equal(next.updates.length, 0);
});

test('existing document reaches only the official leased queue finish; lost finish lease remains pending', async () => {
  for (const finishAllowed of [true, false]) {
    const f = await recoveredDocumentFixture();
    let owner = '',
      finishCalls = 0,
      state = 'pending';
    const payloadHash = f.item.payloadHash;
    const store: any = {
      enqueue: async () => f.item,
      claim: async (_id: string, lease: string) => {
        owner = lease;
        return true;
      },
      renew: async () => true,
      finish: async (_id: string, lease: string, ack: any) => {
        assert.equal(lease, owner);
        assert.equal(f.physical, 1);
        assert.equal(ack.id, 9);
        finishCalls++;
        if (finishAllowed) state = 'confirmed';
        return finishAllowed;
      },
      defer: async (_id: string, lease: string) => {
        assert.equal(lease, owner);
        state = 'pending';
      },
      due: async () => [],
    };
    f.service.inboundStore.bindInbox = async (_id: string, lease: string) => lease === owner;
    const queue = new ChatwootInboundQueue(store, (item) => f.service.deliverQueuedInbound(item));
    const result = await queue.submit(f.item);
    await queue.stop();
    assert.equal(finishCalls, 1);
    assert.equal(state, finishAllowed ? 'confirmed' : 'pending');
    assert.equal(result?.id, finishAllowed ? 9 : undefined);
    assert.equal(f.item.payloadHash, payloadHash);
    assert.equal(f.creates, 0);
  }
});

 test('pre-upgrade stored group prefix is confirmed read-only without a duplicate POST or body rewrite', async () => {
  const f = fixture();
  f.rows = [{ ...f.owner(), content: '**sender:**\n\nsynthetic' }];
  await f.service.deliverQueuedInbound(f.item);
  assert.equal(f.creates, 0);
  assert.equal(f.updates.length, 1);
  assert.equal(f.rows[0].content, '**sender:**\n\nsynthetic');
});
