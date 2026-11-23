import assert from 'node:assert/strict';
import test from 'node:test';

import { BaileysStartupService } from '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await tick(25);
  return check();
}

// The f-bukit 11-23 shape: one step never settles; live messages and the close of a
// restart must still be handled.
function harness() {
  const seen: string[] = [];
  const logs: string[] = [];
  let process!: (events: any) => Promise<void>;
  const wa: any = Object.create(BaileysStartupService.prototype);
  wa.instance = { id: 'synthetic-instance', name: 'synthetic', authState: { saveCreds: () => seen.push('creds') } };
  wa.instanceId = 'synthetic-instance';
  wa.endSession = false;
  wa.logger = {
    info() {},
    warn: (line: string) => logs.push(line),
    error: (line: string) => logs.push(String(line)),
    debug() {},
  };
  wa.configService = { get: () => ({ ENABLED: false }) };
  wa.findSettings = async () => ({});
  wa.connectionUpdate = async (update: any) => seen.push(`connection:${update.connection}`);
  wa.messageHandle = {
    'messaging-history.set': () => new Promise(() => {}),
    'messages.upsert': async ({ messages }: any) => seen.push(`upsert:${messages[0].key.id}`),
    'messages.update': async () => {
      throw new Error('update failed');
    },
  };
  wa.contactHandle = { 'contacts.upsert': async () => seen.push('contacts') };
  wa.chatHandle = {};
  wa.groupHandler = {};
  wa.labelHandle = {};
  wa.client = { ev: { process: (handler: any) => (process = handler) } };
  return { wa, seen, logs, emit: (events: any) => process(events) };
}

test('a hung history step does not hold live messages, connection or credentials', async () => {
  const prior = globalThis.process.env.EVO_EVENT_STEP_STALL_MS;
  globalThis.process.env.EVO_EVENT_STEP_STALL_MS = '5000';
  try {
    const { wa, seen, logs, emit } = harness();
    wa.eventHandler(1);

    // Same buffer: the live message is handled even though history hangs.
    await emit({
      'messaging-history.set': { messages: [], chats: [], contacts: [] },
      'messages.upsert': { messages: [{ key: { id: 'LIVE-1' } }], type: 'notify' },
    });
    assert.ok(await until(() => seen.includes('upsert:LIVE-1')));
    assert.deepEqual(seen, ['upsert:LIVE-1']);

    // Restart close and new creds are handled at once, not behind the hung step.
    await emit({ 'connection.update': { connection: 'close' }, 'creds.update': {} });
    assert.ok(await until(() => seen.includes('connection:close') && seen.includes('creds'), 2_000));

    // A data batch queued behind the hung step runs after the stall threshold.
    await emit({ 'messages.upsert': { messages: [{ key: { id: 'LIVE-2' } }], type: 'notify' } });
    await tick(50);
    assert.ok(!seen.includes('upsert:LIVE-2'));
    assert.ok(await until(() => seen.includes('upsert:LIVE-2')));
    assert.ok(logs.some((line) => line.includes('whatsapp_event_step_stalled') && line.includes('messaging-history.set')));
  } finally {
    if (prior === undefined) delete globalThis.process.env.EVO_EVENT_STEP_STALL_MS;
    else globalThis.process.env.EVO_EVENT_STEP_STALL_MS = prior;
  }
});

test('a failing event type does not drop the others of the same batch', async () => {
  const { wa, seen, logs, emit } = harness();
  wa.eventHandler(1);
  await emit({
    'messages.update': [{}],
    'contacts.upsert': [{ id: '1@s.whatsapp.net' }],
  });
  assert.ok(await until(() => seen.includes('contacts')));
  assert.ok(logs.some((line) => line.includes('messages.update failed')));
});
