import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatwootInboundPrismaStore } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-prisma-store';
import { inboundDeliveryId, inboundPayloadHash } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-queue';
import {
  applyRecovery,
  planRecovery,
  predictRecovery,
  prismaRecoveryWriter,
  RECOVERY_MARKER,
  RecoveryNativeRow,
  recoveryLane,
  recoveryReport,
  RecoveryRow,
} from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-recovery';

const b64 = (byte: number) => Buffer.alloc(32, byte).toString('base64');
const numeric = (base64: string) =>
  Object.fromEntries([...Buffer.from(base64, 'base64')].map((byte, i) => [String(i), byte]));
const GROUP = '120363000000000077@g.us';

function native(id: string, overrides: Partial<RecoveryNativeRow> = {}): RecoveryNativeRow {
  return {
    id: 'native-' + id,
    key: { id, remoteJid: GROUP, fromMe: false },
    messageType: 'conversation',
    message: { conversation: 'secret text ' + id, messageContextInfo: { messageSecret: b64(3) } },
    messageTimestamp: 1_700_000_000,
    contextInfo: null,
    participant: null,
    pushName: 'Private Name',
    status: 'READ',
    chatwootMessageId: null,
    ...overrides,
  };
}
function row(source: RecoveryNativeRow, overrides: Partial<RecoveryRow> = {}): RecoveryRow {
  const payload: any = structuredClone({
    key: source.key,
    messageType: source.messageType,
    message: source.message,
    messageTimestamp: source.messageTimestamp,
    pushName: source.pushName,
  });
  if (payload.message?.messageContextInfo?.messageSecret)
    payload.message.messageContextInfo.messageSecret = numeric(payload.message.messageContextInfo.messageSecret);
  return {
    id: inboundDeliveryId('inst-1', payload),
    instanceId: 'inst-1',
    instanceName: 'p-synthetic',
    peer: source.key.remoteJid,
    sourceId: 'WAID:' + source.key.id,
    fromMe: source.key.fromMe,
    payload,
    payloadHash: inboundPayloadHash(payload),
    state: 'history_pending',
    attempts: 40,
    lastErrorClass: 'InboundNativeSourceAmbiguous',
    result: null,
    createdAt: new Date(1_700_000_000_000 + 86_400_000),
    nextAttemptAt: new Date(0),
    leaseExpiresAt: null,
    ...overrides,
  };
}

test('predictions follow the fixed delivery rules for every stuck class', () => {
  const base = native('A');
  assert.equal(predictRecovery(row(base), 'history', [base], 1), 'deliver');
  const delivered = { ...base, chatwootMessageId: 9 };
  assert.equal(predictRecovery(row(base), 'live', [delivered], 1), 'confirm_existing');
  assert.equal(predictRecovery(row(base, { state: 'pending' }), 'live', [], 0), 'deliver_from_payload');
  assert.equal(predictRecovery(row(base, { state: 'pending' }), 'live', [], 1), 'blocked_native_missing');
  assert.equal(predictRecovery(row(base), 'history', [], 0), 'blocked_native_missing');
  const skd = native('B', {
    message: { conversation: '', senderKeyDistributionMessage: { groupId: GROUP, axolotlSenderKeyDistributionMessage: b64(1) } },
  });
  assert.equal(predictRecovery(row(skd), 'history', [skd], 1), 'ignore_transport');
  const sticker = native('C', { messageType: 'lottieStickerMessage', message: { lottieStickerMessage: { message: {} } } });
  assert.equal(predictRecovery(row(sticker), 'live', [sticker], 1), 'likely_unsupported');
  const reaction = { ...native('A'), id: 'r', messageType: 'reactionMessage', message: { reactionMessage: { text: 'x' } } };
  assert.equal(predictRecovery(row(base), 'live', [base, reaction], 2), 'deliver');
  const edited = native('A', { message: { conversation: 'other text' } });
  assert.equal(predictRecovery(row(base), 'live', [base, edited], 2), 'blocked_ambiguous');
  const tampered = row(base);
  tampered.payload.message.conversation = 'changed';
  assert.equal(predictRecovery(tampered, 'live', [base], 1), 'blocked_source_changed');
});

test('lane comes from the state, the kept terminal lane, or the WhatsApp-to-commit gap for older closed rows', () => {
  const base = native('A');
  assert.equal(recoveryLane(row(base, { state: 'pending' })), 'live');
  assert.equal(recoveryLane(row(base, { state: 'failed', result: { terminal: 'failed', lane: 'history' } })), 'history');
  assert.equal(recoveryLane(row(base, { state: 'failed' })), 'history');
  assert.equal(recoveryLane(row(base, { state: 'failed', createdAt: new Date(1_700_000_002_000) })), 'live');
});

