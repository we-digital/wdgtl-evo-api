import assert from 'node:assert/strict';
import test from 'node:test';

import { generateForwardMessageContent, proto } from 'baileys';

import {
  BaileysStartupService,
  GROUP_SENDER_KEY_RESET_INTERVAL_MS,
} from '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service';

const group = '120363000000000000@g.us';
const direct = '628111111111@s.whatsapp.net';
const source = () => ({ key: { id: 'SYNTHETIC-SOURCE', fromMe: false }, message: { conversation: 'synthetic' } });
function harness(enabled = true) {
  const events: string[] = [];
  const sends: any[] = [];
  const wa: any = Object.create(BaileysStartupService.prototype);
  wa.instance = { id: 'synthetic-instance', name: 'synthetic', wuid: direct };
  wa.groupSenderKeyRepairs = new WeakMap();
  wa.logger = { info() {}, debug() {}, error() {} };
  wa.configService = { get: () => ({ FORCE_GROUP_SENDER_KEY_REFRESH: enabled, SAVE_DATA: { NEW_MESSAGE: false } }) };
  const socket = () => ({
    repairGroupSenderKeyDistribution: async (jid: string) => {
      assert.equal(jid, group);
      events.push('full-repair');
      return { groupJid: group, participantCount: 2, deviceCount: 4, sessionCount: 4 };
    },
    authState: {
      keys: {
        set: async (data: any) => {
          assert.deepEqual(data, { 'sender-key-memory': { [group]: null } });
          events.push('cache-aware-reset');
        },
      },
    },
    sendMessage: async (jid: string, content: any, options: any) => {
      events.push('transport');
      sends.push({ jid, content, options });
      return { key: { id: options?.messageId || 'SYNTHETIC', remoteJid: jid, fromMe: true }, messageTimestamp: 1 };
    },
  });
  wa.client = socket();
  const options = {
    messageId: 'WDSYNTHETIC00000001',
    beforeTransport: async () => {
      events.push('fence');
    },
  };
  return { wa, events, sends, options, socket };
}

test('native group forward refreshes devices and sessions before fencing, retaining source and planned ID', async () => {
  const { wa, events, sends, options } = harness();
  const original = source();
  const before = JSON.stringify(original);
  const result = await wa.nativeForwardMessage(group, original, options);
  assert.deepEqual(events, ['full-repair', 'fence', 'transport']);
  assert.equal(sends[0].options.useCachedGroupMetadata, false);
  assert.equal(sends[0].options.messageId, options.messageId);
  assert.deepEqual(sends[0].content.forward, original);
  assert.equal(sends[0].content.force, true);
  assert.equal(result.key.id, options.messageId);
  assert.equal(JSON.stringify(original), before);
});

test('normal send and native forward share first and subsequent group recovery, reconnect repairs anew', async () => {
  const { wa, events, sends, options, socket } = harness();
  await wa.sendMessage(group, { conversation: 'synthetic' }, options);
  await wa.nativeForwardMessage(group, source(), options);
  wa.client = socket();
  await wa.nativeForwardMessage(group, source(), options);
  assert.deepEqual(events, [
    'full-repair',
    'fence',
    'transport',
    'cache-aware-reset',
    'fence',
    'transport',
    'full-repair',
    'fence',
    'transport',
  ]);
  assert.deepEqual(
    sends.map((s) => s.options.useCachedGroupMetadata),
    [false, true, false],
  );
});

test('the defense-in-depth sender-key reset runs at most once per interval per group and socket', async () => {
  const { wa, events, options, socket } = harness();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await wa.sendMessage(group, { conversation: 'synthetic' }, options);
    await wa.sendMessage(group, { conversation: 'synthetic' }, options);
    await wa.sendMessage(group, { conversation: 'synthetic' }, options);
    now += GROUP_SENDER_KEY_RESET_INTERVAL_MS;
    await wa.sendMessage(group, { conversation: 'synthetic' }, options);
    wa.client = socket();
    await wa.sendMessage(group, { conversation: 'synthetic' }, options);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(
    events.filter((event) => event !== 'fence' && event !== 'transport'),
    ['full-repair', 'cache-aware-reset', 'cache-aware-reset', 'full-repair'],
  );
});

