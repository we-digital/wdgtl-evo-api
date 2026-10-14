import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiOutboundConflict, ApiOutboundHooks, ApiOutboundOperations, ApiOutboundRecord,
  ApiOutboundStore, isApiNonRecipient } from '../src/api/services/api-outbound-operation';

const id = '00112233-4455-8677-8899-aabbccddeeff';
const peer = '628111111111@s.whatsapp.net';
const payload = { number: '628111111111', text: 'Synthetic notification' };
const clone = <T>(value: T): T => structuredClone(value);

class Store implements ApiOutboundStore {
  row: ApiOutboundRecord | null = null;
  retained: any = null;
  async admit(key: string, instanceId: string, fingerprint: string) {
    if (!this.row) this.row = { id: key, instanceId, fingerprint, state: 'pending',
      plannedWhatsappMessageId: 'WN00112233445586778899AABB', destinationJid: null, result: null,
      claimToken: null, leaseExpiresAt: null, transportStartedAt: null, nextAttemptAt: new Date(0),
      attempts: 0, lastErrorCode: null };
    if (this.row.fingerprint !== fingerprint || this.row.instanceId !== instanceId) throw new ApiOutboundConflict();
    return clone(this.row);
  }
  async read(key: string, instanceId: string) {
    if (!this.row || key !== this.row.id) return null;
    if (this.row.instanceId !== instanceId) throw new ApiOutboundConflict();
    return clone(this.row);
  }
  async claim(row: ApiOutboundRecord, token: string, now: Date, until: Date) {
    if (this.row!.attempts !== row.attempts || this.row!.state !== row.state ||
        this.row!.nextAttemptAt > now || (this.row!.leaseExpiresAt && this.row!.leaseExpiresAt > now)) return false;
    Object.assign(this.row!, { state: 'sending', claimToken: token, leaseExpiresAt: until,
      attempts: row.attempts + 1, transportStartedAt: null, destinationJid: null });
    return true;
  }
  async start(_row: ApiOutboundRecord, token: string, destinationJid: string, now: Date) {
    if (this.row!.state !== 'sending' || this.row!.claimToken !== token || this.row!.leaseExpiresAt! <= now) return false;
    Object.assign(this.row!, { transportStartedAt: now, destinationJid });
    return true;
  }
  async receipt(_row: ApiOutboundRecord, token: string | null, receipt: any) {
    if (this.row!.state === 'sent') return true;
    if (token && this.row!.claimToken !== token) return false;
    if (!this.row!.transportStartedAt || ![receipt.key.remoteJid, receipt.key.remoteJidAlt].includes(this.row!.destinationJid)) return false;
    Object.assign(this.row!, { state: 'sent', result: receipt, claimToken: null, leaseExpiresAt: null });
    return true;
  }
  async defer(_row: ApiOutboundRecord, token: string, started: boolean, code: string, next: Date, terminal = false, retainLease = false) {
    if (this.row!.state === 'sending' && this.row!.claimToken === token)
      Object.assign(this.row!, { state: terminal ? 'failed' : started ? 'unknown' : 'pending',
        lastErrorCode: code, nextAttemptAt: next, ...(retainLease ? {} : { leaseExpiresAt: null }) });
  }
  async renew(row: ApiOutboundRecord, token: string, now: Date, until: Date) {
    if (this.row!.claimToken !== token || this.row!.attempts !== row.attempts || !this.row!.leaseExpiresAt || this.row!.leaseExpiresAt <= now) return false;
    this.row!.leaseExpiresAt = until; return true;
  }
  async release(row: ApiOutboundRecord, token: string) {
    if (this.row!.claimToken === token && this.row!.attempts === row.attempts && ['pending','unknown'].includes(this.row!.state))
      this.row!.leaseExpiresAt = null;
  }
  async recover(row: ApiOutboundRecord, now: Date) {
    if (row.state === 'sending' && row.leaseExpiresAt! <= now)
      Object.assign(this.row!, { state: row.transportStartedAt ? 'unknown' : 'pending', leaseExpiresAt: null });
    return clone(this.row!);
  }
  async findReceipt(row: ApiOutboundRecord) {
    return this.retained?.key?.id === row.plannedWhatsappMessageId && this.retained.key.fromMe === true &&
      [this.retained.key.remoteJid, this.retained.key.remoteJidAlt].includes(row.destinationJid) ? this.retained : null;
  }
}

