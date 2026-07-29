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

export const toChatwootSourceId = (sourceId: string) => `WAID:${sourceId.replace(/^WAID:/, '')}`;

export const isPhoneJid = (remoteJid?: string): remoteJid is string => Boolean(remoteJid?.endsWith('@s.whatsapp.net'));

export const isLidJid = (remoteJid?: string): remoteJid is string => Boolean(remoteJid?.endsWith('@lid'));

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
  let systemMessages = 0;
  let invalidMessages = 0;

  for (const message of messages) {
    const key = readKey(message);
    if (!key.id || !key.remoteJid || !message.message || !message.messageTimestamp) {
      invalidMessages++;
      continue;
    }

    if (key.remoteJid.endsWith('@g.us')) {
      groupMessages++;
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
        remoteJid: normalizedJid,
      },
    });
  }

  return {
    messages: normalizedMessages,
    stats: {
      sourceMessages: messages.length,
      directMessages,
      groupMessages,
      systemMessages,
      invalidMessages,
      unresolvedLidMessages: messages.filter((message) => unresolvedMessages.has(readKey(message).remoteJid)).length,
      unresolvedLidChats: unresolvedMessages.size,
      normalizedMessages: normalizedMessages.length,
    },
  };
};
