/**
 * Chatwoot native message reactions helpers.
 */

export type ChatwootReactionActor = {
  type: 'user' | 'contact' | 'external';
  id: string;
  name?: string;
  external_id?: string;
};

export type ChatwootReactionEvent = {
  emoji?: string;
  action?: 'add' | 'remove';
  actor?: ChatwootReactionActor | Record<string, unknown>;
  source?: string;
};

export const isAgentReactionWebhook = (body: { event?: string; reaction?: ChatwootReactionEvent | null }): boolean => {
  if (body?.event !== 'message_updated') return false;
  const reaction = body?.reaction;
  if (!reaction || typeof reaction !== 'object') return false;
  // Only explicit agent reactions; empty source must not echo channel→CW→channel.
  return String(reaction.source || '') === 'agent';
};

export const buildWhatsappReactionActor = (body: {
  key?: { fromMe?: boolean; participant?: string; remoteJid?: string };
  pushName?: string;
}): {
  actor_type: string;
  actor_id: string;
  actor_name: string;
  external_id: string;
  source: string;
} => {
  // Own-device reactions must always identity as `me`. Using participant/remoteJid
  // for fromMe makes Chatwoot treat the echo as a second reactor beside the agent.
  if (body?.key?.fromMe) {
    return {
      actor_type: 'external',
      actor_id: 'me',
      actor_name: body?.pushName || 'Me',
      external_id: 'me',
      source: 'whatsapp',
    };
  }

  const externalId = body?.key?.participant || body?.key?.remoteJid || 'unknown';
  const name = body?.pushName || externalId.split('@')[0] || externalId;
  return {
    actor_type: 'external',
    actor_id: externalId,
    actor_name: name,
    external_id: externalId,
    source: 'whatsapp',
  };
};
