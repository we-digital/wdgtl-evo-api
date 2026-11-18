import { getContentType, normalizeMessageContent, WAMessage } from 'baileys';

// C170 (2026-11-18): a stored WhatsApp message also carries what belonged to its own delivery: the sender key for
// the chat it arrived in (`senderKeyDistributionMessage`), its `messageContextInfo` (message secret, device list),
// and fork-only fields such as `mediaUrl`. Baileys' generateForwardMessageContent copies all of it, then marks the
// forward on `Object.keys(content)[0]`, which after its protobuf round-trip is `senderKeyDistributionMessage`
// (field 2) whenever one is present. The forward then went out as a group message holding another group's sender
// key, with the picture's own context untouched: linked devices (Baileys) showed it, the WhatsApp phone app dropped
// it silently. Forward only the message itself.
export function nativeForwardSource(source: WAMessage): WAMessage {
  const content = normalizeMessageContent(source?.message);
  const type = getContentType(content);
  if (!type || content[type] === undefined || content[type] === null) {
    throw Object.assign(new Error('Native forward source has no message content'), {
      name: 'NativeForwardSourceMissing',
    });
  }
  return { ...source, message: { [type]: content[type] } };
}
