import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import axios from 'axios';

test('sendAttachment excludes signed URL metadata and retains the validated response MIME', async (t) => {
  const serverModulePath = require.resolve('../src/api/server.module.ts');
  const previousServerModule = require.cache[serverModulePath];
  require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  t.after(() => {
    if (previousServerModule) require.cache[serverModulePath] = previousServerModule;
    else delete require.cache[serverModulePath];
  });

  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service = Object.create(ChatwootService.prototype) as InstanceType<typeof ChatwootService>;
  const sentMedia: Array<{ fileName?: string; mimetype?: string }> = [];
  const waInstance = {
    mediaMessage: async (data: { fileName?: string; mimetype?: string }) => {
      sentMedia.push(data);
      return { key: { id: 'planned-waid' } };
    },
  };

  mock.method(axios, 'get', async () => ({ headers: { 'content-type': 'application/pdf; charset=binary' } }));
  mock.method(axios, 'post', async () => ({}));

  for (const mediaUrl of [
    'https://cdn.example.test/download?signature=QUERYSECRET',
    'https://cdn.example.test/download#fragment/PATHFRAGMENTSECRET',
    'https://cdn.example.test/archive.unknown?signature=QUERYSECRET#FRAGMENTSECRET',
  ]) {
    await service.sendAttachment(waInstance, '628123@s.whatsapp.net', mediaUrl);
  }

  const sentMetadata = sentMedia.map(({ fileName, mimetype }) => ({ fileName, mimetype }));
  assert.deepEqual(sentMetadata, [
    { fileName: 'download', mimetype: 'application/pdf' },
    { fileName: 'download', mimetype: 'application/pdf' },
    { fileName: 'archive.unknown', mimetype: 'application/pdf' },
  ]);
  assert.doesNotMatch(JSON.stringify(sentMetadata), /QUERYSECRET|PATHFRAGMENTSECRET|FRAGMENTSECRET/);
});
