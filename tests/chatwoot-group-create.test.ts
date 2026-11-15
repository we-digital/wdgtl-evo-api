import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bareWhatsappPhoneJid,
  groupAddOutcome,
  GroupCreateCoordinator,
  GroupCreateDeps,
  GroupCreateError,
  groupCreateInstanceEnabled,
  groupCreatePeerAllowlistActive,
  GroupCreateRequest,
  LocalGroupCreateStore,
  parseGroupCreateRequest,
  RedisGroupCreateStore,
  runGroupCreate,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-group-create';

const GROUP = '120363000000777@g.us';
const pn = (n: number) => `6281000000${String(n).padStart(3, '0')}@s.whatsapp.net`;

type Calls = { method: string; args: any[] }[];

/** A Baileys socket that answers per JID: add status, WhatsApp presence, promote/picture/invite failures. */
function fakeSocket(
  options: {
    notOnWhatsApp?: string[];
    addStatus?: Record<string, string>;
    createParticipants?: (jids: string[]) => any[];
    createError?: any;
    promoteError?: any;
    promoteResult?: (jids: string[]) => any[];
    pictureError?: any;
    inviteCode?: string;
    onWhatsAppError?: any;
  } = {},
) {
  const calls: Calls = [];
  const socket = {
    onWhatsApp: async (...jids: string[]) => {
      calls.push({ method: 'onWhatsApp', args: jids });
      if (options.onWhatsAppError) throw options.onWhatsAppError;
      return jids.map((jid) => ({ jid, exists: !options.notOnWhatsApp?.includes(jid) }));
    },
    groupCreate: async (subject: string, participants: string[]) => {
      calls.push({ method: 'groupCreate', args: [subject, participants] });
      if (options.createError) throw options.createError;
      const members = options.createParticipants
        ? options.createParticipants(participants)
        : participants.map((id) => ({ id }));
      return { id: GROUP, participants: [{ id: '6280000000001@s.whatsapp.net', admin: 'superadmin' }, ...members] };
    },
    groupParticipantsUpdate: async (jid: string, participants: string[], action: string) => {
      calls.push({ method: action, args: [jid, participants] });
      if (action === 'promote') {
        if (options.promoteError) throw options.promoteError;
        return options.promoteResult
          ? options.promoteResult(participants)
          : participants.map((p) => ({ status: '200', jid: p }));
      }
      return participants.map((p) => ({ status: options.addStatus?.[p] ?? '200', jid: p }));
    },
    updateProfilePicture: async (jid: string, content: Buffer) => {
      calls.push({ method: 'picture', args: [jid, content.length] });
      if (options.pictureError) throw options.pictureError;
    },
    groupInviteCode: async (jid: string) => {
      calls.push({ method: 'invite', args: [jid] });
      return options.inviteCode ?? 'AbCdEf123';
    },
  };
  return { socket, calls };
}

function deps(socket: any, overrides: Partial<GroupCreateDeps> = {}) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const conversations: string[] = [];
  const value: GroupCreateDeps = {
    socket,
    resolvePhoneJidForLid: async () => null,
    ensureConversation: async (jid) => {
      conversations.push(jid);
      return { id: 12, database_id: 9012 };
    },
    sleep: async (ms) => void sleeps.push(ms),
    log: (event) => void logs.push(event),
    ...overrides,
  };
  return { deps: value, sleeps, logs, conversations };
}

const request = (invitees: GroupCreateRequest['invitees'], extra: Partial<GroupCreateRequest> = {}) =>
  ({
    requestId: 'req-0000-0001',
    accountId: 1,
    inboxId: 42,
    subject: 'Visa team',
    picture: null,
    invitees,
    ...extra,
  }) as GroupCreateRequest;

const boom = (statusCode: number) => Object.assign(new Error(`boom ${statusCode}`), { output: { statusCode } });

