import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export type DirectAlbumOwner = {
  instanceId: string;
  accountID: number;
  inboxID: number;
  registeredPN: string;
  livePN: string;
  liveLID: string;
};
const fail = () => {
  throw new Error('Direct mixed album preserved children are unproved');
};
const jid = (v: unknown) => (typeof v === 'string' ? v.replace(/:[^@]+@/, '@') : '');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const length = (v: any) => {
  if (Number.isSafeInteger(v) && v > 0) return v;
  if (v && Number.isInteger(v.low) && Number.isInteger(v.high) && v.high === 0 && v.unsigned === true)
    return v.low >>> 0;
  return fail();
};

// Bookkeeping only: proves the exact existing child set and preserves all raw rows.
// Physical-byte acceptance remains separate; this function never downloads or writes files.
export async function preserveDirectMixedChildren(
  parent: any,
  repository: any,
  pool: any,
  accountID: number,
  inboxID: number,
  readOwner?: (parent: any) => Promise<DirectAlbumOwner>,
) {
  const key = parent.key;
  if (!readOwner || key?.fromMe !== false || !/^[^@\s:]+@(lid|s\.whatsapp\.net)$/.test(key?.remoteJid)) fail();
  if (key.remoteJidAlt !== undefined && !/^[^@\s:]+@(lid|s\.whatsapp\.net)$/.test(key.remoteJidAlt)) fail();
  const owner = await readOwner(parent);
  const ownLID = jid(owner.liveLID);
  if (
    owner.instanceId !== parent.instanceId ||
    owner.accountID !== accountID ||
    owner.inboxID !== inboxID ||
    !/^[^@\s:]+@lid$/.test(ownLID) ||
    !/^[^@\s:]+@s\.whatsapp\.net$/.test(jid(owner.livePN)) ||
    jid(owner.registeredPN) !== jid(owner.livePN) ||
    ownLID === key.remoteJid
  )
    fail();
  const children = await repository.findMany({
    where: {
      instanceId: parent.instanceId,
      message: { path: ['messageContextInfo', 'messageAssociation', 'parentMessageKey', 'id'], equals: key.id },
    },
    take: 5,
    orderBy: { id: 'asc' },
  });
  if (
    children.length !== 4 ||
    new Set(children.map((c: any) => c.id)).size !== 4 ||
    new Set(children.map((c: any) => c.key?.id)).size !== 4 ||
    children.filter((c: any) => c.messageType === 'imageMessage').length !== 3 ||
    children.filter((c: any) => c.messageType === 'videoMessage').length !== 1
  )
    fail();
  for (const c of children) {
    const association = c.message?.messageContextInfo?.messageAssociation;
    const nested = association?.parentMessageKey;
    const media = c.message?.[c.messageType];
    const sha = media?.fileSha256;
    if (
      c.instanceId !== parent.instanceId ||
      c.key?.fromMe !== false ||
      c.key.remoteJid !== key.remoteJid ||
      c.key.remoteJidAlt !== key.remoteJidAlt ||
      c.key.participant !== key.participant ||
      c.key.participantAlt !== key.participantAlt ||
      typeof c.key.id !== 'string' ||
      !c.key.id ||
      !Number.isSafeInteger(c.messageTimestamp) ||
      c.messageTimestamp <= 0 ||
      association?.associationType !== 1 ||
      nested?.id !== key.id ||
      nested.fromMe !== true ||
      jid(nested.remoteJid) !== ownLID ||
      !Object.keys(association).every((k) => ['associationType', 'parentMessageKey'].includes(k)) ||
      !Object.keys(nested).every((k) => ['id', 'fromMe', 'remoteJid'].includes(k)) ||
      !Object.keys(c.message).every((k) => [c.messageType, 'messageContextInfo', 'mediaUrl'].includes(k)) ||
      !media ||
      !['image/jpeg', 'video/mp4'].includes(media.mimetype) ||
      media.mimetype !== (c.messageType === 'imageMessage' ? 'image/jpeg' : 'video/mp4') ||
      typeof sha !== 'string' ||
      Buffer.from(sha, 'base64').length !== 32 ||
      Buffer.from(sha, 'base64').toString('base64') !== sha ||
      (media.caption !== undefined && typeof media.caption !== 'string') ||
      !Number.isSafeInteger(c.chatwootMessageId) ||
      c.chatwootMessageId <= 0 ||
      c.chatwootInboxId !== inboxID ||
      !Number.isSafeInteger(c.chatwootConversationId) ||
      c.chatwootConversationId <= 0 ||
      length(media.fileLength) <= 0
    )
      fail();
  }
  const versions = await repository.findMany({
    where: {
      instanceId: parent.instanceId,
      OR: children.map((c: any) => ({ key: { path: ['id'], equals: c.key.id } })),
    },
    take: 5,
    orderBy: { id: 'asc' },
  });
  if (!isDeepStrictEqual(versions, children)) fail();
  const client = await pool.connect();
  let targets: any[];
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    targets = (
      await client.query(
        `SELECT to_jsonb(m) AS message, to_jsonb(c) AS conversation,
      to_jsonb(ci) AS contact_inbox, to_jsonb(ct) AS contact, to_jsonb(b) AS binding,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('attachment',to_jsonb(a),'storage',to_jsonb(s),'blob',to_jsonb(bl)) ORDER BY a.id,s.id)
        FROM attachments a LEFT JOIN active_storage_attachments s ON s.record_type='Attachment' AND s.record_id=a.id
        LEFT JOIN active_storage_blobs bl ON bl.id=s.blob_id WHERE a.message_id=m.id),'[]'::jsonb) AS media
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
      JOIN contact_inboxes ci ON ci.id=c.contact_inbox_id JOIN contacts ct ON ct.id=c.contact_id
      LEFT JOIN provider_conversation_bindings b ON b.conversation_id=c.id AND b.account_id=c.account_id AND b.inbox_id=c.inbox_id
      WHERE m.inbox_id=$1 AND m.source_id=ANY($2::text[]) ORDER BY m.id`,
        [inboxID, children.flatMap((c: any) => ['WAID:' + c.key.id, c.key.id])],
      )
    ).rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (targets.length !== 4 || new Set(targets.map((r) => r.conversation?.id)).size !== 1) fail();
  for (const child of children) {
    const rows = targets.filter((r: any) => ['WAID:' + child.key.id, child.key.id].includes(r.message.source_id));
    if (rows.length !== 1) fail();
    const { message: m, conversation: c, contact_inbox: ci, contact: ct, binding: b, media } = rows[0];
    const attrs = typeof m.content_attributes === 'string' ? JSON.parse(m.content_attributes) : m.content_attributes;
    const native = child.message[child.messageType];
    const aliases = [key.remoteJid, key.remoteJidAlt].filter((v) => typeof v === 'string' && v.length);
    if (
      m.id !== child.chatwootMessageId ||
      m.account_id !== accountID ||
      m.inbox_id !== inboxID ||
      m.message_type !== 0 ||
      m.private !== false ||
      (m.content !== (native.caption || '') &&
        !(m.content === null && (native.caption === undefined || native.caption === ''))) ||
      c.id !== m.conversation_id ||
      c.account_id !== accountID ||
      c.inbox_id !== inboxID ||
      c.display_id !== child.chatwootConversationId ||
      ci.id !== c.contact_inbox_id ||
      ci.inbox_id !== inboxID ||
      ci.contact_id !== c.contact_id ||
      ct.id !== c.contact_id ||
      ct.account_id !== accountID ||
      b?.provider !== 'whatsapp' ||
      b.account_id !== accountID ||
      b.inbox_id !== inboxID ||
      b.conversation_id !== c.id ||
      !aliases.includes(b.peer) ||
      attrs?.deleted === true ||
      attrs?.we_digital_ingress?.version !== 2 ||
      attrs.we_digital_ingress.provider !== 'evo_whatsapp' ||
      attrs.we_digital_ingress.scope !== 'direct' ||
      attrs.we_digital_ingress.direction !== 'inbound' ||
      attrs.we_digital_ingress.from_me !== false ||
      media?.length !== 1 ||
      media[0].attachment.message_id !== m.id ||
      media[0].attachment.account_id !== accountID ||
      media[0].attachment.file_type !== (child.messageType === 'imageMessage' ? 0 : 2) ||
      media[0].storage?.name !== 'file' ||
      media[0].storage.record_id !== media[0].attachment.id ||
      media[0].storage.blob_id !== media[0].blob?.id ||
      media[0].blob.content_type !== native.mimetype ||
      Number(media[0].blob.byte_size) !== length(native.fileLength) ||
      typeof media[0].blob.checksum !== 'string' ||
      Buffer.from(media[0].blob.checksum, 'base64').length !== 16
    )
      fail();
  }
  // Never emit authenticated PN/LID values. These hashes bind final pre-ACK rereads.
  return {
    version: 1,
    instanceId: parent.instanceId,
    semantics: 'direct_receiver_owned_lid_parent',
    accountID,
    inboxID,
    receiverLIDSHA256: digest(ownLID),
    ownerIdentitySHA256: digest({
      instanceId: owner.instanceId,
      registeredPN: jid(owner.registeredPN),
      livePN: jid(owner.livePN),
      liveLID: ownLID,
    }),
    childrenNativeJSON: JSON.stringify(children),
    childrenNativeSHA256: digest(children),
    destinationSnapshotJSON: JSON.stringify(targets),
    destinationSnapshotSHA256: digest(targets),
    children: children.map((c: any) => ({
      sourceID: 'WAID:' + c.key.id,
      nativeVersionSHA256: digest(c),
      destinationMessageID: c.chatwootMessageId,
      destinationDisplayID: c.chatwootConversationId,
      nestedFromMe: true,
    })),
    existingPhysicalBytesClaimed: false,
  };
}
