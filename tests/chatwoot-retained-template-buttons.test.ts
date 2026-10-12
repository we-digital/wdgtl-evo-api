import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import axios from 'axios';
import { proto } from 'baileys';

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { prepareCachedRecoveryMedia } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import {
  retainedHistoryMedia,
  retainedTemplate,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';
import { retainedTemplateBytes, retainedTemplateFixtures } from './fixtures/retained-template-buttons';

for (const [index, message] of retainedTemplateFixtures().entries()) {
  test(`typed template ${index} retains full native protobuf, visible caption and labels without actions`, async () => {
    const native = {
      id: `db-${index}`,
      instanceId: 'synthetic-owner',
      messageTimestamp: 1700000000,
      pushName: 'Synthetic author',
      key: { id: `native-${index}`, remoteJid: '628111111111@s.whatsapp.net', fromMe: index % 2 === 0 },
      messageType: 'templateMessage',
      message,
    };
    const before = structuredClone(native);
    const decoded = proto.Message.decode(proto.Message.encode(proto.Message.fromObject(message)).finish());
    assert.ok(decoded.templateMessage);
    assert.equal(classifyCachedHistoryRecord(native, false), 'ordinary');
    const result = retainedTemplate(message);
    const expectedText = [
      'full original body\nsecond line\nOriginal footer\noriginal image caption\nReply 0\nReply 1',
      'Original title\nfull original body\nsecond line\nOriginal footer\nLink 0: https://example.test/0\nLink 1: https://example.test/1\nReply 2',
      'full original CTA body\nsecond line\noriginal image caption\nCTA 0: https://example.test/0\nCTA 1: https://example.test/1',
      'full original CTA body\nsecond line\noriginal image caption\nOriginal footer\nCTA 0: https://example.test/0\nCTA 1: https://example.test/1',
    ];
    assert.equal(result.text, expectedText[index]);
    assert.equal(
      chatwootImport.getContentMessage(
        { getConversationMessage: () => assert.fail('No alternate renderer') } as any,
        native as any,
        true,
      ),
      result.text,
    );
    const template: any = message.templateMessage;
    if (template.hydratedTemplate) {
      const h = template.hydratedTemplate;
      assert.deepEqual(result.metadata.hydrated_template, h);
      for (const text of [h.hydratedContentText, h.hydratedFooterText, h.hydratedTitleText].filter(Boolean))
        assert.ok(result.text.includes(text));
      for (const button of h.hydratedButtons)
        assert.ok(
          result.text.includes(
            button.quickReplyButton?.displayText || `${button.urlButton.displayText}: ${button.urlButton.url}`,
          ),
        );
    } else {
      const i = template.interactiveMessageTemplate;
      assert.deepEqual(result.metadata.native_flow, i.nativeFlowMessage);
      assert.deepEqual(result.metadata.header, i.header);
      assert.deepEqual(result.metadata.footer, i.footer);
      for (const button of i.nativeFlowMessage.buttons) {
        const b = JSON.parse(button.buttonParamsJson);
        assert.ok(result.text.includes(`${b.display_text}: ${b.url}`));
      }
    }
    const cached = await prepareCachedRecoveryMedia(
      [native as any],
      async () =>
        ({
          messageId: native.id,
          instanceId: native.instanceId,
          type: 'imageMessage',
          mimetype: 'image/jpeg',
          fileName: `synthetic-owner/${native.key.remoteJid}/${native.key.id}/imageMessage/image.jpg`,
        }) as any,
      async () => retainedTemplateBytes,
    );
    if (result.image) {
      assert.deepEqual(retainedHistoryMedia(native as any)?.descriptor, result.image);
      assert.ok(result.text.includes(result.image.caption));
      assert.equal(
        cached.get(native.id)?.descriptor.digest.toString('hex'),
        createHash('sha256').update(retainedTemplateBytes).digest('hex'),
      );
    } else assert.equal(cached.size, 0);
    assert.deepEqual(native, before);
    if (result.image) {
      await assert.rejects(
        () =>
          prepareCachedRecoveryMedia(
            [native as any],
            async () =>
              ({
                messageId: native.id,
                instanceId: 'foreign-owner',
                type: 'imageMessage',
                mimetype: 'image/jpeg',
                fileName: `foreign-owner/${native.key.remoteJid}/${native.key.id}/imageMessage/image.jpg`,
              }) as any,
            async () => retainedTemplateBytes,
          ),
        /authority_unavailable/,
      );
      await assert.rejects(
        () =>
          prepareCachedRecoveryMedia(
            [native as any],
            async () =>
              ({
                messageId: native.id,
                instanceId: native.instanceId,
                type: 'imageMessage',
                mimetype: 'image/jpeg',
                fileName: `synthetic-owner/${native.key.remoteJid}/${native.key.id}/imageMessage/image.jpg`,
              }) as any,
            async () => Buffer.from('wrong bytes'),
          ),
        /bytes_mismatch/,
      );
    }
  });
}

const invalid: [string, (body: any) => void, number][] = [
  ['duplicate zero indexes', (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[1].index = 0), 0],
  ['negative index', (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[0].index = -1), 0],
  ['foreign template id', (b) => (b.templateMessage.hydratedTemplate.templateId = 'foreign'), 0],
  [
    'hidden quick action',
    (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[0].quickReplyButton.action = 'execute'),
    0,
  ],
  [
    'two button types',
    (b) =>
      (b.templateMessage.hydratedTemplate.hydratedButtons[0].urlButton = {
        url: 'https://example.test',
        displayText: 'hidden',
      }),
    0,
  ],
  ['bad image digest', (b) => (b.templateMessage.hydratedTemplate.imageMessage.fileSha256 = 'malformed'), 0],
  [
    'credentialed URL',
    (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[0].urlButton.url = 'https://user:secret@example.test'),
    1,
  ],
  [
    'javascript URL',
    (b) => (b.templateMessage.hydratedTemplate.hydratedButtons[0].urlButton.url = 'javascript:alert(1)'),
    1,
  ],
  ['unknown primary body', (b) => (b.conversation = 'competing body'), 1],
  [
    'four CTAs',
    (b) =>
      b.templateMessage.interactiveMessageTemplate.nativeFlowMessage.buttons.push(
        ...structuredClone(b.templateMessage.interactiveMessageTemplate.nativeFlowMessage.buttons),
      ),
    2,
  ],
  [
    'non URL action',
    (b) => (b.templateMessage.interactiveMessageTemplate.nativeFlowMessage.buttons[1].name = 'call'),
    2,
  ],
  [
    'invalid second JSON',
    (b) => (b.templateMessage.interactiveMessageTemplate.nativeFlowMessage.buttons[1].buttonParamsJson = '{'),
    2,
  ],
  [
    'unknown second CTA field',
    (b) => {
      const f = b.templateMessage.interactiveMessageTemplate.nativeFlowMessage;
      const x = JSON.parse(f.buttons[1].buttonParamsJson);
      x.unknown = 'action';
      f.buttons[1].buttonParamsJson = JSON.stringify(x);
    },
    2,
  ],
  ['foreign video header', (b) => (b.templateMessage.interactiveMessageTemplate.header.videoMessage = {}), 2],
];
for (const [name, mutate, index] of invalid)
  test(`holds ${name}`, () => {
    const body = structuredClone(retainedTemplateFixtures()[index]);
    mutate(body);
    assert.throws(() => retainedTemplate(body));
    assert.throws(() => classifyCachedHistoryRecord({ messageType: 'templateMessage', message: body }, false));
  });

test('literal mixed-button plaintext templates preserve native identity, direction, author, date and full stock SQL content', async (t) => {
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Server construction is replaced before loading the literal service.
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const originalPool = postgresClient.getChatwootConnection;
  const originalRequest = axios.request;
  postgresClient.getChatwootConnection = (() => ({ query: async () => ({ rows: [] }) })) as any;
  axios.request = (async () => assert.fail('No HTTP/provider requests in this synthetic path')) as any;
  t.after(() => {
    postgresClient.getChatwootConnection = originalPool;
    axios.request = originalRequest;
  });
  const service = Object.create(ChatwootService.prototype) as any;
  let rows = [false, true].map((outgoing) => ({
    id: `db-${outgoing}`,
    instanceId: 'synthetic-instance',
    messageType: 'templateMessage',
    messageTimestamp: 1700000000,
    pushName: 'Synthetic author',
    key: { id: `native-${outgoing}`, remoteJid: '628111111111@s.whatsapp.net', fromMe: outgoing },
    message: structuredClone(retainedTemplateFixtures()[1]),
  }));
  const before = structuredClone(rows);
  const persisted = new Map<string, any>();
  let guards = 0;
  const provider = { accountId: '1', importMessages: true, enabled: true, nameInbox: 'synthetic', token: 'synthetic' };
  service.isImportHistoryAvailable = () => true;
  service.getProvider = async () => provider;
  service.getStoredHistoryRecoveryInbox = async () => ({ id: 99 });
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: false }) };
  service.resolvePhoneJidForLid = async () => null;
  service.readRecoveryMedia = async () => assert.fail('No native/provider download for ordinary location/list');
  service.readCachedRecoveryObject = async () => assert.fail('No storage download for ordinary location/list');
  service.getGroupIdentityNames = async () => new Map();
  service.waMonitor = { waInstances: {} };
  service.pgClient = { query: async () => ({ rows: [] }) };
  service.prismaRepository = {
    message: {
      findMany: async ({ where }: any) => {
        assert.equal(where.Instance.name, 'synthetic');
        return rows;
      },
    },
    messageUpdate: { findMany: async () => [] },
    media: { findFirst: async () => null },
  };
  const methods = [
    'activateHistorySourceGuards',
    'reconcileOutboundHistoryBindings',
    'getVerifiedRecoverySourceIds',
    'reconcileProviderHistoryEdits',
    'getChatwootUser',
    'getExistingSourceIds',
    'selectOrCreateFksFromChatwoot',
    'insertHistoryMessagesSerialized',
  ] as const;
  const originals = methods.map((name) => (chatwootImport as any)[name]);
  t.after(() =>
    methods.forEach((name, i) => {
      (chatwootImport as any)[name] = originals[i];
    }),
  );
  chatwootImport.activateHistorySourceGuards = async (ids: string[], inbox: number) => {
    assert.equal(inbox, 99);
    assert.equal(ids.length, 2);
    guards++;
  };
  chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
  chatwootImport.reconcileProviderHistoryEdits = async () => new Map();
  chatwootImport.getVerifiedRecoverySourceIds = async (requested: any[], inbox: number) => {
    assert.equal(inbox, 99);
    return new Set(requested.map((r) => `WAID:${r.key.id}`).filter((id) => persisted.has(id)));
  };
  chatwootImport.getExistingSourceIds = async () => new Set(persisted.keys());
  (chatwootImport as any).getChatwootUser = async () => ({ user_id: '7', user_type: 'User' });
  chatwootImport.selectOrCreateFksFromChatwoot = async (_provider, inbox, _times, byIdentity) => {
    assert.equal(inbox.id, 99);
    assert.deepEqual([...byIdentity.keys()], ['628111111111@s.whatsapp.net']);
    return new Map([
      [
        '628111111111@s.whatsapp.net',
        { identity_key: '628111111111@s.whatsapp.net', contact_id: '5', conversation_id: '123' },
      ],
    ]) as any;
  };
  (chatwootImport as any).insertHistoryMessagesSerialized = async (statements: any[], scope: any) => {
    assert.ok(guards > 0);
    assert.deepEqual(scope, {
      accountId: 1,
      inboxId: 99,
      peers: ['628111111111@s.whatsapp.net'],
      conversationIds: [123],
    });
    let count = 0;
    for (const statement of statements) {
      assert.match(statement.sql, /INSERT INTO messages/);
      assert.match(statement.sql, /FALSE/);
      for (let i = 2; i < statement.params.length; i += 8) {
        const [content, conversationId, direction, senderType, senderId, sourceId, epoch, attributes] =
          statement.params.slice(i, i + 8);
        assert.equal(conversationId, '123');
        assert.equal(epoch, 1700000000);
        const native = rows.find((row) => `WAID:${row.key.id}` === sourceId)!;
        assert.deepEqual(JSON.parse(attributes), {
          provider_history_template: retainedTemplate(native.message).metadata,
        });
        persisted.set(sourceId, { content, direction, senderType, senderId, attributes });
        count++;
      }
    }
    return count;
  };
  const request = () => ({
    contractVersion: '2026-08-28',
    dryRun: false,
    scope: 'direct',
    unresolvedLidMode: 'skip',
    recoveryMode: 'standard',
    refreshLidMappings: false,
    expectedDestinationKey: 'chatwoot:1:99',
    expectedInboxId: 99,
    messages: rows.map((message) => ({
      message: structuredClone(message),
      sourceId: `WAID:${message.key.id}`,
      expectedDirection: message.key.fromMe ? 'outgoing' : 'incoming',
    })),
  });
  const result = await service.syncStoredHistoryRecoveryBatch(
    { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
    request(),
  );
  assert.equal(result.importedMessages, 2);
  assert.equal(result.placeholderMessages, 0);
  assert.equal(
    result.outcomes.every((outcome: any) => outcome.status === 'imported'),
    true,
  );
  for (const native of rows) {
    const saved = persisted.get(`WAID:${native.key.id}`);
    assert.equal(saved.direction, native.key.fromMe ? '1' : '0');
    assert.equal(saved.senderType, native.key.fromMe ? 'User' : 'Contact');
    assert.equal(saved.senderId, native.key.fromMe ? '7' : '5');
    assert.equal(saved.content, retainedTemplate(native.message).text);
  }
  assert.deepEqual(rows, before);
  const repeat = await service.syncStoredHistoryRecoveryBatch(
    { instanceName: 'synthetic', instanceId: 'synthetic-instance' },
    request(),
  );
  assert.equal(repeat.importedMessages, 0);
  assert.equal(persisted.size, 2);
  const foreign = request();
  foreign.expectedInboxId = 98;
  await assert.rejects(service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, foreign), (error: any) =>
    JSON.stringify(error).includes('destination changed'),
  );
  const wrongDirection = request();
  wrongDirection.messages[0].expectedDirection = 'outgoing';
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, wrongDirection),
    (error: any) => JSON.stringify(error).includes('identity does not match'),
  );
  const stale = request();
  rows = rows.map((r, i) => (i === 0 ? { ...r, messageTimestamp: 1700000001 } : r));
  await assert.rejects(service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, stale), (error: any) =>
    JSON.stringify(error).includes('source version changed'),
  );
  assert.equal(persisted.size, 2);
  (rows[0].message as any).templateMessage.hydratedTemplate.hydratedButtons[0].urlButton.url = 'javascript:bad';
  const previousGuards = guards;
  await assert.rejects(
    service.syncStoredHistoryRecoveryBatch({ instanceName: 'synthetic' }, request()),
    /Retained template content is unsupported/,
  );
  assert.equal(guards, previousGuards, 'Malformed subtype fails before source guard/write admission');
  assert.equal(persisted.size, 2);
});