test('creates with the first reachable invitee and adds the rest one by one, 300 ms apart', async () => {
  const { socket, calls } = fakeSocket({
    addStatus: { [pn(2)]: '403', [pn(3)]: '408', [pn(4)]: '409', [pn(5)]: '401' },
  });
  const harness = deps(socket);
  const reply = await runGroupCreate(
    request([1, 2, 3, 4, 5, 6].map((n) => ({ key: `c:${n}`, jid: pn(n), admin: false }))),
    harness.deps,
  );

  assert.deepEqual(
    calls.filter((call) => call.method === 'groupCreate').map((call) => call.args),
    [['Visa team', [pn(1)]]],
  );
  assert.deepEqual(
    calls.filter((call) => call.method === 'add').map((call) => call.args[1]),
    [[pn(2)], [pn(3)], [pn(4)], [pn(5)], [pn(6)]],
  );
  assert.deepEqual(harness.sleeps, [300, 300, 300, 300, 300]);
  assert.equal(reply.status, 'ok');
  assert.equal(reply.action, 'group_created_whatsapp');
  assert.equal(reply.group_peer, GROUP);
  assert.deepEqual(reply.conversation, { id: 12, database_id: 9012 });
  assert.deepEqual(
    reply.invitees.map(({ key, outcome, reason }) => [key, outcome, reason]),
    [
      ['c:1', 'added', null],
      ['c:2', 'skipped', 'privacy'],
      ['c:3', 'skipped', 'left_recently'],
      // Already in the group counts as added: the note must not list them as missing.
      ['c:4', 'added', null],
      ['c:5', 'skipped', 'blocked'],
      ['c:6', 'added', null],
    ],
  );
  assert.equal(reply.invite_link, 'https://chat.whatsapp.com/AbCdEf123');
  assert.equal(reply.picture, 'none');
});

test('invitees without a phone or not on WhatsApp are skipped before anything is created', async () => {
  const { socket, calls } = fakeSocket({ notOnWhatsApp: [pn(2)] });
  const reply = await runGroupCreate(
    request([
      { key: 'c:1', jid: null, admin: false },
      { key: 'c:2', jid: pn(2), admin: false },
      { key: 'c:3', jid: '12345@lid', admin: false },
      { key: 'c:4', jid: '6281000000004:7@s.whatsapp.net', admin: false },
    ]),
    deps(socket).deps,
  );
  assert.deepEqual(calls[0], { method: 'onWhatsApp', args: [pn(2), pn(4)] });
  assert.deepEqual(calls[1].args, ['Visa team', [pn(4)]]);
  assert.deepEqual(
    reply.invitees.map(({ key, outcome, reason }) => [key, outcome, reason]),
    [
      ['c:1', 'skipped', 'no_phone'],
      ['c:2', 'skipped', 'not_on_whatsapp'],
      ['c:3', 'skipped', 'no_phone'],
      ['c:4', 'added', null],
    ],
  );
  assert.ok(reply.invite_link);
});

test('nobody reachable creates nothing unless empty groups are allowed', async () => {
  const { socket, calls } = fakeSocket({ notOnWhatsApp: [pn(1)] });
  await assert.rejects(
    runGroupCreate(request([{ key: 'c:1', jid: pn(1), admin: false }]), deps(socket).deps),
    (error: any) => error instanceof GroupCreateError && error.code === 'no_reachable_invitees' && error.status === 422,
  );
  assert.equal(calls.filter((call) => call.method === 'groupCreate').length, 0);

  const empty = fakeSocket({ notOnWhatsApp: [pn(1)] });
  const reply = await runGroupCreate(
    request([{ key: 'c:1', jid: pn(1), admin: false }]),
    deps(empty.socket, { allowEmptyGroup: true }).deps,
  );
  assert.deepEqual(empty.calls.find((call) => call.method === 'groupCreate')?.args, ['Visa team', []]);
  assert.equal(reply.invitees[0].reason, 'not_on_whatsapp');
});

test('an onWhatsApp failure is not_connected and creates nothing', async () => {
  const { socket, calls } = fakeSocket({ onWhatsAppError: new Error('socket closed') });
  await assert.rejects(
    runGroupCreate(request([{ key: 'c:1', jid: pn(1), admin: false }]), deps(socket).deps),
    (error: any) => error.code === 'not_connected',
  );
  assert.equal(calls.length, 1);
});

