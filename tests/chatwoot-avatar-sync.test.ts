import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  AvatarMarker,
  AvatarPicture,
  AvatarSyncDeps,
  AvatarSyncJob,
  AvatarSyncQueue,
  chatwootContactJid,
  classifyProfilePictureError,
  isSyncableAvatarJid,
  reusableWhatsappUrl,
  whatsappPictureId,
  whatsappUrlExpiresAt,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-avatar-sync';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 12, 16, 0, 0);
const hex = (ms: number) =>
  Math.floor(ms / 1000)
    .toString(16)
    .toUpperCase();
const cdn = (file: string, expiresAt: number) =>
  `https://pps.whatsapp.net/v/t61.24694-24/${file}?ccb=11-4&oh=01_Q5Aa&oe=${hex(expiresAt)}&_nc_sid=5e03e0&_nc_cat=1`;

type Harness = {
  queue: AvatarSyncQueue;
  clock: { now: number };
  sleeps: number[];
  fetches: string[];
  applied: { jid: string; url: string | null; force?: boolean }[];
  markers: Map<string, AvatarMarker>;
  logs: string[];
};

const harness = (
  options: {
    perMinute?: number;
    peek?: (jid: string) => AvatarPicture | null;
    fetch?: (jid: string) => AvatarPicture;
    markers?: [string, AvatarMarker][];
    rateLimitPauseMs?: number;
    maxRateLimitStrikes?: number;
  } = {},
): Harness => {
  const clock = { now: T0 };
  const sleeps: number[] = [];
  const fetches: string[] = [];
  const applied: Harness['applied'] = [];
  const markers = new Map(options.markers ?? []);
  const logs: string[] = [];
  const deps: AvatarSyncDeps = {
    readMarker: async (jid) => markers.get(jid) ?? null,
    writeMarker: async (jid, marker) => void markers.set(jid, marker),
    peekPicture: async (jid) => options.peek?.(jid) ?? null,
    fetchPicture: async (jid) => {
      fetches.push(jid);
      return (
        options.fetch?.(jid) ?? { kind: 'picture', url: cdn(`${jid}.jpg`, clock.now + 10 * DAY), source: 'whatsapp' }
      );
    },
    apply: async (job, url) => {
      applied.push({ jid: job.jid, url, force: job.force });
      return url ? 'applied' : job.force ? 'cleared' : 'unchanged';
    },
    log: (event) => void logs.push(event),
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  };
  const queue = new AvatarSyncQueue('t-test', deps, {
    perMinute: options.perMinute ?? 12,
    refreshMs: 7 * DAY,
    rateLimitPauseMs: options.rateLimitPauseMs ?? 15 * 60_000,
    maxRateLimitStrikes: options.maxRateLimitStrikes ?? 3,
  });
  return { queue, clock, sleeps, fetches, applied, markers, logs };
};

const job = (jid: string, extra: Partial<AvatarSyncJob> = {}): AvatarSyncJob => ({
  jid,
  lane: 'backfill',
  reason: 'test',
  ...extra,
});

test('WhatsApp CDN URL helpers read the picture id and expiry', () => {
  const url = cdn('491112223_n.jpg', T0 + 3 * DAY);
  assert.equal(whatsappPictureId(url), '491112223_n.jpg');
  assert.equal(whatsappPictureId(null), '');
  assert.equal(whatsappUrlExpiresAt(url), Math.floor((T0 + 3 * DAY) / 1000) * 1000);
  assert.equal(whatsappUrlExpiresAt('https://example.com/a.jpg'), null);
  assert.equal(reusableWhatsappUrl(url, T0), true);
  assert.equal(reusableWhatsappUrl(cdn('a.jpg', T0 + 60_000), T0), false, 'expires within the safety margin');
  assert.equal(reusableWhatsappUrl(cdn('a.jpg', T0 - DAY), T0), false);
  assert.equal(reusableWhatsappUrl(null, T0), false);
});

