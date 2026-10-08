import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import axios from 'axios';

import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';

import {
  readRetainedChatwootGroupVideo,
  retainedVideoProxyUrl,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-retained-chatwoot-video';

const bytes = Buffer.from('synthetic video bytes');
const target = {
  id: 'native-target',
  instanceId: 'target-instance',
  messageType: 'videoMessage',
  messageTimestamp: 1700000000,
  key: { id: 'native-source', remoteJid: '120363123456@g.us', fromMe: false },
  message: {
    videoMessage: {
      mimetype: 'video/mp4',
      fileLength: bytes.length,
      fileSha256: createHash('sha256').update(bytes).digest('base64'),
      caption: 'target caption',
    },
  },
} as any;
const native = { ...target, id: 'native-copy', instanceId: 'copy-instance', key: { ...target.key, fromMe: true } };
const copy = {
  id: 101,
  account_id: 1,
  inbox_id: 39,
  display_id: 22,
  source_id: 'WAID:native-source',
  message_type: 1,
  private: false,
  created_at_epoch: 1700000013,
  peer: target.key.remoteJid,
  instance_id: native.instanceId,
  attachment_id: 202,
  blob_id: '303',
  byte_size: String(bytes.length),
  content_type: 'video/mp4',
};
const payload = [
  {
    ...copy,
    conversation_id: copy.display_id,
    created_at: copy.created_at_epoch,
    attachments: [
      {
        id: copy.attachment_id,
        message_id: copy.id,
        account_id: copy.account_id,
        file_type: 'video',
        content_type: 'video/mp4',
        file_size: bytes.length,
        download_url: 'https://cw.example/rails/active_storage/blobs/proxy/signed/video.mp4',
      },
    ],
  },
];

test('native embedded digest authorizes CW copy without native Media and preserves target direction and caption', async () => {
  const before = JSON.stringify(target);
  assert.deepEqual(
    await readRetainedChatwootGroupVideo(target, [native], [copy], 1, async (retained, size) => {
      assert.equal(retained.id, 101);
      assert.equal(size, bytes.length);
      return bytes;
    }),
    bytes,
  );
  assert.equal(JSON.stringify(target), before);
  assert.match(retainedVideoProxyUrl(copy, payload, 'https://cw.example'), /\/blobs\/proxy\//);
});

test('wrong native identity, time, digest or MIME refuses before any object read', async () => {
  for (const altered of [
    { ...native, key: { ...native.key, remoteJid: '120363999999@g.us' } },
    { ...native, key: { ...native.key, id: 'foreign-source' } },
    { ...native, messageTimestamp: 0 },
    {
      ...native,
      message: { videoMessage: { ...native.message.videoMessage, fileSha256: Buffer.alloc(32).toString('base64') } },
    },
    { ...native, message: { videoMessage: { ...native.message.videoMessage, mimetype: 'image/jpeg' } } },
  ])
    await assert.rejects(
      readRetainedChatwootGroupVideo(target, [altered], [copy], 1, async () => {
        assert.fail('unverified read');
      }),
    );
});

test('foreign account, direction, peer, source or size refuses', async () => {
  for (const change of [
    { account_id: 2 },
    { message_type: 0 },
    { private: true },
    { peer: 'different@g.us' },
    { source_id: 'WAID:foreign' },
    { byte_size: '999' },
    { content_type: 'image/jpeg' },
  ])
    await assert.rejects(
      readRetainedChatwootGroupVideo(target, [native], [{ ...copy, ...change }], 1, async () => {
        assert.fail('unverified read');
      }),
    );
  const conflictingNative = {
    ...native,
    instanceId: 'second-instance',
    key: { ...native.key, fromMe: false },
  };
  await assert.rejects(
    readRetainedChatwootGroupVideo(
      target,
      [native, conflictingNative],
      [copy, { ...copy, id: 102, inbox_id: 40, instance_id: 'second-instance' }],
      1,
      async () => {
        assert.fail('all copies must be verified before read');
      },
    ),
  );
});

test('eleven native copies with observed per-inbox timestamp offsets and duplicate rows reuse only verified bytes', async () => {
  const offsets = [-8, -8, -8, -3, -29, -2, -8, -8, -8, -8, 0];
  const instances = [0, 1, 2, 3, 3, 4, 4, 5, 6, 7, 8];
  const natives = offsets.map((offset, index) => ({
    ...native,
    id: `synthetic-copy-${index}`,
    instanceId: `synthetic-instance-${instances[index]}`,
    messageTimestamp: target.messageTimestamp + offset,
    key: { ...native.key, fromMe: instances[index] === 3 },
  }));
  const copies = Array.from({ length: 8 }, (_, index) => ({
    ...copy,
    id: 500 + index,
    inbox_id: 600 + index,
    attachment_id: 700 + index,
    instance_id: `synthetic-instance-${index}`,
    message_type: index === 3 ? 1 : 0,
  }));
  copies.push({ ...copies[0], id: 1500, attachment_id: 1700 });
  const before = JSON.stringify(target);
  let reads = 0;
  assert.deepEqual(
    await readRetainedChatwootGroupVideo(target, natives, copies, 1, async () => {
      reads++;
      return bytes;
    }),
    bytes,
  );
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(target), before, 'target timestamp, direction and caption remain unchanged');
});

test('every duplicate native and CW copy must agree with the authenticated byte authority', async () => {
  for (const changed of [
    { ...native, key: { ...native.key, fromMe: false } },
    { ...native, messageTimestamp: -1 },
    {
      ...native,
      message: { videoMessage: { ...native.message.videoMessage, fileSha256: Buffer.alloc(32).toString('base64') } },
    },
    { ...native, messageType: 'unknown' },
  ])
    await assert.rejects(
      readRetainedChatwootGroupVideo(target, [native, changed], [copy], 1, async () => {
        assert.fail('conflicting duplicate must refuse before byte read');
      }),
    );
  await assert.rejects(
    readRetainedChatwootGroupVideo(target, [native], [copy, { ...copy, id: 102, message_type: 0 }], 1, async () => {
      assert.fail('conflicting retained message must refuse');
    }),
  );
});

test('unknown digest, corrupt bytes, unavailable or forbidden object never becomes successful recovery', async () => {
  await assert.rejects(
    readRetainedChatwootGroupVideo(
      { ...target, message: { videoMessage: { mimetype: 'video/mp4' } } },
      [native],
      [copy],
      1,
      async () => bytes,
    ),
  );
  await assert.rejects(
    readRetainedChatwootGroupVideo(target, [native], [copy], 1, async () => Buffer.alloc(bytes.length)),
    /bytes_mismatch/,
  );
  await assert.rejects(
    readRetainedChatwootGroupVideo(target, [native], [copy], 1, async () => {
      throw new Error('HTTP403');
    }),
    /HTTP403/,
  );
  assert.equal(await readRetainedChatwootGroupVideo(target, [native], [], 1, async () => bytes), null);
  await assert.rejects(
    readRetainedChatwootGroupVideo(target, [native], Array(26).fill(copy), 1, async () => bytes),
    /bound/,
  );
});

test('rotated API snapshot, redirected or foreign URLs cannot authorize bytes', () => {
  for (const change of [
    { source_id: 'WAID:another' },
    { message_type: 0 },
    { created_at: 1700000020 },
    { private: true },
  ])
    assert.throws(() => retainedVideoProxyUrl(copy, [{ ...payload[0], ...change }], 'https://cw.example'));
  for (const url of [
    'https://attacker.example/file',
    'http://cw.example/rails/active_storage/blobs/proxy/signed/video.mp4',
    'https://cw.example/rails/active_storage/blobs/redirect/signed/video.mp4',
    'https://username:password@cw.example/rails/active_storage/blobs/proxy/signed/video.mp4',
  ])
    assert.throws(() =>
      retainedVideoProxyUrl(
        copy,
        [{ ...payload[0], attachments: [{ ...payload[0].attachments[0], download_url: url }] }],
        'https://cw.example',
      ),
    );
});

test('literal service reuses proxy bytes and rejects native, CW or route rotation before import', async (t) => {
  const modulePath = require.resolve('../src/api/server.module.ts');
  const previousModule = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: new Proxy({}, { get: () => ({}) }),
    children: [],
    paths: [],
  } as NodeModule;
  const originalAxios = axios.request;
  const originalPool = postgresClient.getChatwootConnection;
  t.after(() => {
    axios.request = originalAxios;
    postgresClient.getChatwootConnection = originalPool;
    if (previousModule) require.cache[modulePath] = previousModule;
    else delete require.cache[modulePath];
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Install inert server fixture before loading service.
  const { ChatwootService } = require('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const service = Object.create(ChatwootService.prototype) as any;
  service.configService = {
    get: () => ({ TRUSTED_BASE_URL: 'https://cw.example', NATIVE_BRIDGE_TOKEN: 'synthetic-bridge' }),
  };
  const provider = { accountId: '1', url: 'https://cw.example', token: 'synthetic-api' };
  let nativeReads = 0,
    cwReads = 0,
    apiReads = 0,
    proxyReads = 0;
  let rotation = '';
  service.prismaRepository = {
    message: {
      findMany: async ({ where }: any) => {
        nativeReads++;
        if (nativeReads === 1) {
          assert.equal(where.messageTimestamp, undefined, 'receive timestamp must not hide a retained byte authority');
          assert.equal(where.messageType, undefined, 'contradictory same-source envelopes must remain visible');
        }
        if (nativeReads > 1 && rotation === 'native') return [{ ...native, status: 'EDITED' }];
        if (nativeReads > 1 && rotation === 'native_add') return [native, { ...native, id: 'new-native-copy' }];
        return [native];
      },
    },
    chatwoot: { findMany: async () => (rotation === 'route' ? [] : [{ instanceId: native.instanceId }]) },
  };
  postgresClient.getChatwootConnection = () =>
    ({
      query: async (sql: string, params: any[]) => {
        assert.match(sql, /m\.source_id=ANY/);
        assert.match(sql, /b\.provider='whatsapp'/);
        assert.deepEqual(params, [
          1,
          ['native-source', 'WAID:native-source'],
          target.key.remoteJid,
          [native.instanceId],
        ]);
        cwReads++;
        if (cwReads > 1 && rotation === 'cw') return { rows: [{ ...copy, blob_id: 'rotated-blob' }] };
        if (cwReads > 1 && rotation === 'cw_add') return { rows: [copy, { ...copy, id: 102 }] };
        return { rows: [copy] };
      },
    }) as any;
  axios.request = (async (request: any) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.maxRedirects, 0);
    assert.equal(request.timeout, 60_000);
    if (request.responseType === 'arraybuffer') {
      proxyReads++;
      assert.equal(request.maxContentLength, bytes.length);
      assert.equal(request.headers, undefined, 'privileged API headers do not accompany signed proxy read');
      assert.equal(request.url, payload[0].attachments[0].download_url);
      return { data: bytes, headers: { 'content-type': 'video/mp4' } };
    }
    apiReads++;
    assert.equal(request.url, 'https://cw.example/api/v1/accounts/1/conversations/22/messages');
    assert.deepEqual(request.params, { source_ids: ['WAID:native-source'] });
    return { data: { payload } };
  }) as any;
  assert.deepEqual(await service.readRecoveryChatwootVideo(target, provider, [native.instanceId]), bytes);
  assert.equal(apiReads, 1);
  assert.equal(proxyReads, 1);
  assert.equal(nativeReads, 2);
  assert.equal(cwReads, 2);
  for (rotation of ['native', 'native_add', 'cw', 'cw_add', 'route']) {
    nativeReads = 0;
    cwReads = 0;
    await assert.rejects(service.readRecoveryChatwootVideo(target, provider, [native.instanceId]), /source_rotated/);
  }
});

test('stored PDF, image and audio reuse authenticates bytes without copying receive time, direction or caption', async () => {
  for (const [type, mime, fileType] of [
    ['documentMessage', 'application/pdf', 'file'],
    ['imageMessage', 'image/jpeg', 'image'],
    ['audioMessage', 'audio/ogg', 'audio'],
    ['stickerMessage', 'image/webp', 'image'],
  ]) {
    const source = {
      ...target,
      messageType: type,
      message: { [type]: { ...target.message.videoMessage, mimetype: mime } },
    };
    const other = {
      ...source,
      id: 'other',
      instanceId: native.instanceId,
      messageTimestamp: target.messageTimestamp + 29,
      key: native.key,
    };
    const stored = { ...copy, content_type: mime };
    const before = JSON.stringify(source);
    assert.deepEqual(await readRetainedChatwootGroupVideo(source, [other], [stored], 1, async () => bytes), bytes);
    assert.equal(JSON.stringify(source), before);
    const api = [
      { ...payload[0], attachments: [{ ...payload[0].attachments[0], content_type: mime, file_type: fileType }] },
    ];
    assert.match(retainedVideoProxyUrl(stored, api, 'https://cw.example'), /blobs\/proxy/);
    await assert.rejects(
      readRetainedChatwootGroupVideo(source, [other], [{ ...stored, content_type: 'foreign/mime' }], 1, async () =>
        assert.fail('foreign MIME read'),
      ),
    );
    await assert.rejects(
      readRetainedChatwootGroupVideo(source, [other], [stored], 1, async () => Buffer.alloc(bytes.length)),
    );
  }
});

test('native generic Word MIME can reuse exact OOXML stored bytes without weakening SHA or size proof', async () => {
  const source = {
    ...target,
    messageType: 'documentMessage',
    message: { documentMessage: { ...target.message.videoMessage, mimetype: 'application/msword' } },
  };
  const other = { ...source, id: native.id, instanceId: native.instanceId, key: native.key };
  const stored = { ...copy, content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const before = JSON.stringify(source);
  assert.deepEqual(await readRetainedChatwootGroupVideo(source, [other], [stored], 1, async () => bytes), bytes);
  assert.equal(JSON.stringify(source), before);
  await assert.rejects(
    readRetainedChatwootGroupVideo(source, [other], [stored], 1, async () => Buffer.alloc(bytes.length)),
    /bytes_mismatch/,
  );
  await assert.rejects(
    readRetainedChatwootGroupVideo(source, [other], [{ ...stored, byte_size: String(bytes.length + 1) }], 1, async () =>
      assert.fail('wrong size read'),
    ),
    /digest_authority/,
  );
  await assert.rejects(
    readRetainedChatwootGroupVideo(source, [other], [{ ...stored, content_type: 'application/pdf' }], 1, async () =>
      assert.fail('unproved MIME read'),
    ),
    /digest_authority/,
  );
});