test('a refused create is create_failed; a timed-out create stays in_progress', async () => {
  const refused = fakeSocket({ createError: boom(403) });
  await assert.rejects(
    runGroupCreate(request([{ key: 'c:1', jid: pn(1), admin: false }]), deps(refused.socket).deps),
    (error: any) => error.code === 'create_failed',
  );
  const timedOut = fakeSocket({ createError: boom(408) });
  await assert.rejects(
    runGroupCreate(request([{ key: 'c:1', jid: pn(1), admin: false }]), deps(timedOut.socket).deps),
    (error: any) => error.code === 'in_progress',
  );
  const closed = fakeSocket({ createError: new Error('Connection Closed') });
  await assert.rejects(
    runGroupCreate(request([{ key: 'c:1', jid: pn(1), admin: false }]), deps(closed.socket).deps),
    (error: any) => error.code === 'in_progress',
  );
});

test('a first invitee missing from the create answer is added again to learn why', async () => {
  const { socket, calls } = fakeSocket({ createParticipants: () => [], addStatus: { [pn(1)]: '403' } });
  const harness = deps(socket);
  const reply = await runGroupCreate(request([{ key: 'c:1', jid: pn(1), admin: false }]), harness.deps);
  assert.deepEqual(
    calls.filter((call) => call.method === 'add').map((call) => call.args[1]),
    [[pn(1)]],
  );
  assert.equal(reply.invitees[0].reason, 'privacy');
  assert.deepEqual(harness.sleeps, []);
});

test('LID participants in the create answer match the requested phone JIDs', async () => {
  const byPhoneAttr = fakeSocket({
    createParticipants: () => [{ id: '99000000000001@lid', phoneNumber: pn(1) }],
  });
  const first = await runGroupCreate(
    request([{ key: 'c:1', jid: pn(1), admin: false }]),
    deps(byPhoneAttr.socket).deps,
  );
  assert.equal(first.invitees[0].outcome, 'added');
  assert.equal(byPhoneAttr.calls.filter((call) => call.method === 'add').length, 0);

  const bySignalMapping = fakeSocket({ createParticipants: () => [{ id: '99000000000002@lid' }] });
  const second = await runGroupCreate(
    request([{ key: 'c:1', jid: pn(1), admin: false }]),
    deps(bySignalMapping.socket, {
      resolvePhoneJidForLid: async (lid) => (lid === '99000000000002@lid' ? pn(1) : null),
    }).deps,
  );
  assert.equal(second.invitees[0].outcome, 'added');
  assert.equal(bySignalMapping.calls.filter((call) => call.method === 'add').length, 0);
});

test('colleagues are promoted in one call; LID promote answers match through the mapping', async () => {
  const lidOf: Record<string, string> = { [pn(2)]: '99000000000102@lid', [pn(3)]: '99000000000103@lid' };
  const { socket, calls } = fakeSocket({
    promoteResult: (jids) => jids.map((jid) => ({ status: jid === pn(3) ? '403' : '200', jid: lidOf[jid] })),
  });
  const reply = await runGroupCreate(
    request([
      { key: 'c:1', jid: pn(1), admin: false },
      { key: 'i:2', jid: pn(2), admin: true },
      { key: 'u:3', jid: pn(3), admin: true },
    ]),
    deps(socket, {
      resolvePhoneJidForLid: async (lid) => Object.keys(lidOf).find((jid) => lidOf[jid] === lid) ?? null,
    }).deps,
  );
  assert.deepEqual(calls.find((call) => call.method === 'promote')?.args, [GROUP, [pn(2), pn(3)]]);
  assert.deepEqual(
    reply.invitees.map(({ key, admin }) => [key, admin]),
    [
      ['c:1', null],
      ['i:2', 'promoted'],
      ['u:3', 'failed'],
    ],
  );
  assert.equal(reply.invite_link, null);
  assert.equal(
    calls.some((call) => call.method === 'invite'),
    false,
  );
});

