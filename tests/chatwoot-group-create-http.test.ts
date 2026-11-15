process.env.CHATWOOT_AVATAR_SYNC = 'off';

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import test from 'node:test';

import { chatwootController } from '@api/server.module';
import { ChatwootRouter } from '@api/integrations/chatbot/chatwoot/routes/chatwoot.router';
import { GroupCreateError } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-group-create';
import express from 'express';

// The signed HTTP fallback: a "Create group" refusal answers {"status":"error","code"} with its 4xx,
// in progress is a 200, and other errors keep the generic handler.
test('HTTP webhook answers group create refusals with their code in the body', async () => {
  const controller = chatwootController as any;
  const original = {
    authenticate: controller.authenticateOutboundWebhook,
    receive: controller.receiveWebhook,
  };
  let next: () => Promise<unknown> = async () => ({});
  controller.authenticateOutboundWebhook = async () => ({ deliveryId: 'd' });
  controller.receiveWebhook = async () => next();
  const app = express();
  app.use(express.json());
  app.use('/chatwoot', new ChatwootRouter().router);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ generic: true }));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chatwoot/webhook/t-test`;
  const post = async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'group_create_request' }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    next = async () => {
      throw new GroupCreateError('not_connected');
    };
    assert.deepEqual(await post(), { status: 409, body: { status: 'error', code: 'not_connected' } });
    next = async () => {
      throw new GroupCreateError('no_reachable_invitees');
    };
    assert.deepEqual(await post(), { status: 422, body: { status: 'error', code: 'no_reachable_invitees' } });
    next = async () => ({ status: 'in_progress' });
    assert.deepEqual(await post(), { status: 200, body: { status: 'in_progress' } });
    next = async () => {
      throw Object.assign(new Error('other'), { status: 503 });
    };
    assert.deepEqual(await post(), { status: 503, body: { generic: true } });
  } finally {
    server.close();
    controller.authenticateOutboundWebhook = original.authenticate;
    controller.receiveWebhook = original.receive;
  }
});
