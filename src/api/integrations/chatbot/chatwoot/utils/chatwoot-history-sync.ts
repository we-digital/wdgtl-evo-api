import { Message } from '@prisma/client';

export type StoredMessageKey = {
  id?: string;
  remoteJid?: string;
  remoteJidAlt?: string;
  fromMe?: boolean;
};

export type HistoryNormalizationStats = {
  sourceMessages: number;
  directMessages: number;
  groupMessages: number;
  provisionalLidMessages: number;
  systemMessages: number;
  invalidMessages: number;
  unresolvedLidMessages: number;
  unresolvedLidChats: number;
  normalizedMessages: number;
};

export type NormalizedHistoryMessages = {
  messages: Message[];
  stats: HistoryNormalizationStats;
};

export type ResolvePhoneJid = (lid: string) => Promise<string | null | undefined>;

export type HistoryNormalizationOptions = {
  includeGroups?: boolean;
  includeUnresolvedLids?: boolean;
};

export type HistoryRecoveryPreparation = {
  message: Message;
  recovery: 'native' | 'converted' | 'placeholder' | 'unsupported';
  reason: string;
};

export const toChatwootSourceId = (sourceId: string) => `WAID:${sourceId.replace(/^WAID:/, '')}`;

export const historyRecoveryDestination = (accountId: string | number, inboxId: string | number) => ({
  inboxId: Number(inboxId),
  destinationKey: `chatwoot:${accountId}:${inboxId}`,
});

export const uniqueHistoryRecoveryInboxId = (rows: Array<{ id?: unknown }>): number | null => {
  if (rows.length !== 1) return null;

  const inboxId = Number(rows[0]?.id);
  return Number.isSafeInteger(inboxId) && inboxId > 0 ? inboxId : null;
};

export const matchesHistoryRecoveryDestination = (
  expectedDestinationKey: string,
  expectedInboxId: number,
  accountId: string | number,
  inboxId: string | number,
) => {
  const destination = historyRecoveryDestination(accountId, inboxId);
  return destination.destinationKey === expectedDestinationKey && destination.inboxId === expectedInboxId;
};

export const selectUniqueChatwootInbox = <T extends { name?: string }>(
  inboxes: T[],
  expectedName: string,
): T | null => {
  const matches = inboxes.filter((candidate) => candidate.name === expectedName);
  return matches.length === 1 ? matches[0] : null;
};

export const chatwootInboxCacheKey = (
  instanceName: string,
  provider: { url: string; accountId: string | number; nameInbox: string },
) => {
  const providerUrl = provider.url.trim().replace(/\/+$/, '');
  return `${instanceName}:getInbox:v3:${encodeURIComponent(providerUrl)}:${provider.accountId}:${provider.nameInbox}`;
};

export const resolveProviderClientContext = async <Provider, Client>(
  loadProvider: () => Promise<Provider | null>,
  createClient: (provider: Provider) => Client,
): Promise<{ provider: Provider; client: Client } | null> => {
  const provider = await loadProvider();
  if (!provider) return null;
  return { provider, client: createClient(provider) };
};