for (const [jid, enabled] of [
  [direct, true],
  [group, false],
] as const) {
  test(`native forward preserves direct/disabled recovery contract: ${jid}, enabled=${enabled}`, async () => {
    const { wa, events, sends, options } = harness(enabled);
    await wa.nativeForwardMessage(jid, source(), options);
    assert.deepEqual(events, ['fence', 'transport']);
    assert.equal(sends[0].options.useCachedGroupMetadata, jid === group ? true : undefined);
  });
}

for (const failure of ['repair', 'fence', 'already-aborted', 'abort-during-repair', 'abort-during-fence']) {
  test(`native forward never sends after ${failure}`, async () => {
    const { wa, sends, options } = harness();
    const controller = new AbortController();
    if (failure === 'already-aborted') controller.abort();
    if (failure === 'repair')
      wa.client.repairGroupSenderKeyDistribution = async () => {
        throw new Error('repair failed');
      };
    if (failure === 'abort-during-repair')
      wa.client.repairGroupSenderKeyDistribution = async () => {
        controller.abort();
        return { groupJid: group, participantCount: 2, deviceCount: 4, sessionCount: 4 };
      };
    if (failure === 'fence')
      options.beforeTransport = async () => {
        throw new Error('fence failed');
      };
    if (failure === 'abort-during-fence')
      options.beforeTransport = async () => {
        controller.abort();
      };
    await assert.rejects(wa.nativeForwardMessage(group, source(), { ...options, signal: controller.signal }));
    assert.equal(sends.length, 0);
  });
}

test('failed preparation can recover on later admission; ambiguous socket failure is not replayed', async () => {
  const { wa, sends, options } = harness();
  const repair = wa.client.repairGroupSenderKeyDistribution;
  wa.client.repairGroupSenderKeyDistribution = async () => {
    throw new Error('repair unavailable');
  };
  await assert.rejects(wa.nativeForwardMessage(group, source(), options));
  wa.client.repairGroupSenderKeyDistribution = repair;
  await wa.nativeForwardMessage(group, source(), options);
  assert.equal(sends.length, 1);
  let calls = 0;
  wa.client.sendMessage = async () => {
    calls++;
    throw new Error('socket timeout after write');
  };
  await assert.rejects(wa.nativeForwardMessage(group, source(), options), /socket timeout/);
  assert.equal(calls, 1);
});

test('installed Baileys preserves stored JSON native image bytes and pointers through forward protobuf generation', () => {
  const bytes = Buffer.alloc(32, 7);
  const original = proto.Message.fromObject({
    imageMessage: {
      url: 'https://mmg.whatsapp.net/synthetic',
      directPath: '/synthetic',
      mimetype: 'image/jpeg',
      mediaKey: bytes,
      fileSha256: bytes,
      fileEncSha256: bytes,
      jpegThumbnail: Buffer.from([1, 2, 3]),
      fileLength: 72099,
      width: 640,
      height: 480,
    },
    messageContextInfo: { messageSecret: Buffer.alloc(32, 8) },
  }).toJSON();
  const before = JSON.stringify(original);
  const forwarded = generateForwardMessageContent(
    { key: { id: 'SOURCE', fromMe: false }, message: original } as any,
    true,
  );
  const encoded = proto.Message.decode(proto.Message.encode(forwarded).finish());
  assert.equal(Buffer.from(encoded.imageMessage.mediaKey).toString('hex'), bytes.toString('hex'));
  assert.equal(Buffer.from(encoded.imageMessage.fileSha256).toString('hex'), bytes.toString('hex'));
  assert.equal(Number(encoded.imageMessage.fileLength), 72099);
  assert.equal(encoded.imageMessage.directPath, '/synthetic');
  assert.equal(encoded.imageMessage.contextInfo.isForwarded, true);
  assert.equal(JSON.stringify(original), before);
});

