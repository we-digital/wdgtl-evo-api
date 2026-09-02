import { createHmac, timingSafeEqual } from 'node:crypto';

export const CHATWOOT_INGRESS_CONTRACT_VERSION = 2 as const;

export type ChatwootIngressScope = 'direct' | 'group' | 'broadcast' | 'unknown';

type MessageKey = {
  remoteJid?: unknown;
  remoteJidAlt?: unknown;
  fromMe?: unknown;
};

export type ChatwootEvoRouteBinding = {
  version: typeof CHATWOOT_INGRESS_CONTRACT_VERSION;
  provider: 'evo_whatsapp';
  inbox_id: number;
  instance_id: string;
  instance_name: string;
  receiver_fingerprint: string;
};

type ChatwootEvoRouteInput = {
  inboxId: unknown;
  instanceId: unknown;
  instanceName: unknown;
  receiverNumber: unknown;
  signingKey: unknown;
};

const readJid = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const readNonEmptyString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const canonicalReceiverNumber = (value: unknown) => {
  const raw = readNonEmptyString(value).split('@')[0].split(':')[0];
  const digits = raw.replace(/\D/g, '');
  return digits || null;
};

export const selectChatwootPhysicalReceiverNumber = ({ ownerJid, number }: { ownerJid: unknown; number: unknown }) => {
  const parsedOwnerJid = readNonEmptyString(ownerJid).toLowerCase();
  if (parsedOwnerJid) return parsedOwnerJid.endsWith('@s.whatsapp.net') ? parsedOwnerJid : null;

  return readNonEmptyString(number) || null;
};

export const buildChatwootEvoRouteBinding = ({
  inboxId,
  instanceId,
  instanceName,
  receiverNumber,
  signingKey,
}: ChatwootEvoRouteInput): ChatwootEvoRouteBinding | null => {
  const parsedInboxId = Number(inboxId);
  const parsedInstanceId = readNonEmptyString(instanceId);
  const parsedInstanceName = readNonEmptyString(instanceName);
  const parsedReceiverNumber = canonicalReceiverNumber(receiverNumber);
  const parsedSigningKey = readNonEmptyString(signingKey);

  if (
    !Number.isSafeInteger(parsedInboxId) ||
    parsedInboxId <= 0 ||
    !parsedInstanceId ||
    !parsedInstanceName ||
    !parsedReceiverNumber ||
    !parsedSigningKey
  ) {
    return null;
  }

  const receiverFingerprint = createHmac('sha256', parsedSigningKey)
    .update(`evo_whatsapp\n${parsedInboxId}\n${parsedInstanceId}\n${parsedInstanceName}\n${parsedReceiverNumber}`)
    .digest('hex');

  return {
    version: CHATWOOT_INGRESS_CONTRACT_VERSION,
    provider: 'evo_whatsapp',
    inbox_id: parsedInboxId,
    instance_id: parsedInstanceId,
    instance_name: parsedInstanceName,
    receiver_fingerprint: receiverFingerprint,
  };
};

export const chatwootEvoRouteBindingsEqual = (
  left: ChatwootEvoRouteBinding | null | undefined,
  right: ChatwootEvoRouteBinding | null | undefined,
) => {
  if (!left || !right) return false;
  if (
    left.version !== right.version ||
    left.provider !== right.provider ||
    Number(left.inbox_id) !== Number(right.inbox_id) ||
    left.instance_id !== right.instance_id ||
    left.instance_name !== right.instance_name
  ) {
    return false;
  }

  if (typeof left.receiver_fingerprint !== 'string' || typeof right.receiver_fingerprint !== 'string') return false;

  const leftFingerprint = Buffer.from(left.receiver_fingerprint);
  const rightFingerprint = Buffer.from(right.receiver_fingerprint);
  return leftFingerprint.length === rightFingerprint.length && timingSafeEqual(leftFingerprint, rightFingerprint);
};

export const classifyChatwootIngressScope = (
  messageBody: { key?: MessageKey } | null | undefined,
): ChatwootIngressScope => {
  const remoteJid = readJid(messageBody?.key?.remoteJid);
  const remoteJidAlt = readJid(messageBody?.key?.remoteJidAlt);

  if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')) return 'broadcast';
  if (remoteJid.endsWith('@g.us')) return 'group';
  if (remoteJid.endsWith('@s.whatsapp.net')) return 'direct';
  if (remoteJid.endsWith('@lid') && remoteJidAlt.endsWith('@s.whatsapp.net')) return 'direct';

  return 'unknown';
};

export const buildChatwootIngressAttributes = (
  messageBody: { key?: MessageKey } | null | undefined,
  route: ChatwootEvoRouteBinding | null,
) => {
  const fromMe = messageBody?.key?.fromMe;
  const direction =
    fromMe === false ? ('inbound' as const) : fromMe === true ? ('outbound' as const) : ('unknown' as const);

  return {
    we_digital_ingress: {
      version: CHATWOOT_INGRESS_CONTRACT_VERSION,
      provider: 'evo_whatsapp' as const,
      scope: classifyChatwootIngressScope(messageBody),
      direction,
      from_me: typeof fromMe === 'boolean' ? fromMe : null,
      route,
    },
  };
};
