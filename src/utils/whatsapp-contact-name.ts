// Names land in VarChar(100) columns (Contact.pushName, Chat.name, Message.pushName).
// Postgres counts characters (code points), so cut by code point, never mid-surrogate.
export const WHATSAPP_NAME_MAX_CHARS = 100;
export const fitVarChar = <T>(value: T, max = WHATSAPP_NAME_MAX_CHARS): T => {
  if (typeof value !== 'string' || value.length <= max) return value;
  const chars = Array.from(value);
  return (chars.length <= max ? value : chars.slice(0, max).join('')) as T;
};

// Message pushName belongs to its sender, not necessarily the conversation peer.
export const whatsappContactName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const name = fitVarChar(value.trim()).trim();
  if (!name || /^voc[eê]$/iu.test(name)) return undefined;
  return name;
};

export const incomingWhatsappName = (message: { key?: unknown; pushName?: unknown }): string | undefined => {
  const key = message.key as { fromMe?: unknown } | undefined;
  return key?.fromMe === false ? whatsappContactName(message.pushName) : undefined;
};

export const whatsappProfileName = (contact: { notify?: string; name?: string; verifiedName?: string }) =>
  whatsappContactName(contact.notify) || whatsappContactName(contact.name) || whatsappContactName(contact.verifiedName);

export const replaceableWhatsappName = (name: unknown, identity: string): boolean =>
  !whatsappContactName(name) ||
  name === identity ||
  name === `+${identity}` ||
  name === `WhatsApp LID ${identity.slice(-6)}`;