test('real installed Signal reproduces linked-only readability and restored SKDM makes fresh primary readable', async () => {
  const { initAuthCreds } = await import('baileys');
  const { makeLibSignalRepository } = await import('baileys/lib/Signal/libsignal.js');
  const logger: any = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  };
  function auth() {
    const values = new Map<string, any>();
    return {
      creds: initAuthCreds(),
      keys: {
        get: async (type: string, ids: string[]) =>
          Object.fromEntries(ids.map((id) => [id, values.get(`${type}:${id}`)])),
        set: async (data: any) => {
          for (const [type, entries] of Object.entries(data))
            for (const [id, value] of Object.entries(entries)) values.set(`${type}:${id}`, value);
        },
        transaction: async (work: () => Promise<any>) => work(),
        isInTransaction: () => false,
      },
    } as any;
  }
  const senderAuth = auth();
  const sender = makeLibSignalRepository(senderAuth, logger);
  const linked = makeLibSignalRepository(auth(), logger);
  const primary = makeLibSignalRepository(auth(), logger);
  const authorJid = '628111111111:5@s.whatsapp.net';
  const warm = await sender.encryptGroupMessage({ group, meId: authorJid, data: Buffer.from('warmup') });
  const distribute = (receiver: typeof linked, bytes: Uint8Array) =>
    receiver.processSenderKeyDistributionMessage({
      authorJid,
      item: { groupId: group, axolotlSenderKeyDistributionMessage: bytes },
    });
  await distribute(linked, warm.senderKeyDistributionMessage);
  // Sender remembers the primary's old identity; linked retains its valid key.
  await senderAuth.keys.set({ 'sender-key-memory': { [group]: { primary: true, linked: true } } });
  const { wa, options } = harness(false);
  wa.client.authState = senderAuth;
  let ciphertext: Uint8Array;
  wa.client.repairGroupSenderKeyDistribution = async () => {
    await senderAuth.keys.set({ 'sender-key-memory': { [group]: null } });
    return { groupJid: group, participantCount: 2, deviceCount: 2, sessionCount: 2 };
  };
  wa.client.sendMessage = async (_jid: string, content: any) => {
    const message = generateForwardMessageContent(content.forward, content.force);
    const encrypted = await sender.encryptGroupMessage({
      group,
      meId: authorJid,
      data: proto.Message.encode(message).finish(),
    });
    const memory = (await senderAuth.keys.get('sender-key-memory', [group]))[group] || {};
    for (const [name, receiver] of [
      ['primary', primary],
      ['linked', linked],
    ] as const) {
      if (!memory[name]) await distribute(receiver, encrypted.senderKeyDistributionMessage);
      memory[name] = true;
    }
    await senderAuth.keys.set({ 'sender-key-memory': { [group]: memory } });
    ciphertext = encrypted.ciphertext;
    return { key: { id: options.messageId, remoteJid: group, fromMe: true }, messageTimestamp: 1 };
  };
  const decrypt = (receiver: typeof linked) => receiver.decryptGroupMessage({ group, authorJid, msg: ciphertext });
  await wa.nativeForwardMessage(group, source(), options);
  const linkedContent = proto.Message.decode(await decrypt(linked));
  assert.equal(linkedContent.extendedTextMessage.text, 'synthetic');
  await assert.rejects(decrypt(primary));
  wa.configService = { get: () => ({ FORCE_GROUP_SENDER_KEY_REFRESH: true, SAVE_DATA: { NEW_MESSAGE: false } }) };
  await wa.nativeForwardMessage(group, source(), options);
  for (const receiver of [primary, linked]) {
    const decoded = proto.Message.decode(await decrypt(receiver));
    assert.equal(decoded.extendedTextMessage.text, 'synthetic');
    assert.equal(decoded.extendedTextMessage.contextInfo.isForwarded, true);
  }
});

