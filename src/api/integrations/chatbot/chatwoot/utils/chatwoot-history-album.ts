import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const validSenderKeySidecar = (body: any) => {
  const value = body?.senderKeyDistributionMessage;
  return (
    value === undefined ||
    (value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => ['groupId', 'axolotlSenderKeyDistributionMessage'].includes(key)) &&
      typeof value.groupId === 'string' &&
      value.groupId.length > 0 &&
      typeof value.axolotlSenderKeyDistributionMessage === 'string' &&
      value.axolotlSenderKeyDistributionMessage.length > 0)
  );
};

const fail = () => {
  throw new Error('Album container dependencies or preserved destination are unproved');
};
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
const sorted = (value: any): any =>
  value instanceof Date
    ? value.toISOString()
    : Array.isArray(value)
      ? value.map(sorted)
      : object(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sorted(value[key])]),
          )
        : value;
const metadata = (value: any) =>
  value === undefined ||
  (object(value) &&
    Object.keys(value).every((key) => ['messageSecret', 'threadId', 'messageAssociation'].includes(key)) &&
    (value.messageSecret === undefined ||
      (typeof value.messageSecret === 'string' &&
        Buffer.from(value.messageSecret, 'base64').length === 32 &&
        Buffer.from(value.messageSecret, 'base64').toString('base64') === value.messageSecret)) &&
    (value.threadId === undefined || (Array.isArray(value.threadId) && value.threadId.length === 0)));
const hash = (value: any) =>
  createHash('sha256')
    .update(JSON.stringify(sorted(value)))
    .digest('hex');

const albumContextInfo = (value: any) => {
  if (value === undefined) return true;
  if (
    !object(value) ||
    !Object.keys(value).every((key) =>
      ['messageSecret', 'threadId', 'deviceListMetadata', 'deviceListMetadataVersion', 'limitSharingV2'].includes(key),
    )
  )
    return false;
  const base = Object.fromEntries(Object.entries(value).filter(([key]) => ['messageSecret', 'threadId'].includes(key)));
  if (!metadata(base)) return false;
  const long = (v: any, unsigned: boolean) =>
    object(v) &&
    Object.keys(v).sort().join(',') === 'high,low,unsigned' &&
    Number.isInteger(v.low) &&
    v.low >= -2147483648 &&
    v.low <= 2147483647 &&
    Number.isInteger(v.high) &&
    v.high >= 0 &&
    v.high <= 2097151 &&
    v.unsigned === unsigned;
  const hash10 = (v: any) =>
    typeof v === 'string' &&
    Buffer.from(v, 'base64').length === 10 &&
    Buffer.from(v, 'base64').toString('base64') === v;
  const device = value.deviceListMetadata;
  if (device !== undefined) {
    if (
      value.deviceListMetadataVersion !== 2 ||
      !object(device) ||
      Object.keys(device).sort().join(',') !==
        'recipientKeyHash,recipientKeyIndexes,recipientTimestamp,senderKeyHash,senderKeyIndexes,senderTimestamp' ||
      !hash10(device.senderKeyHash) ||
      !hash10(device.recipientKeyHash) ||
      !long(device.senderTimestamp, true) ||
      !long(device.recipientTimestamp, true) ||
      !Array.isArray(device.senderKeyIndexes) ||
      device.senderKeyIndexes.length !== 0 ||
      !Array.isArray(device.recipientKeyIndexes) ||
      device.recipientKeyIndexes.length !== 0
    )
      return false;
  } else if (value.deviceListMetadataVersion !== undefined) return false;
  const limit = value.limitSharingV2;
  if (
    limit !== undefined &&
    (!object(limit) ||
      Object.keys(limit).sort().join(',') !== 'initiatedByMe,limitSharingSettingTimestamp,sharingLimited,trigger' ||
      limit.trigger !== 1 ||
      limit.initiatedByMe !== false ||
      limit.sharingLimited !== true ||
      !long(limit.limitSharingSettingTimestamp, false))
  )
    return false;
  return true;
};