test('a failed promote keeps the members and marks the admin step failed', async () => {
  const { socket } = fakeSocket({ promoteError: boom(500) });
  const harness = deps(socket);
  const reply = await runGroupCreate(
    request([
      { key: 'i:1', jid: pn(1), admin: true },
      { key: 'c:2', jid: pn(2), admin: false },
    ]),
    harness.deps,
  );
  assert.deepEqual(
    reply.invitees.map(({ key, outcome, admin }) => [key, outcome, admin]),
    [
      ['i:1', 'added', 'failed'],
      ['c:2', 'added', null],
    ],
  );
  assert.ok(harness.logs.includes('chatwoot_group_create_promote_failed'));
});

test('a skipped colleague is not promoted', async () => {
  const { socket, calls } = fakeSocket({ addStatus: { [pn(2)]: '403' } });
  const reply = await runGroupCreate(
    request([
      { key: 'c:1', jid: pn(1), admin: false },
      { key: 'i:2', jid: pn(2), admin: true },
    ]),
    deps(socket).deps,
  );
  assert.equal(
    calls.some((call) => call.method === 'promote'),
    false,
  );
  assert.equal(reply.invitees[1].admin, null);
});

test('the picture is set from base64; a failure only marks the picture', async () => {
  const picture = { mime: 'image/jpeg', base64: Buffer.from('jpeg-bytes').toString('base64') };
  const ok = fakeSocket();
  const set = await runGroupCreate(
    request([{ key: 'c:1', jid: pn(1), admin: false }], { picture }),
    deps(ok.socket).deps,
  );
  assert.equal(set.picture, 'set');
  assert.deepEqual(ok.calls.find((call) => call.method === 'picture')?.args, [GROUP, 10]);

  const failing = fakeSocket({ pictureError: boom(500) });
  const failed = await runGroupCreate(
    request([{ key: 'c:1', jid: pn(1), admin: false }], { picture }),
    deps(failing.socket).deps,
  );
  assert.equal(failed.status, 'ok');
  assert.equal(failed.picture, 'failed');
});

test('a rate limit stops further adds', async () => {
  const { socket, calls } = fakeSocket({ addStatus: { [pn(2)]: '429' } });
  const reply = await runGroupCreate(
    request([1, 2, 3, 4].map((n) => ({ key: `c:${n}`, jid: pn(n), admin: false }))),
    deps(socket).deps,
  );
  assert.deepEqual(
    calls.filter((call) => call.method === 'add').map((call) => call.args[1]),
    [[pn(2)]],
  );
  assert.deepEqual(
    reply.invitees.map(({ reason }) => reason),
    [null, 'rate_limited', 'rate_limited', 'rate_limited'],
  );
});

test('a repeated JID copies the outcome of its first invitee', async () => {
  const { socket, calls } = fakeSocket();
  const reply = await runGroupCreate(
    request([
      { key: 'c:1', jid: pn(1), admin: false },
      { key: 'u:1', jid: pn(1), admin: true },
    ]),
    deps(socket).deps,
  );
  assert.equal(calls.filter((call) => call.method === 'add').length, 0);
  assert.deepEqual(
    reply.invitees.map(({ key, outcome, admin }) => [key, outcome, admin]),
    [
      ['c:1', 'added', null],
      ['u:1', 'added', 'promoted'],
    ],
  );
});

test('a Chatwoot conversation failure is retried and never fails the created group', async () => {
  const { socket } = fakeSocket();
  let attempts = 0;
  const harness = deps(socket, {
    ensureConversation: async () => {
      attempts++;
      if (attempts < 3) throw new Error('chatwoot 502');
      return { id: 5, database_id: 55 };
    },
  });
  const reply = await runGroupCreate(request([{ key: 'c:1', jid: pn(1), admin: false }]), harness.deps);
  assert.deepEqual(reply.conversation, { id: 5, database_id: 55 });
  assert.deepEqual(harness.sleeps, [1000, 2000]);

  const never = deps(fakeSocket().socket, {
    ensureConversation: async () => {
      throw new Error('down');
    },
  });
  const degraded = await runGroupCreate(request([{ key: 'c:1', jid: pn(1), admin: false }]), never.deps);
  assert.equal(degraded.status, 'ok');
  assert.equal(degraded.conversation, null);
});

