/**
 * Chatwoot asks whether phone numbers from a shared contact card have WhatsApp
 * (`contact_reachability_request`, contract v1 2026-11-16, side-session notes
 * contact-reachability-contract-20261116). One request carries up to 10
 * numbers for this instance and is answered with one `whatsappNumber` check.
 * Errors are answered as `{status:'error', code}` with 200: a failed check
 * only greys nothing out in Chatwoot, it never blocks a send.
 *
 * Gate: CHATWOOT_CONTACT_DISCOVERY_INSTANCES (instance names or ids, "*"; empty = off).
 *
 * Budget (ban risk: WhatsApp watches accounts that look up many numbers): at
 * most CHATWOOT_CONTACT_DISCOVERY_PER_HOUR (default 20) and
 * CHATWOOT_CONTACT_DISCOVERY_PER_DAY (default 100) numbers per instance,
 * counted in Redis so restarts and replicas share it. Numbers over the budget
 * answer reachable:null / rate_limited without asking WhatsApp.
 */
export const CONTACT_REACHABILITY_EVENT = 'contact_reachability_request';
export const CONTACT_REACHABILITY_MAX_PHONES = 10;
export const CONTACT_REACHABILITY_TIMEOUT_MS = 5000;

export type ContactReachabilityRow = { phone: string; reachable: boolean | null; jid: string | null; reason?: string };
export type ContactReachabilityReply =
  | { status: 'ok'; results: ContactReachabilityRow[] }
  | { status: 'error'; code: string };

type NumberCheck = { jid: string; exists: boolean; number: string };

const PHONE = /^\+?[1-9][0-9]{6,14}$/;

export function parseReachabilityPhones(body: any): string[] {
  const phones = Array.isArray(body?.phones) ? body.phones : [];
  const out: string[] = [];
  for (const raw of phones) {
    if (typeof raw !== 'string') continue;
    const phone = raw.trim();
    if (!PHONE.test(phone)) continue;
    const e164 = phone.startsWith('+') ? phone : `+${phone}`;
    if (!out.includes(e164)) out.push(e164);
    if (out.length >= CONTACT_REACHABILITY_MAX_PHONES) break;
  }
  return out;
}

export interface LookupBudgetStore {
  /** Adds `count` to the window counter and returns the total after adding. */
  incr(key: string, count: number, windowSeconds: number): Promise<number>;
}

/** node-redis v4 client (EVO's cache connection). */
export class RedisLookupBudgetStore implements LookupBudgetStore {
  constructor(
    private readonly client: () => any,
    private readonly prefix = '',
  ) {}

  async incr(key: string, count: number, windowSeconds: number) {
    const fullKey = `${this.prefix}${key}`;
    const total = Number(await this.client().incrBy(fullKey, count));
    if (total === count) await this.client().expire(fullKey, windowSeconds);
    return total;
  }
}

/** Fallback when Redis is off: per process, lost on restart. */
export class LocalLookupBudgetStore implements LookupBudgetStore {
  private readonly counters = new Map<string, { total: number; until: number }>();

  constructor(private readonly now = () => Date.now()) {}

  async incr(key: string, count: number, windowSeconds: number) {
    const current = this.counters.get(key);
    const live =
      current && current.until > this.now() ? current : { total: 0, until: this.now() + windowSeconds * 1000 };
    live.total += count;
    this.counters.set(key, live);
    return live.total;
  }
}

const envLimit = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
};

/** How many of `count` new lookups this instance may still make (hour and day windows). */
export async function takeLookupBudget(
  store: LookupBudgetStore,
  instance: string,
  count: number,
  limits = {
    hour: envLimit('CHATWOOT_CONTACT_DISCOVERY_PER_HOUR', 20),
    day: envLimit('CHATWOOT_CONTACT_DISCOVERY_PER_DAY', 100),
  },
): Promise<number> {
  if (count <= 0) return 0;
  const hourKey = `chatwoot:contact_discovery:${instance}:h:${Math.floor(Date.now() / 3_600_000)}`;
  const dayKey = `chatwoot:contact_discovery:${instance}:d:${Math.floor(Date.now() / 86_400_000)}`;
  const [hour, day] = await Promise.all([store.incr(hourKey, count, 3_700), store.incr(dayKey, count, 90_000)]);
  const left = Math.min(limits.hour - (hour - count), limits.day - (day - count));
  return Math.max(0, Math.min(count, left));
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** Runs one batched number check and maps it back to the asked phones. */
export async function checkContactReachability(
  phones: string[],
  check: (numbers: string[]) => Promise<NumberCheck[]>,
  timeoutMs = CONTACT_REACHABILITY_TIMEOUT_MS,
  allowed = phones.length,
): Promise<ContactReachabilityReply> {
  if (!phones.length) return { status: 'error', code: 'invalid_request' };
  const limited = phones.slice(allowed).map((phone) => ({ phone, reachable: null, jid: null, reason: 'rate_limited' }));
  if (allowed <= 0) return { status: 'ok', results: limited };
  const asked = phones.slice(0, allowed);
  const digits = asked.map((phone) => phone.replace(/^\+/, ''));
  let rows: NumberCheck[] | 'timeout';
  try {
    rows = await withTimeout(check(digits), timeoutMs);
  } catch {
    return { status: 'error', code: 'failed' };
  }
  if (rows === 'timeout') return { status: 'error', code: 'timeout' };
  const list = Array.isArray(rows) ? rows : [];
  return {
    status: 'ok',
    results: [
      ...asked.map((phone, index) => {
        const row = list.find((candidate) => candidate?.number === digits[index]);
        if (!row) return { phone, reachable: null, jid: null, reason: 'no_answer' };
        const jid = row.exists && /^[1-9][0-9]{4,19}@s\.whatsapp\.net$/.test(row.jid) ? row.jid : null;
        return row.exists
          ? { phone, reachable: true, jid }
          : { phone, reachable: false, jid: null, reason: 'not_on_whatsapp' };
      }),
      ...limited,
    ],
  };
}
