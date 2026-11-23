import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_EVENT_STEP_STALL_MS,
  EventStepQueue,
  eventStepStallMs,
} from '../src/api/integrations/channel/whatsapp/whatsapp-event-queue';
import { fitVarChar, whatsappContactName } from '../src/utils/whatsapp-contact-name';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a step that never settles is reported and does not block the next batch', async () => {
  const stalls: any[] = [];
  const late: any[] = [];
  const done: string[] = [];
  const queue = new EventStepQueue({
    stallMs: 30,
    onStall: (report) => stalls.push(report),
    onLateSettle: (report) => late.push(report),
    onError: () => assert.fail('no error expected'),
  });

  let release!: () => void;
  void queue.push(['messaging-history.set'], async (stage) => {
    stage('messaging-history.set');
    await new Promise<void>((resolve) => (release = resolve));
  });
  const live = queue.push(['messages.upsert'], async () => {
    done.push('live');
  });

  await live;
  assert.deepEqual(done, ['live']);
  assert.equal(stalls.length, 1);
  assert.deepEqual(stalls[0].events, ['messaging-history.set']);
  assert.equal(stalls[0].stage, 'messaging-history.set');

  release();
  await tick(5);
  assert.equal(late.length, 1);
});

test('batches stay in order and a failing step does not stop the queue', async () => {
  const order: string[] = [];
  const errors: string[] = [];
  const queue = new EventStepQueue({
    stallMs: 1_000,
    onStall: () => assert.fail('no stall expected'),
    onError: (error: any, report) => errors.push(`${report.stage}:${error.message}`),
  });

  void queue.push(['a'], async () => {
    await tick(10);
    order.push('a');
  });
  void queue.push(['b'], async (stage) => {
    stage('history');
    throw new Error('InboundNativeSourceAmbiguous');
  });
  await queue.push(['c'], async () => {
    order.push('c');
  });

  assert.deepEqual(order, ['a', 'c']);
  assert.deepEqual(errors, ['history:InboundNativeSourceAmbiguous']);
});

test('stall threshold comes from the env with a safe floor', () => {
  assert.equal(eventStepStallMs(undefined), DEFAULT_EVENT_STEP_STALL_MS);
  assert.equal(eventStepStallMs('abc'), DEFAULT_EVENT_STEP_STALL_MS);
  assert.equal(eventStepStallMs('1000'), 5_000);
  assert.equal(eventStepStallMs('60000'), 60_000);
});

test('names fit the VarChar(100) columns by code point', () => {
  const emoji = '😀'.repeat(150);
  const fitted = fitVarChar(emoji);
  assert.equal(Array.from(fitted).length, 100);
  assert.equal(fitted, '😀'.repeat(100));
  assert.equal(fitVarChar('short'), 'short');
  assert.equal(fitVarChar(null), null);
  assert.equal(Array.from(whatsappContactName('x'.repeat(250))!).length, 100);
});
