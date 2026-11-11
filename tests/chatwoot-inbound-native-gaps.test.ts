import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyNativeGaps,
  NativeGapReader,
  NativeGapRoute,
  NativeGapRow,
  nativeGapReport,
  planNativeGaps,
  predictNativeGap,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-native-gaps';
import {
  inboundDeliveryId,
  inboundPayloadHash,
  inboundProviderFingerprint,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';
import { RECOVERY_MARKER } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-recovery';

const GROUP = '120363000000000077@g.us';
const PEER = '62800000000001@s.whatsapp.net';
const b64 = (byte: number) => Buffer.alloc(32, byte).toString('base64');

const route: NativeGapRoute = {
  instanceId: 'inst-1',
  instanceName: 'p-synthetic',
  groupsIgnore: false,
  provider: {
    id: 'cw-1',
    instanceId: 'inst-1',
    accountId: '1',
    url: 'https://chatwoot.invalid',
    nameInbox: 'WA - Synthetic',
    number: null,
    ignoreJids: [],
    enabled: true,
    importMessages: true,
  },
};

let seq = 0;
function native(id: string, overrides: Partial<NativeGapRow> = {}): NativeGapRow {
  return {
    id: 'native-' + id + '-' + seq++,
    key: { id, remoteJid: GROUP, fromMe: false },
    messageType: 'conversation',
    message: { conversation: 'secret text ' + id, messageContextInfo: { messageSecret: b64(3) } },
    messageTimestamp: 1_700_000_000,
    contextInfo: null,
    participant: '62800000000002@s.whatsapp.net',
    pushName: 'Private Name',
    status: 'READ',
    chatwootMessageId: null,
    ...overrides,
  };
}

function reader(rows: NativeGapRow[], ledger: string[] = [], outbound: string[] = []) {
  const calls = { ledger: 0, bodies: 0 };
  const source: NativeGapReader = {
    routes: async () => [route],
    index: async (_instance, since, until) =>
      rows
        .filter((row) => row.messageTimestamp >= since && row.messageTimestamp < until)
        .map(({ id, key, messageType, messageTimestamp, chatwootMessageId }) => ({
          id,
          key,
          messageType,
          messageTimestamp,
          chatwootMessageId,
        })),
    bodies: async (ids) => (calls.bodies++, rows.filter((row) => ids.includes(row.id))),
    ledgerIds: async (ids) => (calls.ledger++, ids.filter((id) => ledger.includes(id))),
    chatwootOutboundIds: async (_instance, ids) => ids.filter((id) => outbound.includes(id)),
  };
  return { source, calls };
}
const window = { since: new Date(1_600_000_000_000), until: new Date(1_800_000_000_000) };

test('only unlinked, unledgered, ordinary messages are planned into the history lane, oldest first', async () => {
  const plain = native('A', { messageTimestamp: 1_700_000_300 });
  const older = native('B', { messageTimestamp: 1_700_000_100, key: { id: 'B', remoteJid: PEER, fromMe: false } });
  const linked = native('C', { chatwootMessageId: 77 });
  const linkedTwin = native('C', { message: { conversation: '' } });
  const ledgered = native('D');
  const reaction = native('E', { messageType: 'reactionMessage', message: { reactionMessage: { text: 'x' } } });
  const stub = native('F', {
    message: {
      conversation: '',
      senderKeyDistributionMessage: { groupId: GROUP, axolotlSenderKeyDistributionMessage: b64(1) },
    },
  });
  const lottie = native('G', {
    messageType: 'lottieStickerMessage',
    message: { lottieStickerMessage: { message: {} } },
  });
  const fromChatwoot = native('H', { key: { id: 'H', remoteJid: PEER, fromMe: true } });
  const outside = native('I', { messageTimestamp: 1_900_000_000 });
  const rows = [plain, older, linked, linkedTwin, ledgered, reaction, stub, lottie, fromChatwoot, outside];
  const { source } = reader(rows, [inboundDeliveryId('inst-1', ledgered)], ['H']);
  const plan = await planNativeGaps(source, window);

  assert.deepEqual(
    plan.selected.map(({ source }) => source.key.id),
    ['B', 'A'],
  );
  const predictions = Object.fromEntries(plan.candidates.map((c) => [c.messageType + ':' + c.prediction, true]));
  assert.ok(predictions['conversation:ignore_transport']);
  assert.ok(predictions['conversation:chatwoot_outbound']);
  // A malformed lottie wrapper is not an ordinary record; a valid one is likely_unsupported. Neither is enqueued.
  assert.equal(plan.candidates.find((c) => c.messageType === 'lottieStickerMessage')!.prediction, 'not_a_message');
  assert.equal(plan.alreadyInLedger, 1);
  // Linked keys (even through a duplicate row), reactions alone and rows outside the window are not gaps.
  assert.equal(plan.candidates.length, 5);

  const again = await planNativeGaps(reader(rows, [inboundDeliveryId('inst-1', ledgered)], ['H']).source, window);
  assert.equal(again.planHash, plan.planHash);
});

test('ignored peers, broadcast scopes and triple-stored keys are refused', () => {
  const ignored = { ...route, provider: { ...route.provider, ignoreJids: ['@g.us'] } };
  assert.equal(predictNativeGap([native('A')], ignored), 'ignored_peer');
  assert.equal(predictNativeGap([native('A')], { ...route, groupsIgnore: true }), 'ignored_peer');
  assert.equal(
    predictNativeGap([native('S', { key: { id: 'S', remoteJid: 'status@broadcast', fromMe: false } })], route),
    'ignored_peer',
  );
  assert.equal(predictNativeGap([native('T'), native('T'), native('T')], route), 'blocked_ambiguous');
  assert.equal(predictNativeGap([native('U')], route), 'enqueue_history');
});

test('the report holds aggregates only', async () => {
  const { source } = reader([native('A'), native('B', { key: { id: 'B', remoteJid: PEER, fromMe: true } })]);
  const report = JSON.stringify(nativeGapReport(await planNativeGaps(source, window), new Date(1_800_000_000_000)));
  for (const secret of ['secret text', 'Private Name', GROUP, PEER, '62800000000002', 'native-', 'p-synthetic'])
    assert.equal(report.includes(secret), false, secret);
  assert.match(report, /"toEnqueue":2/);
});

test('apply writes history_pending ledger rows the history lane accepts, ordered and marked', async () => {
  const a = native('A', { messageTimestamp: 1_700_000_200 });
  const b = native('B', { messageTimestamp: 1_700_000_100 });
  const plan = await planNativeGaps(reader([a, b]).source, window);
  const written: any[] = [];
  const now = new Date(1_800_000_000_000);
  const result = await applyNativeGaps(
    plan,
    { enqueue: async (items) => (written.push(...items), items.length - 1) },
    now,
  );
  assert.deepEqual(result, { enqueued: 1, skipped: 1 });
  assert.deepEqual(
    written.map((item) => item.sourceId),
    ['WAID:B', 'WAID:A'],
  );
  for (const [index, item] of written.entries()) {
    // The exact checks deliverQueuedHistory makes before any read of Chatwoot.
    assert.equal(item.state, 'history_pending');
    assert.equal(inboundDeliveryId(item.instanceId, item.payload), item.id);
    assert.equal(inboundPayloadHash(item.payload), item.payloadHash);
    assert.equal(item.providerFingerprint, inboundProviderFingerprint(route.provider));
    assert.equal(item.providerId, 'cw-1');
    assert.equal(item.accountId, 1);
    assert.equal(item.inboxId, null);
    assert.equal(item.lastErrorClass, RECOVERY_MARKER);
    assert.equal(item.nextAttemptAt.getTime(), now.getTime() + index * 10);
  }
  // Same hash as the native row itself: the history lane resolves the native source by it.
  assert.equal(written[0].payloadHash, inboundPayloadHash(b));
});
