import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCachedHistoryRecord } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import { mixedFixture } from './fixtures/direct-mixed-album';

test('observed direct mixed header preserves existing complete children with receiver-owned nested LID and no writes', async () => {
  const f = mixedFixture(),
    before = structuredClone({ parent: f.parent, children: f.children, targets: f.targets });
  assert.equal(classifyCachedHistoryRecord(f.parent, false), 'album_container');
  const result = await f.run();
  await result.assertCurrent();
  const proof = result.proofs.get('WAID:album');
  assert.equal(proof.expectedImages, 3);
  assert.equal(proof.expectedVideos, 1);
  assert.equal(proof.childrenComplete, true);
  assert.equal(proof.directChildren.children.length, 4);
  assert.equal(proof.directChildren.existingPhysicalBytesClaimed, false);
  assert.ok(proof.directChildren.children.every((c: any) => c.nestedFromMe === true));
  assert.equal(JSON.stringify(proof).includes(f.owner.livePN), false);
  assert.equal(JSON.stringify(proof).includes(f.owner.liveLID), false);
  assert.deepEqual({ parent: f.parent, children: f.children, targets: f.targets }, before);
  assert.ok(f.queries.every((sql) => /^(SELECT|BEGIN READ ONLY|SET LOCAL|COMMIT)/.test(sql)));
});

const negatives: [string, (f: ReturnType<typeof mixedFixture>) => void][] = [
  [
    'wrong authenticated LID',
    (f) => {
      f.owner.liveLID = 'other@lid';
    },
  ],
  [
    'wrong registered PN',
    (f) => {
      f.owner.registeredPN = 'other@s.whatsapp.net';
    },
  ],
  [
    'wrong account',
    (f) => {
      f.owner.accountID = 2;
    },
  ],
  [
    'wrong receiving instance',
    (f) => {
      f.owner.instanceId = 'foreign';
    },
  ],
  [
    'wrong inbox',
    (f) => {
      f.owner.inboxID = 109;
    },
  ],
  [
    'group has no exception',
    (f) => {
      f.parent.key.remoteJid = 'group@g.us';
    },
  ],
  [
    'outgoing parent',
    (f) => {
      f.parent.key.fromMe = true;
    },
  ],
  [
    'missing child',
    (f) => {
      f.children.pop();
    },
  ],
  [
    'extra child',
    (f) => {
      f.children.push(structuredClone(f.children[0]));
    },
  ],
  [
    'wrong parent key',
    (f) => {
      f.children[0].message.messageContextInfo.messageAssociation.parentMessageKey.id = 'other';
    },
  ],
  [
    'wrong nested direction',
    (f) => {
      f.children[0].message.messageContextInfo.messageAssociation.parentMessageKey.fromMe = false;
    },
  ],
  [
    'wrong local child peer',
    (f) => {
      f.children[0].key.remoteJid = 'other@lid';
    },
  ],
  [
    'foreign child instance',
    (f) => {
      f.children[0].instanceId = 'foreign';
    },
  ],
  [
    'unknown nested key',
    (f) => {
      f.children[0].message.messageContextInfo.messageAssociation.parentMessageKey.unknown = true;
    },
  ],
  [
    'wrong child counts',
    (f) => {
      f.children[0].messageType = 'imageMessage';
    },
  ],
  [
    'foreign owner',
    (f) => {
      f.targets[0].message.account_id = 2;
    },
  ],
  [
    'foreign binding',
    (f) => {
      f.targets[0].binding.peer = 'other@lid';
    },
  ],
  [
    'caption changed',
    (f) => {
      f.targets[0].message.content = 'changed';
    },
  ],
  [
    'size changed',
    (f) => {
      f.targets[0].media[0].blob.byte_size = 99;
    },
  ],
  [
    'malformed SHA',
    (f) => {
      f.children[0].message.videoMessage.fileSha256 = 'bad';
    },
  ],
];
for (const [label, change] of negatives)
  test(label + ' refuses before bookkeeping', async () => {
    const f = mixedFixture();
    change(f);
    await assert.rejects(f.run());
  });
