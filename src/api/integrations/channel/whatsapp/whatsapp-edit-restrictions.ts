// Original send time, not the latest edit time, controls the WhatsApp window.
export const WHATSAPP_EDIT_WINDOW_SECONDS = 15 * 60;
export const ORIGINAL_WHATSAPP_TIMESTAMP = 'weDigitalOriginalMessageTimestamp';

export function originalWhatsappTimestamp(
  message: any,
  previouslyEdited: boolean,
  sentAt?: Date | null,
): number | null {
  const saved = Number(message?.contextInfo?.[ORIGINAL_WHATSAPP_TIMESTAMP]);
  if (Number.isSafeInteger(saved) && saved > 0) return saved;
  if (previouslyEdited) {
    const sent = sentAt ? Math.floor(new Date(sentAt).getTime() / 1000) : NaN;
    return Number.isSafeInteger(sent) && sent > 0 ? sent : null;
  }
  const timestamp = Number(message?.messageTimestamp);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

export function whatsappEditAllowed(
  message: any,
  timestamp: number | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return (
    message?.key?.fromMe === true &&
    !message?.key?.deleted &&
    timestamp !== null &&
    timestamp <= nowSeconds &&
    nowSeconds - timestamp < WHATSAPP_EDIT_WINDOW_SECONDS
  );
}