test('profile picture errors: hidden picture, rate limit, transient', () => {
  assert.equal(classifyProfilePictureError({ message: 'item-not-found', output: { statusCode: 404 } }), 'none');
  assert.equal(classifyProfilePictureError({ message: 'not-authorized', data: 401 }), 'none');
  assert.equal(classifyProfilePictureError({ message: 'rate-overlimit', output: { statusCode: 429 } }), 'rate-limited');
  assert.equal(classifyProfilePictureError({ message: 'Timed Out', output: { statusCode: 408 } }), 'error');
  assert.equal(classifyProfilePictureError({ message: 'Connection Closed', output: { statusCode: 428 } }), 'error');
  assert.equal(classifyProfilePictureError(undefined), 'error');
});

test('maps Chatwoot contacts to WhatsApp jids', () => {
  assert.equal(chatwootContactJid('628111@s.whatsapp.net', null), '628111@s.whatsapp.net');
  assert.equal(chatwootContactJid('120363000000000001@g.us', null), '120363000000000001@g.us');
  assert.equal(chatwootContactJid('99887766@lid', null), '99887766@lid');
  assert.equal(chatwootContactJid(null, '+62 811-1234-567'), '628111234567@s.whatsapp.net');
  assert.equal(chatwootContactJid('tg:12345', null), null, 'Telegram contacts are not ours');
  assert.equal(chatwootContactJid(null, '0811'), null);
  assert.equal(isSyncableAvatarJid('status@broadcast'), false);
  assert.equal(isSyncableAvatarJid('0@s.whatsapp.net'), false);
});

test('paces WhatsApp fetches per instance and stores markers', async () => {
  const h = harness({ perMinute: 12 });
  for (const n of ['1', '2', '3']) h.queue.enqueue(job(`62811${n}@s.whatsapp.net`));
  await h.queue.idle();
  assert.equal(h.fetches.length, 3);
  // First fetch goes at once, the next ones 5 s apart (12 per minute).
  assert.deepEqual(h.sleeps, [5_000, 5_000]);
  assert.equal(h.applied.length, 3);
  assert.equal(h.markers.get('628111@s.whatsapp.net')?.pictureId, '628111@s.whatsapp.net.jpg');
  assert.equal(h.queue.stats.applied, 3);
  assert.equal(h.queue.stats.whatsappFetches, 3);
});

test('a fresh marker skips the contact; a stale one is checked again', async () => {
  const h = harness({
    markers: [
      ['fresh@s.whatsapp.net', { pictureId: '', checkedAt: T0 - DAY }],
      ['stale@s.whatsapp.net', { pictureId: 'old.jpg', checkedAt: T0 - 8 * DAY }],
    ],
  });
  h.queue.enqueue(job('fresh@s.whatsapp.net'));
  h.queue.enqueue(job('stale@s.whatsapp.net'));
  await h.queue.idle();
  assert.deepEqual(h.fetches, ['stale@s.whatsapp.net']);
  assert.equal(h.queue.stats.fresh, 1);
  // Repeated activity after a check is dropped in memory, without a marker read.
  assert.equal(h.queue.enqueue(job('stale@s.whatsapp.net', { lane: 'live' })), false);
});

test('reuses an unexpired stored URL without asking WhatsApp', async () => {
  const stored = cdn('stored.jpg', T0 + 5 * DAY);
  const h = harness({ peek: () => ({ kind: 'picture', url: stored, source: 'stored' }) });
  h.queue.enqueue(job('62822@s.whatsapp.net'));
  await h.queue.idle();
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.applied[0].url, stored);
  assert.equal(h.queue.stats.reusedUrls, 1);
});

test('no visible picture leaves a "none" marker and does not clear Chatwoot', async () => {
  const h = harness({ fetch: () => ({ kind: 'none', source: 'whatsapp' }) });
  h.queue.enqueue(job('hidden@s.whatsapp.net'));
  await h.queue.idle();
  assert.deepEqual(h.applied, [{ jid: 'hidden@s.whatsapp.net', url: null, force: undefined }]);
  assert.equal(h.markers.get('hidden@s.whatsapp.net')?.pictureId, '');
  assert.equal(h.queue.stats.none, 1);
  assert.equal(h.queue.stats.cleared, 0);
});

