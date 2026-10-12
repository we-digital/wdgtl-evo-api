import { createHash } from 'node:crypto';

import { preserveAlbumContainers } from '../../src/api/integrations/chatbot/chatwoot/utils/chatwoot-history-album';
export function mixedFixture() {
  const parent: any = {
    id: 'parent',
    instanceId: 'owned',
    key: { id: 'album', fromMe: false, remoteJid: 'sender@lid' },
    messageType: 'albumMessage',
    messageTimestamp: 123,
    status: 'READ',
    message: { albumMessage: { expectedImageCount: 3, expectedVideoCount: 1 } },
  };
  const owner = {
    instanceId: 'owned',
    accountID: 1,
    inboxID: 108,
    registeredPN: 'receiver@s.whatsapp.net',
    livePN: 'receiver:0@s.whatsapp.net',
    liveLID: 'recipient:0@lid',
  };
  const children: any[] = Array.from({ length: 4 }, (_, i) => {
    const type = i ? 'imageMessage' : 'videoMessage';
    return {
      id: 'child' + i,
      instanceId: 'owned',
      key: { ...parent.key, id: 'child-key' + i },
      messageType: type,
      messageTimestamp: 124 + i,
      status: 'READ',
      chatwootMessageId: 100 + i,
      chatwootInboxId: 108,
      chatwootConversationId: 500,
      message: {
        [type]: {
          mimetype: i ? 'image/jpeg' : 'video/mp4',
          caption: 'caption' + i,
          fileLength: { low: 100, high: 0, unsigned: true },
          fileSha256: createHash('sha256')
            .update('bytes' + i)
            .digest('base64'),
        },
        messageContextInfo: {
          messageAssociation: {
            associationType: 1,
            parentMessageKey: { id: 'album', remoteJid: 'recipient@lid', fromMe: true },
          },
        },
      },
    };
  });
  const targets = children.map((child, i) => ({
    message: {
      id: child.chatwootMessageId,
      source_id: 'WAID:' + child.key.id,
      account_id: 1,
      inbox_id: 108,
      conversation_id: 50,
      message_type: 0,
      private: false,
      content: 'caption' + i,
      created_at: 130 + i,
      content_attributes: {
        we_digital_ingress: {
          version: 2,
          provider: 'evo_whatsapp',
          scope: 'direct',
          direction: 'inbound',
          from_me: false,
        },
      },
    },
    conversation: { id: 50, account_id: 1, inbox_id: 108, contact_id: 9, contact_inbox_id: 10, display_id: 500 },
    contact_inbox: { id: 10, inbox_id: 108, contact_id: 9 },
    contact: { id: 9, account_id: 1 },
    binding: { provider: 'whatsapp', account_id: 1, inbox_id: 108, conversation_id: 50, peer: parent.key.remoteJid },
    media: [
      {
        attachment: { id: i + 200, message_id: child.chatwootMessageId, account_id: 1, file_type: i ? 0 : 2 },
        storage: { name: 'file', record_id: i + 200, blob_id: i + 300 },
        blob: {
          id: i + 300,
          byte_size: 100,
          content_type: i ? 'image/jpeg' : 'video/mp4',
          checksum: Buffer.alloc(16, i).toString('base64'),
        },
      },
    ],
  }));
  const queries: string[] = [];
  const repository = {
    findMany: async (q: any) => structuredClone(q.where.message || q.where.OR ? children : [parent]),
  };
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: structuredClone(targets) };
      },
      release() {},
    }),
  };
  const run = () =>
    preserveAlbumContainers([parent], repository, pool, 1, 108, 'container_only', async () => structuredClone(owner));
  return { parent, owner, children, targets, repository, pool, queries, run };
}