const boundedAlbumContext = (value: any): boolean => {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  let nodes = 0;
  const valid = (item: any, depth: number): boolean => {
    if (++nodes > 4096 || depth > 16) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return Buffer.byteLength(item, 'utf8') <= 65536;
    if (!item || typeof item !== 'object') return false;
    const array = Array.isArray(item);
    if (array && ![Array.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== 'string')) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some((entry) => !('value' in entry))) return false;
    if (array) {
      if (item.length > 512 || keys.length !== item.length + 1) return false;
      return Array.from({ length: item.length }, (_, i) => descriptors[String(i)]).every(
        (entry) => entry && valid(entry.value, depth + 1),
      );
    }
    if (keys.length > 256 || keys.some((key) => Buffer.byteLength(String(key), 'utf8') > 256)) return false;
    return Object.values(descriptors).every((entry) => valid(entry.value, depth + 1));
  };
  return valid(value, 0) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 65536;
};

export function albumImageCount(record: any, disposition: 'legacy' | 'container_only' = 'legacy'): number {
  const body = record.message;
  const album = body?.albumMessage;
  if (
    (disposition !== 'legacy' && disposition !== 'container_only') ||
    record.messageType !== 'albumMessage' ||
    !object(body) ||
    !object(album) ||
    !Object.keys(body).every((key) =>
      ['albumMessage', 'messageContextInfo', 'senderKeyDistributionMessage'].includes(key),
    ) ||
    !validSenderKeySidecar(body) ||
    !Object.keys(album).every((key) => ['expectedImageCount', 'expectedVideoCount', 'contextInfo'].includes(key)) ||
    !Number.isInteger(album.expectedImageCount) ||
    album.expectedImageCount < (disposition === 'container_only' ? 0 : 1) ||
    album.expectedImageCount > 13 ||
    album.expectedVideoCount !== 0 ||
    (disposition === 'legacy' &&
      album.contextInfo !== undefined &&
      (!object(album.contextInfo) ||
        !Object.keys(album.contextInfo).every((key) =>
          [
            'isForwarded',
            'mentionedJid',
            'forwardOrigin',
            'groupMentions',
            'forwardingScore',
            'statusAttributions',
            'stanzaId',
            'participant',
            'quotedType',
            'quotedMessage',
          ].includes(key),
        ))) ||
    (disposition === 'legacy' &&
      album.contextInfo !== undefined &&
      ['stanzaId', 'participant', 'quotedType', 'quotedMessage'].some((key) => album.contextInfo[key] !== undefined) &&
      (typeof album.contextInfo.stanzaId !== 'string' ||
        album.contextInfo.stanzaId.length === 0 ||
        typeof album.contextInfo.participant !== 'string' ||
        album.contextInfo.participant.length === 0 ||
        album.contextInfo.quotedType !== 0 ||
        !object(album.contextInfo.quotedMessage) ||
        Object.keys(album.contextInfo.quotedMessage).join(',') !== 'extendedTextMessage' ||
        !object(album.contextInfo.quotedMessage.extendedTextMessage) ||
        typeof album.contextInfo.quotedMessage.extendedTextMessage.text !== 'string')) ||
    (disposition === 'container_only' && album.contextInfo !== undefined && !boundedAlbumContext(album.contextInfo)) ||
    (disposition === 'legacy'
      ? !albumContextInfo(body.messageContextInfo)
      : body.messageContextInfo !== undefined && !boundedAlbumContext(body.messageContextInfo))
  )
    fail();
  return album.expectedImageCount;
}

