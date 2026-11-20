import assert from 'node:assert/strict';
import test from 'node:test';

import P from 'pino';

import { hashJid, StanzaTrace, traceBaileysLogger } from '../src/api/integrations/channel/whatsapp/stanza-trace';

const PHONE = '6281234567890';

test('JIDs are hashed: no phone number in clear; server and status addresses stay readable', () => {
  assert.equal(hashJid('status@broadcast'), 'status@broadcast');
  assert.equal(hashJid('s.whatsapp.net'), 's.whatsapp.net');
  const hashed = hashJid(`${PHONE}@s.whatsapp.net`)!;
  assert.match(hashed, /^[0-9a-f]{10}@s\.whatsapp\.net$/);
  assert(!hashed.includes(PHONE));
  assert.equal(hashed, hashJid(`${PHONE}@s.whatsapp.net`));
});

test('a stream error is logged with the inbound stanza and what we sent for that id, never content', () => {
  let now = 1_000;
  const lines: string[] = [];
  const trace = new StanzaTrace(
    'synthetic',
    (line) => lines.push(line),
    () => now,
  );
  trace.inbound({
    tag: 'message',
    attrs: {
      id: 'STATUS1',
      from: 'status@broadcast',
      participant: `${PHONE}@s.whatsapp.net`,
      type: 'media',
      offline: '0',
    },
    content: [{ tag: 'enc', attrs: { type: 'skmsg' }, content: Buffer.from('secret ciphertext') }],
  });
  trace.baileysDebug([
    {
      recv: { tag: 'message', attrs: { id: 'STATUS1' } },
      sent: {
        id: 'STATUS1',
        to: 'status@broadcast',
        class: 'message',
        type: 'media',
        participant: `${PHONE}@s.whatsapp.net`,
      },
    },
    'sent ack',
  ]);
  trace.inbound({ tag: 'iq', attrs: { id: 'IQ1' } });
  now += 3_000_000;
  trace.streamError({
    tag: 'stream:error',
    attrs: {},
    content: [{ tag: 'ack', attrs: { class: 'status', type: 'media', id: 'STATUS1' } }],
  });
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, 'stanza_trace_stream_error');
  assert.equal(event.seenBeforeMs, 3_000_000);
  assert.deepEqual(
    event.history.map((entry: any) => [entry.dir, entry.tag, entry.cls ?? null, entry.from, entry.children ?? null]),
    [
      ['in', 'message', null, 'status@broadcast', 'enc:skmsg'],
      ['ack', 'message', 'message', 'status@broadcast', null],
    ],
  );
  assert(!lines[0].includes(PHONE));
  assert(!lines[0].includes('secret'));
  trace.report();
  const counts = JSON.parse(lines[1]);
  assert.equal(counts.counts['message:media:status'], 1);
  assert.equal(counts.counts.iq, undefined);
});

test('an unknown id still logs the error (seenBeforeMs null)', () => {
  const lines: string[] = [];
  const trace = new StanzaTrace('synthetic', (line) => lines.push(line));
  trace.streamError({
    tag: 'stream:error',
    attrs: {},
    content: [{ tag: 'ack', attrs: { class: 'status', id: 'NEVER' } }],
  });
  assert.equal(JSON.parse(lines[0]).seenBeforeMs, null);
});

test('the logger proxy forwards every call unchanged, keeps the level and proxies children', () => {
  const written: string[] = [];
  const base = P({ level: 'error' }, { write: (s: string) => written.push(s) });
  const seen: unknown[][] = [];
  const logger = traceBaileysLogger(base, (args) => seen.push(args));
  assert.equal(logger.level, 'error');
  logger.debug({ a: 1 }, 'sent ack');
  const child = logger.child({ class: 'x' });
  assert.equal(child.level, 'error');
  child.debug({ b: 2 }, 'sending receipt for messages');
  child.error({ c: 3 }, 'boom');
  assert.deepEqual(seen, [
    [{ a: 1 }, 'sent ack'],
    [{ b: 2 }, 'sending receipt for messages'],
  ]);
  assert.equal(written.length, 1);
  assert.match(written[0], /boom/);
});