for (const [label, change] of [
  [
    'source version',
    (f: any) => {
      f.children[0].status = 'EDITED';
    },
  ],
  [
    'protected destination',
    (f: any) => {
      f.targets[0].message.created_at++;
    },
  ],
  [
    'authenticated owner',
    (f: any) => {
      f.owner.liveLID = 'other@lid';
    },
  ],
] as const)
  test(label + ' rotation refuses final ACK', async () => {
    const f = mixedFixture(),
      result = await f.run();
    change(f);
    await assert.rejects(result.assertCurrent());
  });

test('literal stock selected batch obtains receiving auth locally and only acknowledges a preserved mixed container', async (t) => {
  const modulePath = require.resolve('../src/api/server.module.ts'),
    previous = require.cache[modulePath];
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
  const { ChatwootService } = await import('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service');
  const { chatwootImport } = await import('../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper');
  const { postgresClient } = await import('../src/api/integrations/chatbot/chatwoot/libs/postgres.client');
  const f = mixedFixture(),
    service = Object.create(ChatwootService.prototype) as any;
  service.isImportHistoryAvailable = () => true;
  service.getProvider = async () => ({ accountId: '1', importMessages: true, enabled: true });
  service.getStoredHistoryRecoveryInbox = async () => ({ id: 108 });
  service.configService = { get: () => ({ PROVIDER_CONVERSATION_BINDINGS: false }) };
  service.prismaRepository = {
    message: f.repository,
    messageUpdate: { findMany: async () => [] },
    instance: { findUnique: async () => ({ id: 'owned', name: 'synthetic', ownerJid: f.owner.registeredPN }) },
  };
  let authReads = 0;
  service.waMonitor = {
    waInstances: {
      synthetic: {
        instanceId: 'owned',
        connectionStatus: { state: 'open' },
        baileysGetAuthState: async () => {
          authReads++;
          return { me: { id: f.owner.livePN, lid: f.owner.liveLID } };
        },
      },
    },
  };
  const names = [
    'activateHistorySourceGuards',
    'getVerifiedRecoverySourceIds',
    'reconcileOutboundHistoryBindings',
    'reconcileProviderHistoryEdits',
    'importHistoryMessages',
  ] as const;
  const saved = names.map((n) => chatwootImport[n]),
    oldPool = postgresClient.getChatwootConnection;
  t.after(() => {
    names.forEach((n, i) => {
      (chatwootImport as any)[n] = saved[i];
    });
    postgresClient.getChatwootConnection = oldPool;
  });
  postgresClient.getChatwootConnection = (() => ({ ...f.pool, query: async () => ({ rows: [] }) })) as any;
  chatwootImport.activateHistorySourceGuards = async (ids) => {
    assert.equal(ids.length, 0);
  };
  chatwootImport.getVerifiedRecoverySourceIds = async () => new Set();
  chatwootImport.reconcileOutboundHistoryBindings = async () => new Set();
  chatwootImport.reconcileProviderHistoryEdits = async () => new Map();
  chatwootImport.importHistoryMessages = async () => assert.fail('No content or provider import permitted');
  const before = structuredClone({ parent: f.parent, children: f.children, targets: f.targets });
  const response = await service.syncStoredHistoryRecoveryBatch(
    { instanceName: 'synthetic', instanceId: 'owned' },
    {
      contractVersion: '2026-08-28',
      dryRun: false,
      scope: 'all',
      unresolvedLidMode: 'skip',
      recoveryMode: 'maximize',
      refreshLidMappings: false,
      expectedInboxId: 108,
      expectedDestinationKey: 'chatwoot:1:108',
      messages: [{ sourceId: 'WAID:album', expectedDirection: 'incoming', message: structuredClone(f.parent) }],
    },
  );
  assert.equal(response.appliedMessages, 0);
  assert.equal(response.importedMessages, 0);
  assert.equal(response.outcomes[0].reason, 'preserved_unsupported_album_container');
  assert.equal(response.outcomes[0].albumPreservation.version, 4);
  assert.equal(response.outcomes[0].albumPreservation.directChildren.children.length, 4);
  assert.ok(authReads >= 3);
  assert.deepEqual({ parent: f.parent, children: f.children, targets: f.targets }, before);
});
