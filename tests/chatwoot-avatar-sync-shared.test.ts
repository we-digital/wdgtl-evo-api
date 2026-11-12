import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';

test('every ChatwootService shares one avatar queue per WhatsApp number', async () => {
  let fetches = 0;
  const waMonitor = {
    waInstances: {
      'shared-avatar-test': {
        peekProfilePictureForSync: async () => null,
        fetchProfilePictureForSync: async () => {
          fetches++;
          return { kind: 'none', source: 'whatsapp' };
        },
      },
    },
  };
  const cache = new Map<string, unknown>();
  const cacheService = {
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: unknown) => void cache.set(key, value),
    has: async (key: string) => cache.has(key),
    delete: async (key: string) => void cache.delete(key),
  };
  const make = () => {
    const service = new ChatwootService(
      waMonitor as any,
      { get: () => ({}) } as any,
      {} as any,
      cacheService as any,
    ) as any;
    service.logger = { info: () => undefined, warn: () => undefined, error: () => undefined, verbose: () => undefined };
    service.findAvatarContact = async () => ({ id: 7, hasAvatar: false });
    return service;
  };
  // One per channel (BaileysStartupService) and one for the API controller.
  const channel = make();
  const controller = make();
  const instance = { instanceName: 'shared-avatar-test', instanceId: 'i-1' };

  assert.equal(channel.enqueueAvatarSync(instance, { jid: '628111@s.whatsapp.net', lane: 'live', reason: 't' }), true);
  // The controller sees the same queue, and the same jid is not queued twice.
  assert.equal(
    controller.enqueueAvatarSync(instance, { jid: '628111@s.whatsapp.net', lane: 'backfill', reason: 't' }),
    true,
  );
  const queue = (ChatwootService as any).avatarQueues.get('shared-avatar-test');
  await queue.idle();
  assert.equal(fetches, 1);
  // The second request is answered by the first check's marker, without WhatsApp.
  assert.equal(controller.avatarSyncStatus(instance).whatsappFetches, 1);
  assert.equal(channel.avatarSyncStatus(instance).fresh, 1);
  queue.stop();
});

test('backfill can keep only recently active conversations, most recent first', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const service = new ChatwootService(
    {
      waInstances: {
        'recent-avatar-test': {
          instanceId: 'i-2',
          peekProfilePictureForSync: async () => null,
          fetchProfilePictureForSync: async () => ({ kind: 'none', source: 'whatsapp' }),
        },
      },
    } as any,
    { get: () => ({ IMPORT: { DATABASE: { CONNECTION: { URI: 'postgres://chatwoot' } } } }) } as any,
    { contact: { findMany: async () => [] } } as any,
    {
      get: async () => undefined,
      set: async () => undefined,
      has: async () => false,
      delete: async () => undefined,
    } as any,
  ) as any;
  service.logger = { info: () => undefined, warn: () => undefined, error: () => undefined, verbose: () => undefined };
  service.getProvider = async () => ({ accountId: '1' });
  service.getInbox = async () => ({ id: 58 });
  service.pgClient = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [{ id: 5, identifier: '120363000000000001@g.us', phone_number: null, has_avatar: false }] };
    },
  };
  const result = await service.avatarBackfill({ instanceName: 'recent-avatar-test' }, { activeWithinDays: 3 });
  assert.equal(result.dryRun, true);
  assert.equal(result.activeWithinDays, 3);
  assert.equal(result.groups, 1);
  assert.equal(queries[0].params[5], 3);
  assert.match(queries[0].sql, /act\.last_activity_at > now\(\) - \(\$6::int \* interval '1 day'\)/);
  assert.match(queries[0].sql, /ORDER BY act\.last_activity_at DESC NULLS LAST/);

  await service.avatarBackfill({ instanceName: 'recent-avatar-test' }, {});
  assert.equal(queries[1].params[5], null, 'no filter by default');
});

test('Chatwoot avatar requests need a signed webhook and land on their lane', async () => {
  const enqueued: any[] = [];
  const service = new ChatwootService(
    { waInstances: {} } as any,
    { get: () => ({}) } as any,
    {} as any,
    {} as any,
  ) as any;
  service.enqueueAvatarSync = (_instance: unknown, job: any) => (enqueued.push(job), true);
  const instance = { instanceName: 'requests-test' };
  const body = {
    event: 'contact_avatar_request',
    priority: 'open',
    contacts: [
      { id: 11, identifier: '628111@s.whatsapp.net', has_avatar: false },
      { id: 12, identifier: '120363000000000002@g.us', has_avatar: true },
      { id: 13, identifier: 'telegram:42', has_avatar: false },
    ],
  };
  await assert.rejects(service.receiveWebhook(instance, body, undefined), { status: 401 });
  const admission = { deliveryId: 'd', timestampSeconds: 1, receivedAt: new Date() };
  const result = await service.receiveWebhook(instance, body, admission);
  assert.deepEqual(result, { message: 'avatar_requested', queued: 2 });
  assert.deepEqual(
    enqueued.map((j) => [j.jid, j.lane, j.contactId, j.hasAvatar, j.viewed]),
    [
      ['628111@s.whatsapp.net', 'open', 11, false, true],
      ['120363000000000002@g.us', 'open', 12, true, false],
    ],
  );
  assert.deepEqual(await service.receiveWebhook(instance, { ...body, priority: 'all' }, admission), {
    message: 'avatar_request_ignored',
    queued: 0,
  });
});
