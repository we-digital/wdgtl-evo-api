import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { ApiOutboundOperations } from '../src/api/services/api-outbound-operation';
import { ApiOutboundPrismaStore } from '../src/api/services/api-outbound-prisma-store';

test('authenticated native HTTP operation contract with real durable storage and synthetic transport', {
  skip: !process.env.API_OUTBOUND_TEST_DATABASE_URL,
}, async () => {
  const db = new PrismaClient({ datasourceUrl: process.env.API_OUTBOUND_TEST_DATABASE_URL });
  const api = new ApiOutboundOperations(new ApiOutboundPrismaStore(db));
  const instanceId = `synthetic-http-${randomUUID()}`, token = 'synthetic-instance-token';
  const app = express(); let server: any, sends = 0, fail = false;
  const modulePath = require.resolve('../src/api/server.module');
  const indexPath = require.resolve('../src/api/routes/index.router');
  const previousModule = require.cache[modulePath], previousIndex = require.cache[indexPath];
  try {
    await db.instance.create({ data: { id: instanceId, name: instanceId, token, integration: 'WHATSAPP-BAILEYS' } });
    require.cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true,
      exports: { HttpStatus: { CREATED: 201, ACCEPTED: 202, BAD_REQUEST: 400, UNAUTHORIZED: 401,
        FORBIDDEN: 403, NOT_FOUND: 404, INTERNAL_SERVER_ERROR: 500 } } } as any;
    require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: {
      prismaRepository: db, apiOutboundOperations: api, cache: { has: async () => false }, waMonitor: { waInstances: { [instanceId]: {} } },
      sendMessageController: { sendText: async (_instance: any, data: any) => {
        if (fail) throw new Error('SYNTHETIC_SERVICE_UNAVAILABLE');
        sends++;
        await data.beforeTransport('628111111111@s.whatsapp.net');
        const result = { key: { id: data.messageId, fromMe: true, remoteJid: '628111111111@s.whatsapp.net' } };
        await data.afterTransport(result); return result;
      } },
    } } as any;
    const { MessageRouter } = require('../src/api/routes/sendMessage.router');
    const { authGuard } = require('../src/api/guards/auth.guard');
    const { instanceExistsGuard, instanceLoggedGuard } = require('../src/api/guards/instance.guard');
    app.use(express.json());
    app.use('/message', new MessageRouter(instanceExistsGuard, instanceLoggedGuard, authGuard.apikey).router);
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.message }));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/message`;
    const id = randomUUID(), payload = { number: '628111111111', text: 'synthetic HTTP fixture' };
    const send = (key: string, body = payload) => fetch(`${base}/sendText/${instanceId}`, {
      method: 'POST', headers: { apikey: token, 'Content-Type': 'application/json',
        'Idempotency-Key': key, 'X-Evo-Retry-Ambiguous': 'true' }, body: JSON.stringify(body),
    });
    assert.equal((await fetch(`${base}/operations/${instanceId}/${id}`)).status, 401);
    assert.equal((await fetch(`${base}/operations/${instanceId}/${id}`, { headers: { apikey: 'wrong-instance-token' } })).status, 401);
    let response = await fetch(`${base}/operations/${instanceId}/${id}`, { headers: { apikey: token } });
    assert.equal(response.status, 404); assert.equal((await response.json()).error, 'API_OPERATION_NOT_FOUND');
    assert.equal((await send('invalid-id')).status, 400);
    response = await send(id); assert.equal(response.status, 201);
    const receipt = await response.json(); assert.equal(receipt.operation.state, 'sent');
    response = await send(id); assert.equal(response.status, 201);
    assert.deepEqual((await response.json()).key, receipt.key); assert.equal(sends, 1);
    assert.equal((await send(id, { ...payload, text: 'changed' })).status, 409);
    if (process.env.BBC_WA_SENDER_TEST_SOURCE) {
      // Optional shared-lab integration: real sender -> native HTTP -> PostgreSQL -> receipt recovery.
      const source = process.env.BBC_WA_SENDER_TEST_SOURCE;
      const { DeliveryLedger } = require(path.join(source, 'deliveryLedger.js'));
      const { createEvoTransport } = require(path.join(source, 'evoTransport.js'));
      const { createAutomaticRecovery } = require(path.join(source, 'automaticRecovery.js'));
      const { createQueueProcessor } = require(path.join(source, 'queueProcessor.js'));
      const axios = require('axios');
      const aliasId = `synthetic-sender-${randomUUID()}`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbc-wa-http-lab-'));
      await db.instance.create({ data: { id: aliasId, name: 'f-kuta', token, integration: 'WHATSAPP-BAILEYS' } });
      try {
        const ledger = new DeliveryLedger(path.join(dir, 'delivery.jsonl'));
        const acks: any[] = [];
        let loseResponse = true;
        const transport = createEvoTransport({ baseUrl: base.replace(/\/message$/, ''), durableApi: true,
          allowAmbiguousResend: true, apiKeyProvider: () => token, axiosClient: {
            get: axios.get,
            post: async (...args: any[]) => {
              const response = await axios.post(...args);
              if (loseResponse) { loseResponse = false; throw new Error('SYNTHETIC_RESPONSE_LOST'); }
              return response;
            },
          } });
        const recovery = createAutomaticRecovery({ ledger, reconcileReceipt: transport.reconcileReceipt,
          allowAmbiguousResend: true, now: () => Date.now() + 10000 });
        const processor = createQueueProcessor({ ledger, automaticRecovery: recovery,
          acknowledgeMessage: async (...args: any[]) => { acks.push(args); return { status: 'success' }; },
          sendPersonMessage: transport.sendPersonMessage, sendGroupMessage: transport.sendGroupMessage,
          logger: { info() {}, warn() {}, error() {} } });
        const row = { id: '100', alias: 'f-kuta', type: 'person', phone: payload.number,
          text: payload.text, source_module: 'VOA', source_record_id: '300' };
        await assert.rejects(processor.sendAndAcknowledge(row), { code: 'WA_DELIVERY_UNKNOWN' });
        assert.equal(ledger.get('100').state, 'unknown'); assert.equal(acks.length, 0);
        const sentBeforeRecovery = sends;
        await processor.sendAndAcknowledge(row);
        assert.equal(sends, sentBeforeRecovery); assert.equal(ledger.get('100').state, 'sent');
        assert.equal(acks.length, 1);
        const durable = await db.apiOutboundOperation.findMany({ where: { instanceId: aliasId } });
        assert.equal(durable.length, 1); assert.equal(durable[0].state, 'sent');
        assert.equal(ledger.get('100').waMessageId, (durable[0].result as any).key.id);
      } finally {
        await db.apiOutboundOperation.deleteMany({ where: { instanceId: aliasId } });
        await db.instance.delete({ where: { id: aliasId } }); fs.rmSync(dir, { recursive: true });
      }
    }
    const successfulSends = sends;
    fail = true; response = await send(randomUUID()); assert.equal(response.status, 202);
    assert.equal((await response.json()).operation.state, 'pending');
    await db.instance.update({ where: { id: instanceId }, data: { integration: 'WHATSAPP-BUSINESS' } });
    assert.equal((await send(randomUUID())).status, 400); assert.equal(sends, successfulSends);
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await api.stop();
    await db.apiOutboundOperation.deleteMany({ where: { instanceId } });
    await db.instance.deleteMany({ where: { id: instanceId } });
    await db.$disconnect();
    if (previousModule) require.cache[modulePath] = previousModule; else delete require.cache[modulePath];
    if (previousIndex) require.cache[indexPath] = previousIndex; else delete require.cache[indexPath];
  }
});
