import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { isLidJid, isPhoneJid } from './chatwoot-history-sync';

type GroupDisplayBody = {
  key?: { fromMe?: boolean; participant?: string; participantAlt?: string };
  pushName?: string;
};

export function formatWhatsappGroupContent(body: GroupDisplayBody, content: string, fallbackName: string): string {
  if (body.key?.fromMe) return content || '';

  const participant = body.key?.participant;
  const nativePhone =
    isLidJid(participant) && isPhoneJid(body.key?.participantAlt) ? body.key.participantAlt : participant;
  let phone: string;
  if (isPhoneJid(nativePhone) && /^[1-9]\d{5,14}(?::\d+)?@(s\.whatsapp\.net|hosted)$/.test(nativePhone)) {
    const parsed = parsePhoneNumberFromString(`+${nativePhone.split('@')[0].split(':')[0]}`);
    if (parsed?.isValid()) phone = parsed.formatInternational();
  }
  const name = body.pushName || fallbackName;
  const label = phone ? `${phone} - ${name}` : name;
  return content ? `**${label}:**\n\n${content}` : `**${label}:**`;
}
