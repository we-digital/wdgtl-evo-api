import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatwootEvoRouteBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';
import {
  canReusePreparedOutboundSnapshot,
  ChatwootOutboundFenceBinding,
  DEFAULT_OUTBOUND_FENCE_SNAPSHOT_MAX_AGE_MS,
  outboundFenceSnapshotMaxAgeMs,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-fence';

const socket = { instanceId: 'synthetic-instance' };
const binding = (overrides: Partial<ChatwootOutboundFenceBinding> = {}): ChatwootOutboundFenceBinding => ({
  instanceId: 'synthetic-instance',
  instanceName: 'synthetic',
  ownerJid: '10000000000@s.whatsapp.net',
  number: '10000000000',
  providerId: 'provider-1',
  providerUpdatedAt: 1_000,
  providerEnabled: true,
  providerUrl: 'https://chatwoot.invalid',
  providerToken: 'synthetic-token',
  providerAccountId: '1',
  providerNameInbox: 'synthetic',
  route: buildChatwootEvoRouteBinding({
    inboxId: 45,
    instanceId: 'synthetic-instance',
    instanceName: 'synthetic',
    receiverNumber: '10000000000',
    signingKey: 'synthetic-token',
  }),
  waInstance: socket,
  ...overrides,
});
const now = 10_000;
const prepared = (overrides: Partial<{ snapshotStartedAt: number; authoritativelyDeleted: boolean }> = {}) => ({
  snapshotStartedAt: now - 400,
  authoritativelyDeleted: false,
  fenceBinding: binding(),
  ...overrides,
});

test('reuses a fresh preparation snapshot when the local binding is unchanged', () => {
  assert.ok(binding().route, 'synthetic route must build');
  assert.equal(
    canReusePreparedOutboundSnapshot({ prepared: prepared(), current: binding(), now, maxAgeMs: 1_500 }),
    true,
  );
});

test('requires the fresh exact read for an old, deleted, missing or disabled-reuse snapshot', () => {
  const current = binding();
  assert.equal(
    canReusePreparedOutboundSnapshot({
      prepared: prepared({ snapshotStartedAt: now - 1_501 }),
      current,
      now,
      maxAgeMs: 1_500,
    }),
    false,
  );
  assert.equal(
    canReusePreparedOutboundSnapshot({
      prepared: prepared({ snapshotStartedAt: now + 5 }),
      current,
      now,
      maxAgeMs: 1_500,
    }),
    false,
  );
  assert.equal(
    canReusePreparedOutboundSnapshot({
      prepared: prepared({ authoritativelyDeleted: true }),
      current,
      now,
      maxAgeMs: 1_500,
    }),
    false,
  );
  assert.equal(canReusePreparedOutboundSnapshot({ prepared: null, current, now, maxAgeMs: 1_500 }), false);
  assert.equal(canReusePreparedOutboundSnapshot({ prepared: prepared(), current: null, now, maxAgeMs: 1_500 }), false);
  assert.equal(canReusePreparedOutboundSnapshot({ prepared: prepared(), current, now, maxAgeMs: 0 }), false);
});

test('requires the fresh exact read when any local binding field changed', () => {
  const changes: Partial<ChatwootOutboundFenceBinding>[] = [
    { instanceName: 'renamed' },
    { ownerJid: '10000000001@s.whatsapp.net' },
    { number: '10000000001' },
    { providerId: 'provider-2' },
    { providerUpdatedAt: 2_000 },
    { providerEnabled: false },
    { providerUrl: 'https://other.invalid' },
    { providerToken: 'rotated-token' },
    { providerAccountId: '2' },
    { providerNameInbox: 'other' },
    {
      route: buildChatwootEvoRouteBinding({
        inboxId: 45,
        instanceId: 'synthetic-instance',
        instanceName: 'synthetic',
        receiverNumber: '10000000001',
        signingKey: 'synthetic-token',
      }),
    },
    { route: null },
    { waInstance: { instanceId: 'synthetic-instance' } },
    { waInstance: null },
  ];
  for (const change of changes) {
    assert.equal(
      canReusePreparedOutboundSnapshot({ prepared: prepared(), current: binding(change), now, maxAgeMs: 1_500 }),
      false,
      JSON.stringify(Object.keys(change)),
    );
  }
});

test('parses the fence snapshot age setting with a bounded default and an explicit off switch', () => {
  assert.equal(outboundFenceSnapshotMaxAgeMs(undefined), DEFAULT_OUTBOUND_FENCE_SNAPSHOT_MAX_AGE_MS);
  assert.equal(outboundFenceSnapshotMaxAgeMs(''), DEFAULT_OUTBOUND_FENCE_SNAPSHOT_MAX_AGE_MS);
  assert.equal(outboundFenceSnapshotMaxAgeMs('abc'), DEFAULT_OUTBOUND_FENCE_SNAPSHOT_MAX_AGE_MS);
  assert.equal(outboundFenceSnapshotMaxAgeMs('0'), 0);
  assert.equal(outboundFenceSnapshotMaxAgeMs('-5'), 0);
  assert.equal(outboundFenceSnapshotMaxAgeMs('800'), 800);
  assert.equal(outboundFenceSnapshotMaxAgeMs('60000'), 5_000);
});
