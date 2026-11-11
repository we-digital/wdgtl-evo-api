import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRelink,
  planRelink,
  predictRelink,
  RELINK_TIME_TOLERANCE_S,
  RelinkDestination,
  RelinkLedgerRow,
  RelinkNativeRow,
  relinkReport,
  RelinkReader,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-relink';

const GROUP = '120363000000000077@g.us';
const row = (overrides: Partial<RelinkLedgerRow> = {}): RelinkLedgerRow => ({
  id: 'ledger-1',
  instanceId: 'inst-1',
  instanceName: 'p-synthetic',
  inboxId: 7,
  accountId: 1,
  peer: GROUP,
  fromMe: false,
  sourceId: 'WAID:K1',
  lastErrorClass: 'InboundReceiverPayloadUnconfirmed',
  ...overrides,
});
const native = (overrides: Partial<RelinkNativeRow> = {}): RelinkNativeRow => ({
  id: 'native-1',
  key: { id: 'K1', remoteJid: GROUP, fromMe: false },
  messageType: 'conversation',
  messageTimestamp: 1_700_000_000,
  chatwootMessageId: null,
  ...overrides,
});
const dest = (overrides: Partial<RelinkDestination> = {}): RelinkDestination => ({
  id: 900,
  messageType: 0,
  private: false,
  createdAt: 1_700_000_002,
  peer: GROUP,
  displayId: 55,
  contactInboxSourceId: 'ci-1',
  attachments: 0,
  placeholder: false,
  ...overrides,
});

test('identity is proven by key, inbox, direction, peer, time and attachments', () => {
  assert.equal(predictRelink(row(), [native()], [dest()], false), 'relink');
  const photo = native({ messageType: 'imageMessage' });
  assert.equal(predictRelink(row(), [photo], [dest({ attachments: 1 })], false), 'relink');
  assert.equal(predictRelink(row(), [photo], [dest()], false), 'mismatch_attachment');
  assert.equal(predictRelink(row(), [native()], [dest({ attachments: 1 })], false), 'mismatch_attachment');
  const late = dest({ createdAt: 1_700_000_000 + RELINK_TIME_TOLERANCE_S + 1 });
  assert.equal(predictRelink(row(), [native()], [late], false), 'mismatch_time');
  assert.equal(predictRelink(row(), [native()], [dest({ messageType: 1 })], false), 'mismatch_direction');
  assert.equal(predictRelink(row(), [native()], [dest({ private: true })], false), 'mismatch_private');
  assert.equal(predictRelink(row(), [native()], [dest({ peer: '120363000000000099@g.us' })], false), 'mismatch_peer');
  assert.equal(predictRelink(row(), [native()], [dest({ peer: null })], false), 'mismatch_peer');
  assert.equal(predictRelink(row(), [native()], [dest(), dest({ id: 901 })], false), 'destination_ambiguous');
  assert.equal(predictRelink(row(), [native()], [], false), 'destination_missing');
  assert.equal(predictRelink(row(), [native()], [dest()], true), 'destination_taken');
  assert.equal(predictRelink(row(), [native({ chatwootMessageId: 3 })], [dest()], false), 'already_linked');
  assert.equal(predictRelink(row(), [native({ messageType: 'reactionMessage' })], [dest()], false), 'native_missing');
  // Another chat or direction under the same key id is not this message.
  assert.equal(
    predictRelink(row(), [native({ key: { id: 'K1', remoteJid: 'x@g.us', fromMe: false } })], [dest()], false),
    'native_missing',
  );
});

test('a media-unavailable placeholder created later links; a later plain text does not', () => {
  const photo = native({ messageType: 'imageMessage' });
  const later = { createdAt: 1_700_000_000 + 30 * 86_400, attachments: 0 };
  assert.equal(predictRelink(row(), [photo], [dest({ ...later, placeholder: true })], false), 'relink_placeholder');
  assert.equal(predictRelink(row(), [photo], [dest({ ...later, placeholder: false })], false), 'mismatch_time');
  assert.equal(predictRelink(row(), [native()], [dest({ ...later, placeholder: true })], false), 'mismatch_time');
  // A placeholder that predates the WhatsApp message is not it.
  assert.equal(
    predictRelink(row(), [photo], [dest({ createdAt: 1_600_000_000, attachments: 0, placeholder: true })], false),
    'mismatch_time',
  );
});

test('plan, aggregate report and apply link only proven rows, bound to the hash', async () => {
  const rows = [row(), row({ id: 'ledger-2', sourceId: 'WAID:K2' })];
  const reader: RelinkReader = {
    rows: async () => rows,
    natives: async (_i, keyId) => [
      native({ id: 'native-' + keyId, key: { id: keyId, remoteJid: GROUP, fromMe: false } }),
    ],
    destinations: async (_a, _b, keyId) => (keyId === 'K1' ? [dest()] : [dest({ messageType: 1 })]),
    destinationTaken: async () => false,
  };
  const plan = await planRelink(reader, {});
  assert.equal(plan.selected.length, 1);
  assert.equal((await planRelink(reader, {})).planHash, plan.planHash);
  const report = JSON.stringify(relinkReport(plan, new Date(0)));
  for (const secret of [GROUP, 'K1', 'native-', 'p-synthetic', 'ci-1'])
    assert.equal(report.includes(secret), false, secret);
  const calls: any[] = [];
  const result = await applyRelink(plan, {
    link: async (instanceId, ids, d, inbox) => (calls.push([instanceId, ids, d.id, d.displayId, inbox]), ids.length),
  });
  assert.deepEqual(result, { linked: 1, skipped: 0 });
  assert.deepEqual(calls, [['inst-1', ['native-K1'], 900, 55, 7]]);
  const failing = await applyRelink(plan, {
    link: async () => {
      throw new Error('RelinkNativeChanged');
    },
  });
  assert.deepEqual(failing, { linked: 0, skipped: 1 });
});
