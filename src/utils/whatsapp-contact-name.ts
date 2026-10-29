// Message pushName belongs to its sender, not necessarily the conversation peer.
export const whatsappContactName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
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