function reader(rows: RecoveryRow[], natives: RecoveryNativeRow[]) {
  const calls: string[][] = [];
  return {
    calls,
    rows: async () => rows,
    natives: async (_instance: string, ids: string[]) => {
      calls.push(ids);
      return natives.filter((native) => ids.includes(native.key.id));
    },
  };
}

test('plan requeues only deliverable rows, oldest WhatsApp message first, skipping leased rows', async () => {
  const a = native('A', { messageTimestamp: 1_700_000_300 });
  const b = native('B', { messageTimestamp: 1_700_000_100 });
  const c = native('C', { messageTimestamp: 1_700_000_200 });
  const skd = native('S', { message: { conversation: '', senderKeyDistributionMessage: { groupId: GROUP } } });
  const now = new Date(1_800_000_000_000);
  const rows = [
    row(a),
    row(b),
    row(c, { leaseExpiresAt: new Date(now.getTime() + 60_000) }),
    row(skd),
  ];
  const source = reader(rows, [a, b, c, skd]);
  const plan = await planRecovery(source, {}, now);
  assert.deepEqual(
    plan.selected.map(({ row }) => row.sourceId),
    ['WAID:B', 'WAID:A'],
  );
  assert.equal(plan.candidates.find(({ row }) => row.sourceId === 'WAID:S')!.prediction, 'ignore_transport');
  assert.equal(source.calls.length, 1);
  const again = await planRecovery(reader(rows, [a, b, c, skd]), {}, now);
  assert.equal(again.planHash, plan.planHash);
  rows[0] = { ...rows[0], attempts: rows[0].attempts + 1 };
  assert.notEqual((await planRecovery(reader(rows, [a, b, c, skd]), {}, now)).planHash, plan.planHash);
});

test('the dry-run report holds aggregates only, never peers, ids, names or text', async () => {
  const a = native('A');
  const plan = await planRecovery(reader([row(a)], [a]), {}, new Date(1_800_000_000_000));
  const report = recoveryReport(plan, new Date(1_800_000_000_000));
  assert.equal(report.toRequeue, 1);
  assert.deepEqual(report.toRequeueByLane, { live: 0, history: 1 });
  assert.equal(report.groupsToRequeue, 1);
  const text = JSON.stringify(report);
  for (const secret of [GROUP, 'WAID:A', 'secret text', 'Private Name', 'p-synthetic', plan.selected[0].row.id])
    assert.equal(text.includes(secret), false, secret);
});

test('apply requeues into the original lane with ordered attempts and the verified-path marker', async () => {
  const a = native('A', { messageTimestamp: 1_700_000_100 });
  const b = native('B', { messageTimestamp: 1_700_000_200 });
  const live = row(b, { state: 'failed', result: { terminal: 'failed', lane: 'live' } });
  const now = new Date(1_800_000_000_000);
  const plan = await planRecovery(reader([row(a), live], [a, b]), {}, now);
  const calls: any[] = [];
  const prisma = {
    chatwootInboundDelivery: {
      updateMany: async (args: any) => {
        calls.push(args);
        return { count: calls.length === 1 ? 1 : 0 };
      },
    },
  };
  assert.deepEqual(await applyRecovery(plan, prismaRecoveryWriter(prisma), now), { requeued: 1, skipped: 1 });
  assert.equal(calls[0].where.state, 'history_pending');
  assert.equal(calls[0].where.attempts, 40);
  assert.ok(calls[0].where.OR);
  assert.equal(calls[0].data.state, 'history_pending');
  assert.equal(calls[0].data.lastErrorClass, RECOVERY_MARKER);
  assert.equal(calls[1].where.state, 'failed');
  assert.equal(calls[1].data.state, 'pending');
  assert.ok(calls[1].data.result !== undefined);
  assert.ok(calls[0].data.nextAttemptAt < calls[1].data.nextAttemptAt);
  assert.ok(RECOVERY_MARKER.startsWith('InboundReceiver'));
});

test('terminal failures keep their lane for recovery', async () => {
  const calls: any[] = [];
  const store = new ChatwootInboundPrismaStore({
    chatwootInboundDelivery: {
      updateMany: async (args: any) => {
        calls.push(args);
        return { count: 1 };
      },
    },
  } as any);
  assert.equal(await store.fail('id', 'owner', 'failed', 'InboundReceiverContentChanged', 'history'), true);
  assert.deepEqual(calls[0].data.result, { terminal: 'failed', lane: 'history' });
  assert.equal(calls[0].data.state, 'failed');
});