// C170: a stored group message carries the sender key of the chat it came from and its own message context.
function storedGroupImage() {
  const bytes = Buffer.alloc(32, 7);
  return {
    key: { id: 'SYNTHETIC-GROUP-IMAGE', fromMe: true, remoteJid: '120363111111111111@g.us' },
    message: {
      mediaUrl: 'https://synthetic.invalid/media.jpeg',
      imageMessage: proto.Message.ImageMessage.fromObject({
        url: 'https://mmg.whatsapp.net/synthetic',
        directPath: '/synthetic',
        mimetype: 'image/jpeg',
        mediaKey: bytes,
        fileSha256: bytes,
        fileEncSha256: bytes,
        caption: 'synthetic caption',
        contextInfo: { mentionedJid: [] },
      }).toJSON(),
      messageContextInfo: { messageSecret: Buffer.alloc(32, 8).toString('base64') },
      senderKeyDistributionMessage: {
        groupId: '120363111111111111@g.us',
        axolotlSenderKeyDistributionMessage: Buffer.alloc(16, 9).toString('base64'),
      },
    },
  };
}

test('installed Baileys alone marks the copied sender key, not the picture, and keeps the other group key', () => {
  const forwarded = generateForwardMessageContent(storedGroupImage() as any, true);
  const decoded = proto.Message.decode(proto.Message.encode(forwarded).finish());
  assert.equal(decoded.senderKeyDistributionMessage?.groupId, '120363111111111111@g.us');
  assert.notEqual(decoded.imageMessage.contextInfo?.isForwarded, true);
});

test('native forward sends only the picture, marked as forwarded, without the source chat sender key', async () => {
  const { wa, sends, options } = harness(false);
  const original = storedGroupImage();
  const before = JSON.stringify(original);
  await wa.nativeForwardMessage(group, original, options);
  const sent = sends[0].content.forward;
  assert.deepEqual(Object.keys(sent.message), ['imageMessage']);
  assert.deepEqual(sent.key, original.key);
  const decoded = proto.Message.decode(
    proto.Message.encode(generateForwardMessageContent(sent, sends[0].content.force)).finish(),
  );
  assert.equal(decoded.senderKeyDistributionMessage, null);
  assert.equal(decoded.messageContextInfo, null);
  assert.equal(decoded.imageMessage.contextInfo.isForwarded, true);
  assert.equal(decoded.imageMessage.contextInfo.forwardingScore, 1);
  assert.equal(decoded.imageMessage.directPath, '/synthetic');
  assert.equal(decoded.imageMessage.caption, 'synthetic caption');
  assert.equal(JSON.stringify(original), before);
});

test('native forward unwraps a captioned document and forwards the document itself', async () => {
  const { wa, sends, options } = harness(false);
  await wa.nativeForwardMessage(
    direct,
    {
      key: { id: 'SYNTHETIC-DOC', fromMe: false },
      message: {
        documentWithCaptionMessage: { message: { documentMessage: { fileName: 'synthetic.pdf', caption: 'c' } } },
        messageContextInfo: { messageSecret: 'AAAA' },
      },
    },
    options,
  );
  assert.deepEqual(Object.keys(sends[0].content.forward.message), ['documentMessage']);
});

test('a source without message content never reaches the transport', async () => {
  const { wa, sends, events, options } = harness();
  await assert.rejects(
    wa.nativeForwardMessage(
      group,
      { key: { id: 'SYNTHETIC-EMPTY' }, message: { senderKeyDistributionMessage: { groupId: group } } },
      options,
    ),
    { name: 'NativeForwardSourceMissing' },
  );
  assert.equal(sends.length, 0);
  assert.deepEqual(events, []);
});