test('request parsing rejects what the contract does not allow', () => {
  const valid = {
    event: 'group_create_request',
    v: 1,
    request_id: '6f1c2b8e-4c6f-4c7e-9b0a-1d2e3f4a5b6c',
    account: { id: 1 },
    inbox: { id: 42 },
    subject: '  Visa team ',
    picture: null,
    invitees: [{ key: 'c:1', kind: 'contact', jid: pn(1), admin: false, telegram_user_id: null }],
  };
  const parsed = parseGroupCreateRequest(valid);
  assert.equal(parsed.subject, 'Visa team');
  assert.deepEqual(parsed.invitees, [{ key: 'c:1', jid: pn(1), admin: false }]);

  const invalid = [
    { ...valid, v: 2 },
    { ...valid, request_id: 'x' },
    { ...valid, subject: '' },
    { ...valid, subject: 'x'.repeat(101) },
    { ...valid, inbox: { id: 'abc' } },
    { ...valid, invitees: Array.from({ length: 21 }, (_, i) => ({ key: `c:${i}`, jid: pn(i), admin: false })) },
    { ...valid, invitees: [valid.invitees[0], valid.invitees[0]] },
    { ...valid, picture: { mime: 'image/gif', base64: 'AAAA' } },
    { ...valid, picture: { mime: 'image/jpeg', base64: 'A'.repeat(400_000) } },
  ];
  for (const body of invalid)
    assert.throws(
      () => parseGroupCreateRequest(body),
      (error: any) => error.code === 'invalid_request',
    );
});

test('gates: empty list is off, names, ids and * are on; a peer allowlist refuses', () => {
  const instance = { instanceName: 't-test', instanceId: 'uuid-1' };
  assert.equal(groupCreateInstanceEnabled(instance, ''), false);
  assert.equal(groupCreateInstanceEnabled(instance, ' , '), false);
  assert.equal(groupCreateInstanceEnabled(instance, 'other'), false);
  assert.equal(groupCreateInstanceEnabled(instance, 'other, t-test'), true);
  assert.equal(groupCreateInstanceEnabled(instance, 'uuid-1'), true);
  assert.equal(groupCreateInstanceEnabled(instance, '*'), true);
  assert.equal(groupCreatePeerAllowlistActive(''), false);
  assert.equal(groupCreatePeerAllowlistActive('*'), false);
  assert.equal(groupCreatePeerAllowlistActive('120363431310229945@g.us'), true);
});

test('add status mapping and bare JIDs', () => {
  assert.deepEqual(groupAddOutcome('200'), { outcome: 'added', reason: null });
  assert.deepEqual(groupAddOutcome('403'), { outcome: 'skipped', reason: 'privacy' });
  assert.deepEqual(groupAddOutcome('408'), { outcome: 'skipped', reason: 'left_recently' });
  assert.deepEqual(groupAddOutcome('409'), { outcome: 'added', reason: null });
  assert.deepEqual(groupAddOutcome('401'), { outcome: 'skipped', reason: 'blocked' });
  assert.deepEqual(groupAddOutcome('500'), { outcome: 'skipped', reason: 'failed' });
  assert.equal(bareWhatsappPhoneJid('628123456789:12@s.whatsapp.net'), '628123456789@s.whatsapp.net');
  assert.equal(bareWhatsappPhoneJid('628123456789@lid'), null);
  assert.equal(bareWhatsappPhoneJid('0123@s.whatsapp.net'), null);
});

const okReply = (requestId = 'req-0000-0001') =>
  ({
    status: 'ok',
    action: 'group_created_whatsapp',
    request_id: requestId,
    group_peer: GROUP,
    conversation: { id: 1, database_id: 2 },
    invite_link: null,
    picture: 'none',
    invitees: [],
  }) as const;

