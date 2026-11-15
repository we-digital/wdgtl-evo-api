import assert from 'node:assert/strict';
import test from 'node:test';

import { GroupResolveStats } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-group-resolve-stats';

test('group resolve stats count resolves, joins, errors and duration', () => {
  const clock = { now: 0 };
  const stats = new GroupResolveStats(() => clock.now, 60_000);
  const first = stats.begin();
  const second = stats.begin();
  stats.join();
  assert.equal(stats.snapshot().inFlight, 2);
  clock.now += 120;
  assert.equal(first(true), 120);
  clock.now += 30;
  assert.equal(second(false), 150);
  // A second finish call is ignored.
  second(false);
  assert.deepEqual(stats.snapshot(), {
    resolves: 2,
    joins: 1,
    errors: 1,
    inFlight: 0,
    durationMsSum: 270,
    durationMsMax: 150,
  });
  const lines = stats.lines().join('\n');
  assert.match(lines, /^evolution_chatwoot_group_resolves_total 2$/m);
  assert.match(lines, /^evolution_chatwoot_group_resolve_joins_total 1$/m);
  assert.match(lines, /^evolution_chatwoot_group_resolve_errors_total 1$/m);
  assert.match(lines, /^evolution_chatwoot_group_resolve_in_flight 0$/m);
  assert.match(lines, /^evolution_chatwoot_group_resolve_duration_seconds_sum 0.27$/m);
});

test('the summary covers its own window, at most once per interval, and only when something happened', () => {
  const clock = { now: 0 };
  const stats = new GroupResolveStats(() => clock.now, 60_000);
  stats.begin()(true);
  assert.equal(stats.takeSummary(), null);
  clock.now = 60_000;
  assert.deepEqual(stats.takeSummary(), {
    resolves: 1,
    joins: 0,
    errors: 0,
    inFlight: 0,
    avgMs: 0,
    durationMsMax: 0,
    windowMs: 60_000,
  });
  clock.now = 120_000;
  assert.equal(stats.takeSummary(), null);
  const finish = stats.begin();
  clock.now = 120_500;
  finish(false);
  stats.join();
  clock.now = 180_000;
  assert.deepEqual(stats.takeSummary(), {
    resolves: 1,
    joins: 1,
    errors: 1,
    inFlight: 0,
    avgMs: 500,
    durationMsMax: 500,
    windowMs: 60_000,
  });
});