const bytes = (value: any) => {
  if (Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (
    object(value) &&
    Number.isInteger(value.low) &&
    Number.isInteger(value.high) &&
    value.low >= -2147483648 &&
    value.low <= 2147483647 &&
    value.high >= -2147483648 &&
    value.high <= 2147483647 &&
    value.unsigned === true
  )
    return (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0);
  return fail();
};

const albumMetadataCompanion = (record: any, parent: any) => {
  const context = record.message?.messageContextInfo;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    record.id !== parent.id &&
    record.instanceId === parent.instanceId &&
    record.messageType === 'unknown' &&
    object(record.message) &&
    Object.keys(record.message).join(',') === 'messageContextInfo' &&
    object(context) &&
    Object.keys(context).sort().join(',') === 'messageSecret,threadId' &&
    Array.isArray(context.threadId) &&
    context.threadId.length === 0 &&
    typeof context.messageSecret === 'string' &&
    Buffer.from(context.messageSecret, 'base64').length === 32 &&
    Buffer.from(context.messageSecret, 'base64').toString('base64') === context.messageSecret &&
    record.key?.id === parent.key.id &&
    record.key.fromMe === parent.key.fromMe &&
    record.key.remoteJid === parent.key.remoteJid &&
    Object.keys(record.key).every((name) =>
      ['id', 'fromMe', 'remoteJid', 'participant', 'participantAlt'].includes(name),
    ) &&
    (record.key.participant === undefined || record.key.participant === parent.key.participant) &&
    (record.key.participantAlt === undefined || record.key.participantAlt === parent.key.participantAlt) &&
    Number.isSafeInteger(record.messageTimestamp) &&
    record.messageTimestamp > 0 &&
    record.messageTimestamp <= parent.messageTimestamp
  );
};
const rawHash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function preserveAlbumContainers(
  parents: any[],
  repository: any,
  pool: any,
  accountID: number,
  inboxID: number,
  disposition: 'legacy' | 'container_only' = 'legacy',
) {
  const snapshots = new Map<string, any>();
  const proofs = new Map<string, any>();
  const read = async (parent: any) => {
    const count = albumImageCount(parent, disposition);
    const key = parent.key;
    if (disposition === 'container_only') {
      // This is versioned container bookkeeping, not proof of children or their destination.
      if (
        typeof parent.instanceId !== 'string' ||
        !parent.instanceId ||
        typeof key?.id !== 'string' ||
        !key.id ||
        typeof key.fromMe !== 'boolean' ||
        typeof key.remoteJid !== 'string' ||
        !/^[^@\s]+@(g\.us|s\.whatsapp\.net|lid)$/.test(key.remoteJid)
      )
        fail();
    } else if (
      disposition !== 'legacy' ||
      !parent.instanceId ||
      typeof key?.id !== 'string' ||
      !key.id ||
      key.fromMe !== false ||
      typeof key.remoteJid !== 'string' ||
      !key.remoteJid.endsWith('@g.us') ||
      typeof key.participant !== 'string' ||
      !key.participant
    )
      fail();
    const originals = await repository.findMany({
      where: { instanceId: parent.instanceId, key: { path: ['id'], equals: key.id } },
      take: 17,
      orderBy: { id: 'asc' },
    });
    if (disposition === 'container_only' || originals.length > 1) {
      if (
        typeof parent.id !== 'string' ||
        parent.id.length === 0 ||
        originals.length < 1 ||
        originals.length > 16 ||
        originals.filter((row: any) => isDeepStrictEqual(row, parent)).length !== 1 ||
        new Set(originals.map((row: any) => row.id)).size !== originals.length ||
        !Number.isSafeInteger(parent.messageTimestamp) ||
        parent.messageTimestamp <= 0 ||
        originals.some((row: any) => row.id !== parent.id && !albumMetadataCompanion(row, parent))
      )
        fail();
      return { parent, sameKeyNativeRows: originals, count, containerOnly: true as const };
    }
    if (originals.length !== 1 || !isDeepStrictEqual(originals[0], parent)) fail();
    // Do not filter peer/direction/type: contradictory associations must remain visible and refuse.
    const children = await repository.findMany({
      where: {
        instanceId: parent.instanceId,
        message: { path: ['messageContextInfo', 'messageAssociation', 'parentMessageKey', 'id'], equals: key.id },
      },
      take: count + 1,
      orderBy: { id: 'asc' },
    });
    if (
      children.length !== count ||
      new Set(children.map((child: any) => child.id)).size !== count ||
      new Set(children.map((child: any) => child.key?.id)).size !== count
    )
      fail();
    for (const child of children) {
      const association = child.message?.messageContextInfo?.messageAssociation;
      const nested = association?.parentMessageKey;
      const image = child.message?.imageMessage;
      if (
        child.instanceId !== parent.instanceId ||
        child.messageType !== 'imageMessage' ||
        !object(image) ||
        !object(child.message) ||
        !Object.keys(child.message).every((name) =>
          ['imageMessage', 'messageContextInfo', 'mediaUrl'].includes(name),
        ) ||
        child.key?.fromMe !== false ||
        child.key.remoteJid !== key.remoteJid ||
        child.key.participant !== key.participant ||
        child.key.participantAlt !== key.participantAlt ||
        typeof child.key.id !== 'string' ||
        !child.key.id ||
        !metadata(child.message.messageContextInfo) ||
        !object(association) ||
        !Object.keys(association).every((name) => ['associationType', 'parentMessageKey'].includes(name)) ||
        association.associationType !== 1 ||
        nested?.id !== key.id ||
        nested.remoteJid !== key.remoteJid ||
        !Object.prototype.hasOwnProperty.call(nested, 'fromMe') ||
        typeof nested.fromMe !== 'boolean' ||
        !Number.isSafeInteger(child.chatwootMessageId) ||
        child.chatwootMessageId <= 0 ||
        child.chatwootInboxId !== inboxID ||
        !Number.isSafeInteger(child.chatwootConversationId) ||
        child.chatwootConversationId <= 0 ||
        image.mimetype !== 'image/jpeg' ||
        bytes(image.fileLength) <= 0n
      )
        fail();
    }
    const versions = await repository.findMany({
      where: {
        instanceId: parent.instanceId,
        OR: children.map((child: any) => ({ key: { path: ['id'], equals: child.key.id } })),
      },
      take: count + 1,
      orderBy: { id: 'asc' },
    });
    if (!isDeepStrictEqual(versions, children)) fail();
    const client = await pool.connect();
    let targets: any[];
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await client.query(
        `SELECT to_jsonb(m) AS message, to_jsonb(c) AS conversation,
        to_jsonb(ci) AS contact_inbox, to_jsonb(ct) AS contact, to_jsonb(b) AS binding,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('attachment',to_jsonb(a),'storage',to_jsonb(s),'blob',to_jsonb(bl)) ORDER BY a.id,s.id)
          FROM attachments a LEFT JOIN active_storage_attachments s ON s.record_type='Attachment' AND s.record_id=a.id
          LEFT JOIN active_storage_blobs bl ON bl.id=s.blob_id WHERE a.message_id=m.id),'[]'::jsonb) AS media
        FROM messages m JOIN conversations c ON c.id=m.conversation_id
        JOIN contact_inboxes ci ON ci.id=c.contact_inbox_id JOIN contacts ct ON ct.id=c.contact_id
        LEFT JOIN provider_conversation_bindings b ON b.conversation_id=c.id AND b.account_id=c.account_id AND b.inbox_id=c.inbox_id
        WHERE m.inbox_id=$1 AND m.source_id=ANY($2::text[]) ORDER BY m.id`,
        [inboxID, children.flatMap((child: any) => ['WAID:' + child.key.id, child.key.id])],
      );
      targets = result.rows;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (targets.length !== count) fail();
    for (const child of children) {
      const matches = targets.filter((row) => ['WAID:' + child.key.id, child.key.id].includes(row.message.source_id));
      if (matches.length !== 1) fail();
      const { message: m, conversation: c, contact_inbox: ci, contact: ct, binding: b, media } = matches[0];
      const attributes =
        typeof m.content_attributes === 'string' ? JSON.parse(m.content_attributes) : m.content_attributes;
      if (
        m.id !== child.chatwootMessageId ||
        m.account_id !== accountID ||
        m.inbox_id !== inboxID ||
        m.message_type !== 0 ||
        m.private !== false ||
        c.account_id !== accountID ||
        c.inbox_id !== inboxID ||
        c.display_id !== child.chatwootConversationId ||
        ci.inbox_id !== inboxID ||
        ci.contact_id !== c.contact_id ||
        ct.id !== c.contact_id ||
        ct.account_id !== accountID ||
        b?.provider !== 'whatsapp' ||
        b.peer !== key.remoteJid ||
        attributes?.deleted === true ||
        attributes?.we_digital_ingress?.version !== 2 ||
        attributes.we_digital_ingress.provider !== 'evo_whatsapp' ||
        attributes.we_digital_ingress.scope !== 'group' ||
        attributes.we_digital_ingress.direction !== 'inbound' ||
        attributes.we_digital_ingress.from_me !== false ||
        !Array.isArray(media) ||
        media.length !== 1 ||
        media[0].attachment.file_type !== 0 ||
        media[0].storage?.name !== 'file' ||
        media[0].blob?.content_type !== child.message.imageMessage.mimetype ||
        BigInt(media[0].blob?.byte_size || 0) !== bytes(child.message.imageMessage.fileLength)
      )
        fail();
    }
    return { parent, children, targets };
  };
  for (const parent of parents) {
    const snapshot = await read(parent);
    snapshots.set(parent.id, snapshot);
    if ('containerOnly' in snapshot) {
      const sourceNativeJSON = JSON.stringify(parent);
      const sameKeyNativeJSON = JSON.stringify(snapshot.sameKeyNativeRows);
      proofs.set('WAID:' + parent.key.id, {
        version: 2,
        disposition: 'container_only',
        accountID,
        inboxID,
        parentSourceID: 'WAID:' + parent.key.id,
        parentNativeID: parent.id,
        parentVersionSHA256: hash({
          key: parent.key,
          message: parent.message,
          messageTimestamp: parent.messageTimestamp,
          messageType: parent.messageType,
          status: parent.status,
        }),
        expectedImages: snapshot.count,
        expectedVideos: 0,
        childrenComplete: false,
        childrenQueried: false,
        sourceNativeJSON,
        sourceNativeSHA256: rawHash(sourceNativeJSON),
        sameKeyNativeJSON,
        sameKeyNativeSHA256: rawHash(sameKeyNativeJSON),
      });
      continue;
    }
    proofs.set('WAID:' + parent.key.id, {
      version: 1,
      accountID,
      inboxID,
      parentSourceID: 'WAID:' + parent.key.id,
      parentVersionSHA256: hash({
        key: parent.key,
        message: parent.message,
        messageTimestamp: parent.messageTimestamp,
        messageType: parent.messageType,
        status: parent.status,
      }),
      expectedImages: snapshot.children.length,
      expectedVideos: 0,
      unresolvedSemantics: 'nested_sender_relative_direction_not_normalized',
      children: snapshot.children.map((child: any) => ({
        sourceID: 'WAID:' + child.key.id,
        nativeVersionSHA256: hash(child),
        destinationMessageID: child.chatwootMessageId,
        destinationDisplayID: child.chatwootConversationId,
        nestedFromMe: child.message.messageContextInfo.messageAssociation.parentMessageKey.fromMe,
      })),
      destinationSnapshotSHA256: hash(snapshot.targets),
    });
  }
  return {
    proofs,
    assertCurrent: async () => {
      for (const parent of parents) if (!isDeepStrictEqual(snapshots.get(parent.id), await read(parent))) fail();
    },
  };
}
