/**
 * Chatwoot native message reactions helpers.
 */

export type ChatwootReactionActor = {
  type: 'user' | 'contact' | 'external';
  id: string;
  name?: string;
  external_id?: string;
  reacted_at?: string;
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
  messageTimestamp?: number | string | { toNumber?: () => number };
}): {
  actor_type: string;
  actor_id: string;
  actor_name: string;
  external_id: string;
  source: string;
  reacted_at?: string;
} => {
  const actorId = body?.key?.participant || body?.key?.remoteJid || 'unknown';
  const externalId = body?.key?.fromMe ? 'me' : actorId;
  const name = body?.pushName || actorId.split('@')[0] || actorId;
  const rawTimestamp =
    typeof body?.messageTimestamp === 'object' ? body.messageTimestamp?.toNumber?.() : Number(body?.messageTimestamp);
  const reactedAt =
    Number.isSafeInteger(rawTimestamp) && rawTimestamp > 0 ? new Date(rawTimestamp * 1000).toISOString() : undefined;
  return {
    actor_type: 'external',
    actor_id: actorId,
    actor_name: name,
    external_id: externalId,
    source: 'whatsapp',
    ...(reactedAt ? { reacted_at: reactedAt } : {}),
  };
};
