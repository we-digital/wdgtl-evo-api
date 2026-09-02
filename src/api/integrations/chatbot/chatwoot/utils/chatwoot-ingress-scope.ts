export const CHATWOOT_INGRESS_CONTRACT_VERSION = 1 as const;

export type ChatwootIngressScope = 'direct' | 'group' | 'broadcast' | 'unknown';

type MessageKey = {
  remoteJid?: unknown;
  remoteJidAlt?: unknown;
};

const readJid = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

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

export const buildChatwootIngressAttributes = (messageBody: { key?: MessageKey } | null | undefined) => ({
  we_digital_ingress: {
    version: CHATWOOT_INGRESS_CONTRACT_VERSION,
    provider: 'evo_whatsapp' as const,
    scope: classifyChatwootIngressScope(messageBody),
  },
});