test('a picture event forces a WhatsApp fetch past markers and caches', async () => {
  const h = harness({
    peek: () => ({ kind: 'picture', url: cdn('cached.jpg', T0 + 5 * DAY), source: 'cache' }),
    markers: [['g1@g.us', { pictureId: 'cached.jpg', checkedAt: T0 - 60_000 }]],
  });
  h.queue.enqueue(job('g1@g.us', { lane: 'live', force: true }));
  await h.queue.idle();
  assert.deepEqual(h.fetches, ['g1@g.us']);
  assert.equal(h.applied[0].force, true);
});

test('live jobs go first; duplicates merge and move up', async () => {
  const h = harness({ perMinute: 60 });
  // Hold the worker on the first job so the rest queue up behind it.
  h.queue.enqueue(job('a@s.whatsapp.net'));
  h.queue.enqueue(job('b@s.whatsapp.net'));
  h.queue.enqueue(job('c@s.whatsapp.net'));
  assert.equal(h.queue.enqueue(job('c@s.whatsapp.net', { lane: 'live' })), true);
  h.queue.enqueue(job('d@s.whatsapp.net', { lane: 'live' }));
  await h.queue.idle();
  assert.deepEqual(h.fetches, ['a@s.whatsapp.net', 'c@s.whatsapp.net', 'd@s.whatsapp.net', 'b@s.whatsapp.net']);
});

test('rate limit pauses the instance, retries, and drops backfill after repeated hits', async () => {
  let limited = 3;
  const h = harness({
    perMinute: 60,
    rateLimitPauseMs: 600_000,
    maxRateLimitStrikes: 3,
    fetch: (jid) =>
      limited-- > 0
        ? { kind: 'rate-limited' }
        : { kind: 'picture', url: cdn(`${jid}.jpg`, T0 + 9 * DAY), source: 'whatsapp' },
  });
  for (const n of ['1', '2', '3', '4']) h.queue.enqueue(job(`6283${n}@s.whatsapp.net`));
  await h.queue.idle();
  assert.equal(h.queue.stats.rateLimited, 3);
  assert.ok(h.sleeps.filter((ms) => ms >= 600_000 - 1_000).length >= 2, 'waits out each pause');
  assert.equal(h.queue.stats.backfillDropped, 3, 'the rest of the backfill is dropped after 3 strikes');
  assert.equal(h.applied.length, 0, 'the struck backfill job is not retried');
  assert.ok(h.logs.includes('chatwoot_avatar_sync_rate_limited'));

  // Live work still runs after the pause.
  h.queue.enqueue(job('live@s.whatsapp.net', { lane: 'live' }));
  await h.queue.idle();
  assert.deepEqual(
    h.applied.map((a) => a.jid),
    ['live@s.whatsapp.net'],
  );
});

test('enqueue is synchronous and bounded', () => {
  const h = harness();
  const started = Date.now();
  let accepted = 0;
  for (let i = 0; i < 25_000; i++) if (h.queue.enqueue(job(`62${i}@s.whatsapp.net`))) accepted++;
  assert.ok(Date.now() - started < 1_000);
  // The worker takes the first job at once; the backfill lane then holds 20k.
  assert.equal(accepted, 20_001);
  assert.equal(h.queue.stats.droppedFull, 4_999);
  assert.equal(h.queue.enqueue(job('not-a-jid')), false);
  h.queue.stop();
});

test('no WhatsApp picture query on the inbound delivery and ingest paths', () => {
  const chatwoot = fs.readFileSync('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', 'utf8');
  const createConversation = chatwoot.slice(
    chatwoot.indexOf('public async createConversation('),
    chatwoot.indexOf('public async getInbox('),
  );
  assert.ok(createConversation.length > 1_000, 'createConversation found');
  assert.doesNotMatch(createConversation, /\.profilePicture\(/);
  assert.match(createConversation, /enqueueAvatarSync\(/);

  const baileys = fs.readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'utf8');
  assert.doesNotMatch(baileys, /cachedProfilePictureUrl\(/);
  const contactsUpdate = baileys.slice(
    baileys.indexOf("'contacts.update': async"),
    baileys.indexOf('private readonly messageHandle'),
  );
  assert.doesNotMatch(contactsUpdate, /profilePicture\(/);
  assert.match(contactsUpdate, /enqueueAvatarSync\(/);
});