function fixture(timeout = 1000) {
  const store = new Store(); let time = 10000; let sends = 0;
  const api = new ApiOutboundOperations(store, () => new Date(time), timeout, 2000);
  const receipt = () => ({ key: { id: store.row!.plannedWhatsappMessageId, fromMe: true, remoteJid: peer } });
  const send = async (hooks: ApiOutboundHooks) => {
    await hooks.beforeTransport(peer); sends += 1; await hooks.afterTransport(receipt()); return receipt();
  };
  return { store, api, receipt, send, advance: (ms = 10000) => { time += ms; }, count: () => sends };
}

test('receipt survives a lost caller response; repeated operation does not send again', async () => {
  const f = fixture();
  await f.api.send(id, 'instance', 'sendText', payload, true, f.send);
  const result = await f.api.send(id, 'instance', 'sendText', payload, true, f.send);
  assert.equal(result.operation.state, 'sent'); assert.equal(f.count(), 1);
  assert.equal(result.key.id, f.store.row!.plannedWhatsappMessageId);
});

test('same key with changed payload or sender refuses without replacing the original binding', async () => {
  const f = fixture(); await f.api.send(id, 'instance', 'sendText', payload, true, f.send);
  await assert.rejects(f.api.send(id, 'instance', 'sendText', { ...payload, text: 'Changed' }, true, f.send), ApiOutboundConflict);
  await assert.rejects(f.api.send(id, 'other-instance', 'sendText', payload, true, f.send), ApiOutboundConflict);
  assert.equal(f.count(), 1);
});

test('concurrent requests claim one transport attempt', async () => {
  const f = fixture();
  await Promise.all([f.api.send(id, 'instance', 'sendText', payload, true, f.send),
    f.api.send(id, 'instance', 'sendText', payload, true, f.send)]);
  assert.equal(f.count(), 1); assert.equal(f.store.row!.state, 'sent');
});

test('a preparation failure retries after backoff without being labelled sent', async () => {
  const f = fixture();
  const result = await f.api.send(id, 'instance', 'sendText', payload, false, async () => { throw new Error('API_NOT_READY'); });
  assert.equal(result.operation.state, 'pending'); assert.equal(result.operation.transportStarted, false);
  assert.equal(f.count(), 0); f.advance();
  assert.equal((await f.api.send(id, 'instance', 'sendText', payload, false, f.send)).operation.state, 'sent');
});

test('generic post-boundary error requires explicit ambiguous-resend policy', async () => {
  const f = fixture();
  await f.api.send(id, 'instance', 'sendText', payload, false, async hooks => {
    await hooks.beforeTransport(peer); throw new Error('API_CONNECTION_RESET');
  });
  f.advance();
  assert.equal((await f.api.send(id, 'instance', 'sendText', payload, false, f.send)).operation.state, 'unknown');
  assert.equal(f.count(), 0);
  assert.equal((await f.api.send(id, 'instance', 'sendText', payload, true, f.send)).operation.state, 'sent');
  assert.equal(f.count(), 1);
});

test('later optional history failure cannot overwrite an already committed receipt', async () => {
  const f = fixture();
  const result = await f.api.send(id, 'instance', 'sendText', payload, true, async hooks => {
    await hooks.beforeTransport(peer); await hooks.afterTransport(f.receipt()); throw new Error('NATIVE_HISTORY_FAILED');
  });
  assert.equal(result.operation.state, 'sent'); assert.equal(result.key.id, f.receipt().key.id);
});

test('expired pre-transport claim is recoverable after a process restart', async () => {
  const f = fixture(); await f.store.admit(id, 'instance', 'seed');
  Object.assign(f.store.row!, { state: 'sending', leaseExpiresAt: new Date(0), claimToken: 'dead' });
  assert.equal((await f.api.status(id, 'instance'))!.operation.state, 'pending');
});

