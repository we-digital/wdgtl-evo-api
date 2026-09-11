import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ChatwootOutboundWebhookHeaders {
  deliveryId: string;
  timestampSeconds: number;
  receivedAt: Date;
}

export interface ChatwootOutboundWebhookSecrets {
  current: string;
  previous?: string | null;
  previousValidUntil?: Date | null;
}

const requiredHeader = (value: string | string[] | undefined, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error(`Missing ${name}`), {
      name: 'ChatwootWebhookAuthenticationError',
      status: 401,
    });
  }
  return value;
};

const signatureMatches = (secret: string, timestamp: string, rawBody: Buffer, signature: string): boolean => {
  const expected = Buffer.from(
    createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest('hex'),
  );
  const received = Buffer.from(signature.replace(/^sha256=/, ''));
  return received.length === expected.length && timingSafeEqual(received, expected);
};

export function verifyChatwootOutboundWebhook(params: {
  rawBody: Buffer | undefined;
  headers: Record<string, string | string[] | undefined>;
  secrets: ChatwootOutboundWebhookSecrets;
  now?: Date;
  maxAgeMs: number;
  maxBodyBytes: number;
}): ChatwootOutboundWebhookHeaders {
  const now = params.now ?? new Date();
  if (!Buffer.isBuffer(params.rawBody))
    throw Object.assign(new Error('Missing raw Chatwoot webhook body'), {
      name: 'ChatwootWebhookAuthenticationError',
      status: 401,
    });
  if (params.rawBody.length === 0 || params.rawBody.length > params.maxBodyBytes) {
    throw Object.assign(new Error('Invalid Chatwoot webhook body size'), {
      name: 'ChatwootWebhookBodyLimitExceeded',
      status: 413,
    });
  }
  if (!params.secrets.current)
    throw Object.assign(new Error('Chatwoot webhook secret is not configured'), {
      name: 'ChatwootWebhookSecretUnavailable',
      status: 503,
    });

  const deliveryId = requiredHeader(params.headers['x-chatwoot-delivery'], 'X-Chatwoot-Delivery');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(deliveryId)) {
    throw Object.assign(new Error('Invalid X-Chatwoot-Delivery'), {
      name: 'ChatwootWebhookAuthenticationError',
      status: 401,
    });
  }
  const timestamp = requiredHeader(params.headers['x-chatwoot-timestamp'], 'X-Chatwoot-Timestamp');
  if (!/^\d{10}$/.test(timestamp)) {
    throw Object.assign(new Error('Invalid X-Chatwoot-Timestamp'), {
      name: 'ChatwootWebhookAuthenticationError',
      status: 401,
    });
  }
  const timestampSeconds = Number(timestamp);
  const ageMs = Math.abs(now.getTime() - timestampSeconds * 1_000);
  if (!Number.isSafeInteger(timestampSeconds) || ageMs > params.maxAgeMs) {
    throw Object.assign(new Error('Expired X-Chatwoot-Timestamp'), {
      name: 'ChatwootWebhookAuthenticationError',
      status: 401,
    });
  }
  const signature = requiredHeader(params.headers['x-chatwoot-signature'], 'X-Chatwoot-Signature');
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) {
    throw Object.assign(new Error('Invalid X-Chatwoot-Signature'), {
      name: 'ChatwootWebhookAuthenticationError',
      status: 401,
    });
  }

  const currentMatches = signatureMatches(params.secrets.current, timestamp, params.rawBody, signature);
  const previousActive =
    Boolean(params.secrets.previous) &&
    params.secrets.previousValidUntil instanceof Date &&
    params.secrets.previousValidUntil.getTime() >= now.getTime();
  const previousMatches = previousActive
    ? signatureMatches(params.secrets.previous as string, timestamp, params.rawBody, signature)
    : false;
  if (!currentMatches && !previousMatches) {
    throw Object.assign(new Error('Invalid Chatwoot webhook signature'), {
      name: 'ChatwootWebhookAuthenticationError',
      status: 401,
    });
  }
  return { deliveryId, timestampSeconds, receivedAt: now };
}
