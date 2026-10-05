import { createDecipheriv, hkdfSync } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Message } from '@prisma/client';
import { proto } from 'baileys';

function bytes(value: unknown): Buffer {
  if (typeof value === 'string') {
    const result = Buffer.from(value, 'base64');
    if (result.toString('base64') === value) return result;
  }
  if (Buffer.isBuffer(value)) return value;
  const saved = value as { type?: unknown; data?: unknown };
  if (
    saved?.type === 'Buffer' &&
    Array.isArray(saved.data) &&
    saved.data.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)
  )
    return Buffer.from(saved.data);
  throw new Error('Retained encrypted edit has invalid bytes');
}

function sender(jid: unknown): string {
  if (typeof jid !== 'string' || !/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(jid))
    throw new Error('Retained encrypted edit lacks an explicit provider sender');
  return jid.replace(/:\d+@/, '@');
}

/** Pinned whatsmeow msgsecret.go Message Edit HKDF/AES-GCM semantics; no alias guesses. */
export function recoverEncryptedHistoryEdit(envelope: Message, original: Message): Message {
  const key = envelope.key as any;
  const originalKey = original.key as any;
  const encrypted = (envelope.message as any)?.secretEncryptedMessage;
  const target = encrypted?.targetMessageKey;
  if (
    !encrypted ||
    encrypted.secretEncType !== 2 ||
    envelope.instanceId !== original.instanceId ||
    typeof key?.fromMe !== 'boolean' ||
    key.fromMe !== originalKey?.fromMe ||
    typeof target?.fromMe !== 'boolean' ||
    !target.id ||
    target.id !== originalKey?.id ||
    target.remoteJid !== originalKey?.remoteJid ||
    key.remoteJid !== originalKey?.remoteJid
  )
    throw new Error('Retained encrypted edit target identity differs');
  if (
    !Number.isSafeInteger(envelope.messageTimestamp) ||
    !Number.isSafeInteger(original.messageTimestamp) ||
    envelope.messageTimestamp <= original.messageTimestamp ||
    original.status === 'EDITED'
  )
    throw new Error('Retained encrypted edit ordering is unavailable or older than the current original');
  const group = key.remoteJid.endsWith('@g.us');
  // An edit must be authored by the retained original sender in the same business direction.
  const modifier = sender(group ? key.participant : key.fromMe ? key.participant : key.remoteJid);
  const storedSender = sender(
    group ? originalKey.participant : originalKey.fromMe ? originalKey.participant : originalKey.remoteJid,
  );
  if (modifier !== storedSender) throw new Error('Retained encrypted edit original author differs');
  const primarySender = target.fromMe ? modifier : sender(group ? target.participant : target.remoteJid);
  const secret = bytes((original.message as any)?.messageContextInfo?.messageSecret);
  const iv = bytes(encrypted.encIv);
  const ciphertext = bytes(encrypted.encPayload);
  if (secret.length !== 32 || iv.length !== 12 || ciphertext.length < 16)
    throw new Error('Retained encrypted edit has invalid authenticated lengths');
  let plaintext: Buffer;
  for (const origin of new Set([primarySender, storedSender])) {
    const derived = Buffer.from(
      hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(target.id + origin + modifier + 'Message Edit'), 32),
    );
    try {
      const decipher = createDecipheriv('aes-256-gcm', derived, iv);
      decipher.setAuthTag(ciphertext.subarray(-16));
      plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
      break;
    } catch (error) {
      if (!String((error as Error).message).includes('authenticate data')) throw error;
    }
  }
  if (!plaintext) throw new Error('Retained encrypted edit authentication failed');
  const decoded = proto.Message.decode(plaintext);
  if (!Buffer.from(proto.Message.encode(decoded).finish()).equals(plaintext))
    throw new Error('Retained encrypted edit has unknown protobuf data');
  const message = proto.Message.toObject(decoded, { bytes: String, longs: String, enums: Number });
  const protocol = message.protocolMessage;
  const metadata = message.messageContextInfo;
  if (
    metadata !== undefined &&
    (Object.keys(metadata).length !== 1 ||
      typeof metadata.messageSecret !== 'string' ||
      bytes(metadata.messageSecret).length !== 32)
  )
    throw new Error('Retained encrypted edit authenticated metadata is unsupported');
  if (
    Object.keys(message).some((field) => field !== 'protocolMessage' && field !== 'messageContextInfo') ||
    protocol?.type !== 14 ||
    !isDeepStrictEqual(protocol.key, target)
  )
    throw new Error('Retained encrypted edit inner target differs');
  // Authenticated wrapper metadata is not a replacement for the original message context.
  const edit = protocol.editedMessage;
  let body: any;
  if (
    Object.keys(edit || {}).length === 1 &&
    typeof edit.conversation === 'string' &&
    ['conversation', 'extendedTextMessage'].includes(original.messageType)
  ) {
    body = { ...(original.message as any), conversation: edit.conversation };
    delete body.extendedTextMessage;
    return { ...original, messageType: 'conversation', message: body };
  }
  if (
    Object.keys(edit || {}).length === 1 &&
    typeof edit.extendedTextMessage?.text === 'string' &&
    ['conversation', 'extendedTextMessage'].includes(original.messageType)
  ) {
    body = {
      ...(original.message as any),
      extendedTextMessage: {
        ...((original.message as any)?.extendedTextMessage || {}),
        text: edit.extendedTextMessage.text,
      },
    };
    delete body.conversation;
    return { ...original, messageType: 'extendedTextMessage', message: body };
  }
  const captionEdit = edit?.documentWithCaptionMessage?.message?.documentMessage;
  if (
    Object.keys(edit || {}).length === 1 &&
    captionEdit &&
    typeof captionEdit.caption === 'string' &&
    Object.keys(captionEdit).every((name) => name === 'caption' || name === 'contextInfo') &&
    original.messageType === 'documentMessage' &&
    (original.message as any)?.documentMessage
  ) {
    // The encrypted envelope carries a caption delta, not a replacement attachment.
    body = {
      ...(original.message as any),
      documentMessage: { ...(original.message as any).documentMessage, caption: captionEdit.caption },
    };
    return { ...original, message: body };
  }
  throw new Error('Retained encrypted edit content is unsupported');
}