test('idempotency: one run per request id, the stored reply on repeat, in_progress meanwhile', async () => {
  const store = new LocalGroupCreateStore();
  const coordinator = new GroupCreateCoordinator(() => store);
  let runs = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const run = async () => {
    runs++;
    await gate;
    return okReply();
  };
  assert.deepEqual(await coordinator.status('k'), { status: 'unknown' });
  const firstCall = coordinator.create('k', run);
  const secondCall = coordinator.create('k', run);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await coordinator.status('k'), { status: 'in_progress' });
  // Another process holding the same store sees the claim.
  const otherProcess = new GroupCreateCoordinator(() => store);
  await assert.rejects(otherProcess.create('k', run), (error: any) => error.code === 'in_progress');
  assert.deepEqual(await otherProcess.status('k'), { status: 'in_progress' });
  release();
  assert.deepEqual(await firstCall, okReply());
  assert.deepEqual(await secondCall, okReply());
  assert.deepEqual(await coordinator.create('k', run), okReply());
  assert.deepEqual(await otherProcess.status('k'), okReply());
  assert.equal(runs, 1);
});

test('idempotency: a definite rejection releases the claim; an uncertain or unexpected one keeps in_progress', async () => {
  const store = new LocalGroupCreateStore();
  const coordinator = new GroupCreateCoordinator(() => store);
  await assert.rejects(
    coordinator.create('a', async () => {
      throw new GroupCreateError('not_connected');
    }),
    (error: any) => error.code === 'not_connected',
  );
  // Nothing was created: after a reconnect the same request id may run.
  assert.deepEqual(await coordinator.status('a'), { status: 'unknown' });
  assert.deepEqual(await coordinator.create('a', async () => okReply()), okReply());

  await assert.rejects(
    coordinator.create('b', async () => {
      throw new GroupCreateError('in_progress');
    }),
    (error: any) => error.code === 'in_progress',
  );
  assert.deepEqual(await coordinator.status('b'), { status: 'in_progress' });
  await assert.rejects(
    coordinator.create('b', async () => assert.fail('must not run again')),
    (error: any) => error.code === 'in_progress',
  );

  await assert.rejects(
    coordinator.create('c', async () => {
      throw new TypeError('bug somewhere');
    }),
    (error: any) => error.code === 'in_progress',
  );
  assert.deepEqual(await coordinator.status('c'), { status: 'in_progress' });
});

test('idempotency: a store that is down refuses before anything runs', async () => {
  const coordinator = new GroupCreateCoordinator(() => ({
    claim: async () => {
      throw new Error('redis down');
    },
    get: async () => null,
    put: async () => undefined,
    release: async () => undefined,
  }));
  await assert.rejects(
    coordinator.create('k', async () => assert.fail('must not run')),
    (error: any) => error.code === 'not_connected',
  );
});

test('the local store forgets after 24 h', async () => {
  const clock = { now: 0 };
  const store = new LocalGroupCreateStore(24 * 3600_000, () => clock.now);
  assert.equal(await store.claim('k'), true);
  assert.equal(await store.claim('k'), false);
  clock.now += 24 * 3600_000;
  assert.equal(await store.get('k'), null);
  assert.equal(await store.claim('k'), true);
});

test('the Redis store claims with SET NX EX and keeps the final reply for 24 h', async () => {
  const sets: any[] = [];
  const data = new Map<string, string>();
  const client = {
    set: async (key: string, value: string, options: any) => {
      sets.push({ key, options });
      if (options.NX && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
    get: async (key: string) => data.get(key) ?? null,
    del: async (key: string) => Number(data.delete(key)),
  };
  const store = new RedisGroupCreateStore(() => client, 'evolution:');
  assert.equal(await store.claim('group_create:i:r'), true);
  assert.equal(await store.claim('group_create:i:r'), false);
  assert.deepEqual(await store.get('group_create:i:r'), { status: 'in_progress' });
  await store.put('group_create:i:r', okReply());
  assert.deepEqual(await store.get('group_create:i:r'), okReply());
  assert.deepEqual(sets[0], { key: 'evolution:group_create:i:r', options: { NX: true, EX: 86400 } });
  assert.deepEqual(sets[2].options, { EX: 86400 });
  await store.release('group_create:i:r');
  assert.equal(await store.get('group_create:i:r'), null);
});
