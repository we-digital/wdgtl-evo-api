/**
 * vCard 3.0 for a WhatsApp contact card. Every number carries waid=<digits>,
 * so WhatsApp shows "Message" / "Add contact" for it on the customer's phone.
 */
const escapeVcardText = (value: string) =>
  value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/([,;])/g, '\\$1')
    .trim();

export function buildContactVcard(name: string, phones: string[]): string {
  const fullName = escapeVcardText(name);
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:;${fullName};;;`, `FN:${fullName}`];
  phones.forEach((phone, index) => {
    const digits = phone.replace(/\D/g, '');
    if (!digits) return;
    lines.push(`item${index + 1}.TEL;type=CELL;waid=${digits}:+${digits}`);
    lines.push(`item${index + 1}.X-ABLabel:${index === 0 ? 'Mobile' : 'Other'}`);
  });
  lines.push('END:VCARD');
  return lines.join('\n');
}
