import assert from 'node:assert/strict';
import test from 'node:test';

import '@api/server.module';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import {
  ChatwootTrustedDestinationError,
  requireTrustedChatwootUrl,
  resolveTrustedChatwootBaseUrl,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-trusted-egress';
import axios from 'axios';

const trustedUrl = 'https://cw.example.invalid';
const provider = {
  url: trustedUrl,
  token: 'provider-token',
  nameInbox: 'Inbox',
  mergeBrazilContacts: false,
};

const serviceFixture = () =>
  new ChatwootService(
    {} as any,
    {
      get: () => ({
        TRUSTED_BASE_URL: trustedUrl,
        NATIVE_BRIDGE_TOKEN: 'bridge-secret',
        READ_STATE_INGRESS_TOKEN: 'read-state-secret',
      }),
    } as any,
    {} as any,
    {} as any,
  ) as any;

test('binds privileged egress only to the exact operator-controlled HTTPS origin', () => {
  assert.equal(resolveTrustedChatwootBaseUrl(`${trustedUrl}/`, trustedUrl), trustedUrl);
  assert.equal(resolveTrustedChatwootBaseUrl('https://attacker.invalid', trustedUrl), null);
  assert.equal(resolveTrustedChatwootBaseUrl(`${trustedUrl}/proxy`, trustedUrl), null);
  assert.equal(resolveTrustedChatwootBaseUrl(`https://attacker.invalid@${new URL(trustedUrl).host}`, trustedUrl), null);
  assert.equal(
    requireTrustedChatwootUrl(trustedUrl, trustedUrl, '/api/v1/accounts/1/conversations/2/mute'),
    `${trustedUrl}/api/v1/accounts/1/conversations/2/mute`,
  );
});

test('ordinary provider clients never receive the machine-to-machine credential', () => {
  const config = serviceFixture().getClientCwConfig(provider);
  assert.deepEqual(config.headers, { 'api-access-token': 'provider-token' });
});

test('an instance-controlled destination is rejected before privileged network egress', async () => {
  const service = serviceFixture();
  const originalRequest = axios.request;
  let calls = 0;
  axios.request = async () => {
    calls += 1;
    return {} as any;
  };

  try {
    await assert.rejects(
      service.privilegedChatwootRequest(
        { ...provider, url: 'https://attacker.invalid' },
        { method: 'POST', path: '/api/v1/accounts/1/conversations/2/mute', data: { skip_native: true } },
      ),
      ChatwootTrustedDestinationError,
    );
    assert.equal(calls, 0);
  } finally {
    axios.request = originalRequest;
  }
});

test('privileged requests disable redirects and use only the trusted destination', async () => {
  const service = serviceFixture();
  const originalRequest = axios.request;
  let captured: any;
  axios.request = async (config) => {
    captured = config;
    return {} as any;
  };

  try {
    await service.privilegedChatwootRequest(provider, {
      method: 'POST',
      path: '/api/v1/accounts/1/conversations/2/mute',
      data: { skip_native: true },
    });
  } finally {
    axios.request = originalRequest;
  }

  assert.equal(captured.url, `${trustedUrl}/api/v1/accounts/1/conversations/2/mute`);
  assert.equal(captured.maxRedirects, 0);
  assert.equal(captured.headers['X-Chatwoot-Native-Bridge-Token'], 'bridge-secret');
});

test('read-state secret is not sent to an instance-controlled destination', async () => {
  const service = serviceFixture();
  service.getProvider = async () => ({ ...provider, url: 'https://attacker.invalid' });
  service.logger = { warn: () => undefined };
  const originalPost = axios.post;
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    return {} as any;
  };

  try {
    const result = await service.externalRead(
      { instanceName: 'instance-1' },
      { conversationId: 2, messageId: 3, sourceCursor: 'cursor' },
    );
    assert.equal(result, null);
    assert.equal(calls, 0);
  } finally {
    axios.post = originalPost;
  }
});

test('trusted read-state requests disable redirects', async () => {
  const service = serviceFixture();
  service.getProvider = async () => ({ ...provider, accountId: '1' });
  const originalPost = axios.post;
  let captured: any;
  axios.post = async (url, data, config) => {
    captured = { url, data, config };
    return { data: { owners_updated: 1 } } as any;
  };

  try {
    const result = await service.externalRead(
      { instanceName: 'instance-1' },
      { conversationId: 2, messageId: 3, sourceCursor: 'cursor' },
    );
    assert.deepEqual(result, { owners_updated: 1 });
  } finally {
    axios.post = originalPost;
  }

  assert.equal(captured.url, `${trustedUrl}/api/v1/accounts/1/conversations/2/external_read`);
  assert.equal(captured.config.maxRedirects, 0);
  assert.equal(captured.config.headers['X-Chatwoot-Read-State-Token'], 'read-state-secret');
});
