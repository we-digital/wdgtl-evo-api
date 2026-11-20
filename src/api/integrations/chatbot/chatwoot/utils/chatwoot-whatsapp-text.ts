import { stripWhatsappMentionMarkdown } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-channel-mentions';

/**
 * Chatwoot editor markdown -> WhatsApp text. One conversion for new sends and
 * native edits, so an edited message reads exactly like a freshly sent one.
 * Chatwoot already strips the editor's hard line breaks (`\` + newline) from
 * the webhook content (Messages::WebhookContentNormalizer).
 */
export function chatwootMarkdownToWhatsapp(content: string | null | undefined): string {
  if (!content) return stripWhatsappMentionMarkdown(content);
  const formatted = content
    .replace(/(?<!\*)\*((?!\s)([^\n*]+?)(?<!\s))\*(?!\*)/g, '_$1_') // * -> _ (italic)
    .replace(/\*{2}((?!\s)([^\n*]+?)(?<!\s))\*{2}/g, '*$1*') // ** -> * (bold)
    .replace(/~{2}((?!\s)([^\n*]+?)(?<!\s))~{2}/g, '~$1~') // ~~ -> ~ (strike)
    .replace(/(?<!`)`((?!\s)([^`*]+?)(?<!\s))`(?!`)/g, '```$1```'); // ` -> ``` (mono)
  return stripWhatsappMentionMarkdown(formatted);
}
