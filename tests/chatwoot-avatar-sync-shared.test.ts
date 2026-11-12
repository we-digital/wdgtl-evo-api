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
