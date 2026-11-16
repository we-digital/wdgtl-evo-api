/**
 * Chatwoot asks whether phone numbers from a shared contact card have WhatsApp
 * (`contact_reachability_request`, contract v1 2026-11-16, side-session notes
 * contact-reachability-contract-20261116). One request carries up to 10
 * numbers for this instance and is answered with one `whatsappNumber` check.
 * Errors are answered as `{status:'error', code}` with 200: a failed check
 * only greys nothing out in Chatwoot, it never blocks a send.
 *
 * Gate: CHATWOOT_CONTACT_DISCOVERY_INSTANCES (instance names or ids, "*"; empty = off).
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
): Promise<ContactReachabilityReply> {
  if (!phones.length) return { status: 'error', code: 'invalid_request' };
  const digits = phones.map((phone) => phone.replace(/^\+/, ''));
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
    results: phones.map((phone, index) => {
      const row = list.find((candidate) => candidate?.number === digits[index]);
      if (!row) return { phone, reachable: null, jid: null, reason: 'no_answer' };
      const jid = row.exists && /^[1-9][0-9]{4,19}@s\.whatsapp\.net$/.test(row.jid) ? row.jid : null;
      return row.exists
        ? { phone, reachable: true, jid }
        : { phone, reachable: false, jid: null, reason: 'not_on_whatsapp' };
    }),
  };
}