test('expired post-transport claim uses exact retained provider identity, including unavailable bodies', async () => {
  const f = fixture(); await f.store.admit(id, 'instance', 'seed');
  Object.assign(f.store.row!, { state: 'sending', leaseExpiresAt: new Date(0), claimToken: 'dead',
    transportStartedAt: new Date(1), destinationJid: peer });
  f.store.retained = { ...f.receipt(), message: null };
  assert.equal((await f.api.status(id, 'instance'))!.operation.state, 'sent'); assert.equal(f.count(), 0);
});

test('wrong peer or incoming identity cannot reconcile an interrupted operation', async () => {
  const f = fixture(); await f.store.admit(id, 'instance', 'seed');
  Object.assign(f.store.row!, { state: 'unknown', transportStartedAt: new Date(1), destinationJid: peer });
  for (const key of [{ ...f.receipt().key, fromMe: false }, { ...f.receipt().key, remoteJid: 'other@g.us' }]) {
    f.store.retained = { key };
    assert.equal((await f.api.status(id, 'instance'))!.operation.state, 'unknown');
  }
});

test('a timeout does not overlap a still-running transport; its later receipt remains recoverable', async () => {
  const f = fixture(10); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = await f.api.send(id, 'instance', 'sendText', payload, true, async hooks => {
    await hooks.beforeTransport(peer); await gate; await hooks.afterTransport(f.receipt()); return f.receipt();
  });
  assert.equal(first.operation.state, 'unknown'); f.advance();
  assert.equal((await f.api.send(id, 'instance', 'sendText', payload, true, f.send)).operation.retryAllowed, false);
  assert.equal(f.count(), 0); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.api.status(id, 'instance'))!.operation.state, 'sent');
});

test('definite pre-send nonexistent recipient is terminal, arbitrary 400 is not', async () => {
  const f = fixture();
  const negative = { status: 400, message: [{ exists: false, number: payload.number, jid: peer }] };
  assert.equal(isApiNonRecipient(negative, payload), true);
  assert.equal(isApiNonRecipient({ status: 400, message: ['Connection Closed'] }, payload), false);
  assert.equal(isApiNonRecipient({ ...negative, message: [{ ...negative.message[0], number: 'wrong' }] }, payload), false);
  const result = await f.api.send(id, 'instance', 'sendText', payload, true, async () => { throw negative; });
  assert.equal(result.operation.state, 'failed'); assert.equal(result.operation.errorCode, 'EVO_RECIPIENT_NOT_ON_WHATSAPP');
  assert.equal(f.count(), 0);
});

test('draining rejects new API operation admission', async () => {
  const f = fixture(); await f.api.stop();
  await assert.rejects(f.api.send(id, 'instance', 'sendText', payload, true, f.send), /DRAINING/);
  assert.equal(f.store.row, null);
});

test('a caller timeout keeps a renewable shared lease while another API process attempts a retry', async () => {
  const store = new Store(); let release!: () => void, sends = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = new ApiOutboundOperations(store, () => new Date(), 10, 90);
  const second = new ApiOutboundOperations(store, () => new Date(), 10, 90);
  const receipt = () => ({ key: { id: store.row!.plannedWhatsappMessageId, fromMe: true, remoteJid: peer } });
  await first.send(id, 'instance', 'sendText', payload, true, async hooks => {
    await hooks.beforeTransport(peer); sends++; await gate; await hooks.afterTransport(receipt()); return receipt();
  });
  // Expire retry backoff, but the ongoing transport retains/renews its database ownership.
  store.row!.nextAttemptAt = new Date(0);
  await new Promise(resolve => setTimeout(resolve, 150));
  const result = await second.send(id, 'instance', 'sendText', payload, true, async () => { sends++; return receipt(); });
  assert.equal(result.operation.state, 'unknown'); assert.equal(result.operation.retryAllowed, false); assert.equal(sends, 1);
  release(); await first.stop();
  assert.equal((await second.status(id, 'instance'))!.operation.state, 'sent');
});