const recoveryText = (messageType: string, raw: Record<string, any> | null) => {
  if (messageType === 'reactionMessage') {
    const reaction = raw?.reactionMessage;
    return reaction?.text ? `_WhatsApp reaction: ${reaction.text}_` : '_WhatsApp reaction removed_';
  }
  if (messageType === 'buttonsResponseMessage') {
    const response = raw?.buttonsResponseMessage;
    const selected = response?.selectedDisplayText || response?.selectedButtonId;
    return selected ? `_WhatsApp button response: ${selected}_` : null;
  }
  if (messageType === 'buttonsMessage') {
    const buttons = raw?.buttonsMessage;
    const labels = Array.isArray(buttons?.buttons)
      ? buttons.buttons
          .map((button: any) => button?.buttonText?.displayText)
          .filter((label: unknown): label is string => typeof label === 'string' && label.length > 0)
      : [];
    const parts = [buttons?.contentText, ...labels].filter(
      (part: unknown): part is string => typeof part === 'string' && part.length > 0,
    );
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (messageType === 'lottieStickerMessage') {
    return '_<Lottie Sticker Message>_';
  }
  if (!raw) {
    const unavailableTypes: Record<string, string> = {
      conversation: 'text',
      imageMessage: 'image',
      documentMessage: 'document',
      videoMessage: 'video',
      audioMessage: 'audio',
      stickerMessage: 'sticker',
    };
    const label = unavailableTypes[messageType];
    return label ? `_<Unavailable WhatsApp ${label} message>_` : null;
  }
  return null;
};

export const prepareStoredHistoryRecoveryMessage = (message: Message): HistoryRecoveryPreparation => {
  const raw = message.message && typeof message.message === 'object' ? (message.message as Record<string, any>) : null;
  const text = recoveryText(message.messageType, raw);
  if (!text) {
    return {
      message,
      recovery: raw ? 'native' : 'unsupported',
      reason: raw ? 'native_or_structural' : 'missing_payload',
    };
  }
  return {
    message: { ...message, message: { conversation: text } },
    recovery: raw ? 'converted' : 'placeholder',
    reason: raw ? `rendered_${message.messageType}` : `unavailable_${message.messageType}`,
  };
};

export const dedupeHistoryMessagesBySourceId = (messages: Message[]) => {
  const seenSourceIds = new Set<string>();
  const uniqueMessages: Message[] = [];
  let duplicateMessages = 0;

  for (const message of messages) {
    const sourceId = readKey(message).id;
    if (!sourceId) {
      continue;
    }

    const canonicalSourceId = toChatwootSourceId(sourceId);
    if (seenSourceIds.has(canonicalSourceId)) {
      duplicateMessages++;
      continue;
    }

    seenSourceIds.add(canonicalSourceId);
    uniqueMessages.push(message);
  }

  return { messages: uniqueMessages, duplicateMessages };
};

export const isPhoneJid = (remoteJid?: string): remoteJid is string =>
  Boolean(remoteJid?.endsWith('@s.whatsapp.net') || remoteJid?.endsWith('@hosted'));

export const isLidJid = (remoteJid?: string): remoteJid is string =>
  Boolean(remoteJid?.endsWith('@lid') || remoteJid?.endsWith('@hosted.lid'));

export const isGroupJid = (remoteJid?: string) => Boolean(remoteJid?.endsWith('@g.us'));

const toUserLevelJid = (jid: string) => {
  const separator = jid.lastIndexOf('@');
  if (separator < 0) {
    return jid;
  }

  const user = jid.slice(0, separator).split(':')[0];
  return `${user}${jid.slice(separator)}`;
};

export const toCanonicalHistoryJid = (remoteJid: string) =>
  isPhoneJid(remoteJid) || isLidJid(remoteJid) ? toUserLevelJid(remoteJid) : remoteJid;

const readKey = (message: Pick<Message, 'key'>): StoredMessageKey => (message.key || {}) as StoredMessageKey;

export const buildStoredLidMap = (messages: Pick<Message, 'key'>[]) => {
  const lidMap = new Map<string, string>();

  for (const message of messages) {
    const key = readKey(message);
    if (isLidJid(key.remoteJid) && isPhoneJid(key.remoteJidAlt)) {
      lidMap.set(key.remoteJid, key.remoteJidAlt);
    }
  }

  return lidMap;
};

export const normalizeStoredHistoryMessages = async (
  messages: Message[],
  mappingMessages: Pick<Message, 'key'>[],
  resolvePhoneJid?: ResolvePhoneJid,
  options: HistoryNormalizationOptions = {},
): Promise<NormalizedHistoryMessages> => {
  const lidMap = buildStoredLidMap(mappingMessages);
  const unresolvedLids = new Set<string>();

  for (const message of messages) {
    const remoteJid = readKey(message).remoteJid;
    if (isLidJid(remoteJid) && !lidMap.has(remoteJid)) {
      unresolvedLids.add(remoteJid);
    }
  }

  if (resolvePhoneJid) {
    await Promise.all(
      Array.from(unresolvedLids).map(async (lid) => {
        try {
          const phoneJid = await resolvePhoneJid(lid);
          if (isPhoneJid(phoneJid)) {
            lidMap.set(lid, phoneJid);
          }
        } catch {
          // Keep the LID unresolved and report it instead of creating a false phone contact.
        }
      }),
    );
  }

  const normalizedMessages: Message[] = [];
  const unresolvedMessages = new Set<string>();
  let directMessages = 0;
  let groupMessages = 0;
  let provisionalLidMessages = 0;
  let systemMessages = 0;
  let invalidMessages = 0;

  for (const message of messages) {
    const key = readKey(message);
    if (!key.id || !key.remoteJid || !message.message || !message.messageTimestamp) {
      invalidMessages++;
      continue;
    }

    if (isGroupJid(key.remoteJid)) {
      groupMessages++;
      if (options.includeGroups) {
        normalizedMessages.push({
          ...message,
          key: {
            ...key,
            remoteJid: key.remoteJid,
          },
        });
      }
      continue;
    }

    if (key.remoteJid === 'status@broadcast' || key.remoteJid === '0@s.whatsapp.net') {
      systemMessages++;
      continue;
    }

    let normalizedJid = key.remoteJid;
    if (isLidJid(key.remoteJid)) {
      normalizedJid = lidMap.get(key.remoteJid);
      if (!normalizedJid) {
        unresolvedMessages.add(key.remoteJid);
        if (options.includeUnresolvedLids) {
          provisionalLidMessages++;
          normalizedMessages.push({
            ...message,
            key: {
              ...key,
              remoteJid: toCanonicalHistoryJid(key.remoteJid),
            },
          });
        }
        continue;
      }
    }

    if (!isPhoneJid(normalizedJid)) {
      systemMessages++;
      continue;
    }

    directMessages++;
    normalizedMessages.push({
      ...message,
      key: {
        ...key,
        remoteJid: toCanonicalHistoryJid(normalizedJid),
      },
    });
  }

  return {
    messages: normalizedMessages,
    stats: {
      sourceMessages: messages.length,
      directMessages,
      groupMessages,
      provisionalLidMessages,
      systemMessages,
      invalidMessages,
      unresolvedLidMessages: messages.filter((message) => unresolvedMessages.has(readKey(message).remoteJid)).length,
      unresolvedLidChats: unresolvedMessages.size,
      normalizedMessages: normalizedMessages.length,
    },
  };
};
