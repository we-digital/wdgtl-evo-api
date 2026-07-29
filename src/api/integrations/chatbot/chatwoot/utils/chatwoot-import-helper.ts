import { InstanceDto } from '@api/dto/instance.dto';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import {
  isGroupJid,
  isLidJid,
  isPhoneJid,
  toCanonicalHistoryJid,
  toChatwootSourceId,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import { Chatwoot, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { inbox } from '@figuro/chatwoot-sdk';
import { Chatwoot as ChatwootModel, Contact, Message } from '@prisma/client';
import { proto } from 'baileys';

type ChatwootUser = {
  user_type: string;
  user_id: number;
};

type FksChatwoot = {
  identity_key: string;
  contact_id: string;
  conversation_id: string;
};

type firstLastTimestamp = {
  first: number;
  last: number;
};

type HistoryIdentity = firstLastTimestamp & {
  identityKey: string;
  identifier: string;
  phoneNumber: string | null;
  name: string;
};

type IWebMessageInfo = Omit<proto.IWebMessageInfo, 'key'> & Partial<Pick<proto.IWebMessageInfo, 'key'>>;

class ChatwootImport {
  private logger = new Logger('ChatwootImport');
  private repositoryMessagesCache = new Map<string, Set<string>>();
  private historyMessages = new Map<string, Message[]>();
  private historyContacts = new Map<string, Contact[]>();
  private historyIdentityNames = new Map<string, Map<string, string>>();

  public getRepositoryMessagesCache(instance: InstanceDto) {
    return this.repositoryMessagesCache.has(instance.instanceName)
      ? this.repositoryMessagesCache.get(instance.instanceName)
      : null;
  }

  public setRepositoryMessagesCache(instance: InstanceDto, repositoryMessagesCache: Set<string>) {
    this.repositoryMessagesCache.set(instance.instanceName, repositoryMessagesCache);
  }

  public deleteRepositoryMessagesCache(instance: InstanceDto) {
    this.repositoryMessagesCache.delete(instance.instanceName);
  }

  public addHistoryMessages(instance: InstanceDto, messagesRaw: Message[]) {
    const actualValue = this.historyMessages.has(instance.instanceName)
      ? this.historyMessages.get(instance.instanceName)
      : [];
    this.historyMessages.set(instance.instanceName, [...actualValue, ...messagesRaw]);
  }

  public addHistoryContacts(instance: InstanceDto, contactsRaw: Contact[]) {
    const actualValue = this.historyContacts.has(instance.instanceName)
      ? this.historyContacts.get(instance.instanceName)
      : [];
    this.historyContacts.set(instance.instanceName, actualValue.concat(contactsRaw));
  }

  public addHistoryIdentityNames(instance: InstanceDto, identityNames: Map<string, string>) {
    const current = this.historyIdentityNames.get(instance.instanceName) || new Map<string, string>();
    identityNames.forEach((name, jid) => current.set(jid, name));
    this.historyIdentityNames.set(instance.instanceName, current);
  }

  public deleteHistoryMessages(instance: InstanceDto) {
    this.historyMessages.delete(instance.instanceName);
  }

  public deleteHistoryContacts(instance: InstanceDto) {
    this.historyContacts.delete(instance.instanceName);
  }

  public deleteHistoryIdentityNames(instance: InstanceDto) {
    this.historyIdentityNames.delete(instance.instanceName);
  }

  public clearAll(instance: InstanceDto) {
    this.deleteRepositoryMessagesCache(instance);
    this.deleteHistoryMessages(instance);
    this.deleteHistoryContacts(instance);
    this.deleteHistoryIdentityNames(instance);
  }

  public getHistoryMessagesLenght(instance: InstanceDto) {
    return this.historyMessages.get(instance.instanceName)?.length ?? 0;
  }

  public async importHistoryContacts(instance: InstanceDto, provider: ChatwootDto) {
    try {
      if (this.getHistoryMessagesLenght(instance) > 0) {
        return;
      }

      const pgClient = postgresClient.getChatwootConnection();

      let totalContactsImported = 0;

      const contacts = this.historyContacts.get(instance.instanceName) || [];
      if (contacts.length === 0) {
        return 0;
      }

      let contactsChunk: Contact[] = this.sliceIntoChunks(contacts, 3000);
      while (contactsChunk.length > 0) {
        const labelSql = `SELECT id FROM labels WHERE title = '${provider.nameInbox}' AND account_id = ${provider.accountId} LIMIT 1`;

        let labelId = (await pgClient.query(labelSql))?.rows[0]?.id;

        if (!labelId) {
          // creating label in chatwoot db and getting the id
          const sqlLabel = `INSERT INTO labels (title, color, show_on_sidebar, account_id, created_at, updated_at) VALUES ('${provider.nameInbox}', '#34039B', true, ${provider.accountId}, NOW(), NOW()) RETURNING id`;

          labelId = (await pgClient.query(sqlLabel))?.rows[0]?.id;
        }

        // inserting contacts in chatwoot db
        let sqlInsert = `INSERT INTO contacts
          (name, phone_number, account_id, identifier, created_at, updated_at) VALUES `;
        const bindInsert = [provider.accountId];

        for (const contact of contactsChunk) {
          const isGroup = this.isIgnorePhoneNumber(contact.remoteJid);

          const contactName = isGroup ? `${contact.pushName} (GROUP)` : contact.pushName;
          bindInsert.push(contactName);
          const bindName = `$${bindInsert.length}`;

          let bindPhoneNumber: string;
          if (!isGroup) {
            bindInsert.push(`+${contact.remoteJid.split('@')[0]}`);
            bindPhoneNumber = `$${bindInsert.length}`;
          } else {
            bindPhoneNumber = 'NULL';
          }
          bindInsert.push(contact.remoteJid);
          const bindIdentifier = `$${bindInsert.length}`;

          sqlInsert += `(${bindName}, ${bindPhoneNumber}, $1, ${bindIdentifier}, NOW(), NOW()),`;
        }
        if (sqlInsert.slice(-1) === ',') {
          sqlInsert = sqlInsert.slice(0, -1);
        }
        sqlInsert += ` ON CONFLICT (identifier, account_id)
                       DO UPDATE SET
                        name = EXCLUDED.name,
                        phone_number = EXCLUDED.phone_number,
                        updated_at = NOW()`;

        totalContactsImported += (await pgClient.query(sqlInsert, bindInsert))?.rowCount ?? 0;

        const sqlTags = `SELECT id FROM tags WHERE name = '${provider.nameInbox}' LIMIT 1`;

        const tagData = (await pgClient.query(sqlTags))?.rows[0];
        let tagId = tagData?.id;

        const sqlTag = `INSERT INTO tags (name, taggings_count) VALUES ('${provider.nameInbox}', ${totalContactsImported}) ON CONFLICT (name) DO UPDATE SET taggings_count = tags.taggings_count + ${totalContactsImported} RETURNING id`;

        tagId = (await pgClient.query(sqlTag))?.rows[0]?.id;

        await pgClient.query(sqlTag);

        let sqlInsertLabel = `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at) VALUES `;

        contactsChunk.forEach((contact) => {
          const bindTaggableId = `(SELECT id FROM contacts WHERE identifier = '${contact.remoteJid}' AND account_id = ${provider.accountId})`;
          sqlInsertLabel += `($1, $2, ${bindTaggableId}, $3, NOW()),`;
        });

        if (sqlInsertLabel.slice(-1) === ',') {
          sqlInsertLabel = sqlInsertLabel.slice(0, -1);
        }

        await pgClient.query(sqlInsertLabel, [tagId, 'Contact', 'labels']);

        contactsChunk = this.sliceIntoChunks(contacts, 3000);
      }

      this.deleteHistoryContacts(instance);

      return totalContactsImported;
    } catch (error) {
      this.logger.error(`Error on import history contacts: ${error.toString()}`);
    }
  }

  public async getExistingSourceIds(
    sourceIds: string[],
    conversationId?: number,
    inboxId?: number,
  ): Promise<Set<string>> {
    try {
      const existingSourceIdsSet = new Set<string>();

      if (sourceIds.length === 0) {
        return existingSourceIdsSet;
      }

      // Ensure all sourceIds are consistently prefixed with 'WAID:' as required by downstream systems and database queries.
      const formattedSourceIds = sourceIds.map(toChatwootSourceId);
      const pgClient = postgresClient.getChatwootConnection();

      const params: Array<string[] | number> = [formattedSourceIds];
      const filters = ['source_id = ANY($1)'];
      if (conversationId) {
        params.push(conversationId);
        filters.push(`conversation_id = $${params.length}`);
      }
      if (inboxId) {
        params.push(inboxId);
        filters.push(`inbox_id = $${params.length}`);
      }

      const query = `SELECT source_id FROM messages WHERE ${filters.join(' AND ')}`;

      const result = await pgClient.query(query, params);
      for (const row of result.rows) {
        existingSourceIdsSet.add(row.source_id);
      }

      return existingSourceIdsSet;
    } catch (error) {
      this.logger.error(`Error on getExistingSourceIds: ${error.toString()}`);
      return new Set<string>();
    }
  }

  public async importHistoryMessages(
    instance: InstanceDto,
    chatwootService: ChatwootService,
    inbox: inbox,
    provider: ChatwootModel,
  ) {
    try {
      const pgClient = postgresClient.getChatwootConnection();

      const chatwootUser = await this.getChatwootUser(provider);
      if (!chatwootUser) {
        throw new Error('User not found to import messages.');
      }

      let totalMessagesImported = 0;

      let messagesOrdered = this.historyMessages.get(instance.instanceName) || [];
      if (messagesOrdered.length === 0) {
        return 0;
      }

      // Order by conversation identity and timestamp so historical chronology stays deterministic.
      messagesOrdered.sort((a, b) => {
        const aKey = a.key as {
          remoteJid: string;
        };

        const bKey = b.key as {
          remoteJid: string;
        };

        const aMessageTimestamp = a.messageTimestamp as any as number;
        const bMessageTimestamp = b.messageTimestamp as any as number;

        return aKey.remoteJid.localeCompare(bKey.remoteJid) || aMessageTimestamp - bMessageTimestamp;
      });

      const allMessagesMappedByIdentity = this.createMessagesMapByIdentity(messagesOrdered);
      const identitiesWithTimestamp = new Map<string, firstLastTimestamp>();
      allMessagesMappedByIdentity.forEach((messages: Message[], identityKey: string) => {
        identitiesWithTimestamp.set(identityKey, {
          first: messages[0]?.messageTimestamp as any as number,
          last: messages[messages.length - 1]?.messageTimestamp as any as number,
        });
      });

      const existingSourceIds = await this.getExistingSourceIds(
        messagesOrdered.map((message: any) => message.key.id),
        undefined,
        inbox.id,
      );
      messagesOrdered = messagesOrdered.filter(
        (message: any) => !existingSourceIds.has(toChatwootSourceId(message.key.id)),
      );
      // processing messages in batch
      const batchSize = 4000;
      let messagesChunk: Message[] = this.sliceIntoChunks(messagesOrdered, batchSize);
      while (messagesChunk.length > 0) {
        const messagesByIdentity = this.createMessagesMapByIdentity(messagesChunk);

        if (messagesByIdentity.size > 0) {
          const fksByIdentity = await this.selectOrCreateFksFromChatwoot(
            provider,
            inbox,
            identitiesWithTimestamp,
            messagesByIdentity,
            this.historyIdentityNames.get(instance.instanceName) || new Map<string, string>(),
          );
          const provisionalContactIds = Array.from(messagesByIdentity.keys())
            .filter((identityKey) => isLidJid(identityKey))
            .map((identityKey) => Number(fksByIdentity.get(identityKey)?.contact_id))
            .filter((contactId) => Number.isInteger(contactId) && contactId > 0);
          await this.addUnresolvedLidLabel(provider, provisionalContactIds);

          // inserting messages in chatwoot db
          let sqlValues = '';
          const bindInsertMsg = [provider.accountId, inbox.id];

          messagesByIdentity.forEach((messages: any[], identityKey: string) => {
            const fksChatwoot = fksByIdentity.get(identityKey);

            messages.forEach((message) => {
              if (!message.message) {
                return;
              }

              if (!fksChatwoot?.conversation_id || !fksChatwoot?.contact_id) {
                return;
              }

              const contentMessage = this.getHistoryContentMessage(chatwootService, message);
              if (!contentMessage) {
                return;
              }

              bindInsertMsg.push(contentMessage);
              const bindContent = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(fksChatwoot.conversation_id);
              const bindConversationId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? '1' : '0');
              const bindMessageType = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? chatwootUser.user_type : 'Contact');
              const bindSenderType = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? chatwootUser.user_id : fksChatwoot.contact_id);
              const bindSenderId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(toChatwootSourceId(message.key.id));
              const bindSourceId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.messageTimestamp as number);
              const bindmessageTimestamp = `$${bindInsertMsg.length}`;

              sqlValues += `(${bindContent}::text, $1::bigint, $2::bigint, ${bindConversationId}::bigint,
                  ${bindMessageType}::integer, ${bindSenderType}::text, ${bindSenderId}::bigint,
                  ${bindSourceId}::text, ${bindmessageTimestamp}::bigint),`;
            });
          });
          if (bindInsertMsg.length > 2) {
            if (sqlValues.slice(-1) === ',') {
              sqlValues = sqlValues.slice(0, -1);
            }

            const sqlInsertMsg = `INSERT INTO messages
              (content, processed_message_content, account_id, inbox_id, conversation_id, message_type, private,
              content_type, sender_type, sender_id, source_id, created_at, updated_at)
              SELECT DISTINCT ON (candidate.inbox_id, candidate.source_id)
                candidate.content,
                candidate.content,
                candidate.account_id,
                candidate.inbox_id,
                candidate.conversation_id,
                candidate.message_type,
                FALSE,
                0,
                candidate.sender_type,
                candidate.sender_id,
                candidate.source_id,
                to_timestamp(candidate.message_timestamp),
                to_timestamp(candidate.message_timestamp)
              FROM (VALUES ${sqlValues}) AS candidate(
                content,
                account_id,
                inbox_id,
                conversation_id,
                message_type,
                sender_type,
                sender_id,
                source_id,
                message_timestamp
              )
              WHERE NOT EXISTS (
                SELECT 1
                FROM messages existing
                WHERE existing.inbox_id = candidate.inbox_id
                  AND existing.source_id = candidate.source_id
              )
              ORDER BY candidate.inbox_id, candidate.source_id, candidate.message_timestamp`;

            totalMessagesImported += (await pgClient.query(sqlInsertMsg, bindInsertMsg))?.rowCount ?? 0;
          }
        }
        messagesChunk = this.sliceIntoChunks(messagesOrdered, batchSize);
      }

      this.deleteHistoryMessages(instance);
      this.deleteRepositoryMessagesCache(instance);
      this.deleteHistoryIdentityNames(instance);

      const providerData: ChatwootDto = {
        ...provider,
        ignoreJids: Array.isArray(provider.ignoreJids) ? provider.ignoreJids.map((event) => String(event)) : [],
      };

      this.importHistoryContacts(instance, providerData);

      return totalMessagesImported;
    } catch (error) {
      this.logger.error(`Error on import history messages: ${error.toString()}`);

      this.deleteHistoryMessages(instance);
      this.deleteRepositoryMessagesCache(instance);
      this.deleteHistoryIdentityNames(instance);
    }
  }

  public async selectOrCreateFksFromChatwoot(
    provider: ChatwootModel,
    inbox: inbox,
    identitiesWithTimestamp: Map<string, firstLastTimestamp>,
    messagesByIdentity: Map<string, Message[]>,
    identityNames: Map<string, string>,
  ): Promise<Map<string, FksChatwoot>> {
    const pgClient = postgresClient.getChatwootConnection();

    const bindValues = [provider.accountId, inbox.id];
    const identityBind = Array.from(messagesByIdentity.entries())
      .map(([identityKey, messages]) => {
        const timestamps = identitiesWithTimestamp.get(identityKey);
        if (!timestamps) {
          return null;
        }

        const identity = this.getHistoryIdentity(identityKey, messages, timestamps, identityNames);
        const values = [
          identity.identityKey,
          identity.identifier,
          identity.phoneNumber,
          identity.name,
          identity.first,
          identity.last,
        ];
        const placeholders = values.map((value) => {
          bindValues.push(value);
          return `$${bindValues.length}`;
        });
        return `(${placeholders.join(',')})`;
      })
      .filter(Boolean)
      .join(',');

    if (!identityBind) {
      return new Map<string, FksChatwoot>();
    }

    const sqlFromChatwoot = `WITH
              identity_input AS (
                SELECT
                  identity_key,
                  identifier,
                  phone_number,
                  contact_name,
                  created_at::INTEGER,
                  last_activity_at::INTEGER
                FROM (
                  VALUES ${identityBind}
                ) AS t (
                  identity_key,
                  identifier,
                  phone_number,
                  contact_name,
                  created_at,
                  last_activity_at
                )
              ),

              only_new_identity AS (
                SELECT identity.*
                FROM identity_input identity
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM contacts c
                  JOIN contact_inboxes ci ON ci.contact_id = c.id AND ci.inbox_id = $2
                  JOIN conversations con ON con.contact_inbox_id = ci.id
                    AND con.account_id = $1
                    AND con.inbox_id = $2
                    AND con.contact_id = c.id
                  WHERE c.account_id = $1
                    AND (
                      c.identifier = identity.identifier
                      OR (
                        identity.phone_number IS NOT NULL
                        AND c.phone_number = identity.phone_number
                      )
                    )
                )
              ),

              new_contact AS (
                INSERT INTO contacts (name, phone_number, account_id, identifier, created_at, updated_at)
                SELECT
                  identity.contact_name,
                  identity.phone_number,
                  $1,
                  identity.identifier,
                  to_timestamp(identity.created_at),
                  to_timestamp(identity.last_activity_at)
                FROM only_new_identity identity
                ON CONFLICT(identifier, account_id) DO UPDATE SET
                  name = CASE
                    WHEN contacts.name IS NULL OR contacts.name = '' OR contacts.name = contacts.identifier
                      THEN EXCLUDED.name
                    ELSE contacts.name
                  END,
                  phone_number = COALESCE(contacts.phone_number, EXCLUDED.phone_number),
                  updated_at = GREATEST(contacts.updated_at, EXCLUDED.updated_at)
                RETURNING id, identifier, created_at, updated_at
              ),

              new_contact_inbox AS (
                INSERT INTO contact_inboxes (contact_id, inbox_id, source_id, created_at, updated_at)
                SELECT contact.id, $2, gen_random_uuid(), contact.created_at, contact.updated_at
                FROM new_contact contact
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM contact_inboxes existing
                  WHERE existing.contact_id = contact.id
                    AND existing.inbox_id = $2
                )
                RETURNING id, contact_id, created_at, updated_at
              ),

              available_contact_inbox AS (
                SELECT id, contact_id, created_at, updated_at
                FROM new_contact_inbox

                UNION

                SELECT existing.id, existing.contact_id, existing.created_at, existing.updated_at
                FROM new_contact contact
                JOIN contact_inboxes existing
                  ON existing.contact_id = contact.id
                  AND existing.inbox_id = $2
              ),

              new_conversation AS (
                INSERT INTO conversations (account_id, inbox_id, status, contact_id,
                  contact_inbox_id, uuid, last_activity_at, created_at, updated_at)
                SELECT
                  $1,
                  $2,
                  0,
                  contact_inbox.contact_id,
                  contact_inbox.id,
                  gen_random_uuid(),
                  contact.updated_at,
                  contact.created_at,
                  contact.updated_at
                FROM available_contact_inbox contact_inbox
                JOIN new_contact contact ON contact.id = contact_inbox.contact_id
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM conversations existing
                  WHERE existing.contact_inbox_id = contact_inbox.id
                    AND existing.account_id = $1
                    AND existing.inbox_id = $2
                    AND existing.contact_id = contact_inbox.contact_id
                )
                RETURNING id, contact_id
              )

              SELECT
                identity.identity_key,
                conversation.contact_id,
                conversation.id AS conversation_id
              FROM new_conversation conversation
              JOIN new_contact contact ON conversation.contact_id = contact.id
              JOIN only_new_identity identity ON identity.identifier = contact.identifier

              UNION

              SELECT
                identity.identity_key,
                contact.id AS contact_id,
                conversation.id AS conversation_id
              FROM identity_input identity
              JOIN contacts contact ON contact.account_id = $1
                AND (
                  contact.identifier = identity.identifier
                  OR (
                    identity.phone_number IS NOT NULL
                    AND contact.phone_number = identity.phone_number
                  )
                )
              JOIN contact_inboxes contact_inbox
                ON contact_inbox.contact_id = contact.id
                AND contact_inbox.inbox_id = $2
              JOIN conversations conversation
                ON conversation.contact_inbox_id = contact_inbox.id
                AND conversation.account_id = $1
                AND conversation.inbox_id = $2
                AND conversation.contact_id = contact.id`;

    const fksFromChatwoot = await pgClient.query(sqlFromChatwoot, bindValues);

    return new Map(fksFromChatwoot.rows.map((item: FksChatwoot) => [item.identity_key, item]));
  }

  private getHistoryIdentity(
    identityKey: string,
    messages: Message[],
    timestamps: firstLastTimestamp,
    identityNames: Map<string, string>,
  ): HistoryIdentity {
    const canonicalJid = toCanonicalHistoryJid(identityKey);
    const jidUser = canonicalJid.split('@')[0].split(':')[0];
    const firstPushName = messages.find((message) => Boolean(message.pushName?.trim()))?.pushName?.trim();

    if (isPhoneJid(canonicalJid)) {
      return {
        ...timestamps,
        identityKey: canonicalJid,
        identifier: canonicalJid,
        phoneNumber: `+${jidUser}`,
        name: firstPushName || jidUser,
      };
    }

    if (isGroupJid(canonicalJid)) {
      const groupName = identityNames.get(canonicalJid);
      return {
        ...timestamps,
        identityKey: canonicalJid,
        identifier: canonicalJid,
        phoneNumber: null,
        name: `${groupName || `WhatsApp Group ${jidUser.slice(-6)}`} (GROUP)`,
      };
    }

    return {
      ...timestamps,
      identityKey: canonicalJid,
      identifier: canonicalJid,
      phoneNumber: null,
      name: firstPushName || `WhatsApp LID ${jidUser.slice(-6)}`,
    };
  }

  public async getChatwootUser(provider: ChatwootModel): Promise<ChatwootUser> {
    try {
      const pgClient = postgresClient.getChatwootConnection();

      const sqlUser = `SELECT owner_type AS user_type, owner_id AS user_id
                         FROM access_tokens
                       WHERE token = $1`;

      return (await pgClient.query(sqlUser, [provider.token]))?.rows[0] || false;
    } catch (error) {
      this.logger.error(`Error on getChatwootUser: ${error.toString()}`);
    }
  }

  public createMessagesMapByIdentity(messages: Message[]): Map<string, Message[]> {
    return messages.reduce((acc: Map<string, Message[]>, message: Message) => {
      const key = message?.key as {
        remoteJid: string;
      };
      const remoteJid = key?.remoteJid;
      if (!remoteJid || (!isPhoneJid(remoteJid) && !isGroupJid(remoteJid) && !isLidJid(remoteJid))) {
        return acc;
      }

      const identityKey = toCanonicalHistoryJid(remoteJid);
      const identityMessages = acc.get(identityKey) || [];
      identityMessages.push(message);
      acc.set(identityKey, identityMessages);

      return acc;
    }, new Map());
  }

  private async addUnresolvedLidLabel(provider: ChatwootModel, contactIds: number[]) {
    const uniqueContactIds = Array.from(new Set(contactIds));
    if (uniqueContactIds.length === 0) {
      return;
    }

    const pgClient = postgresClient.getChatwootConnection();
    const labelName = 'unresolved_lid';

    await pgClient.query(
      `INSERT INTO labels (title, color, show_on_sidebar, account_id, created_at, updated_at)
       SELECT $1::TEXT, '#B7791F', TRUE, $2::BIGINT, NOW(), NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM labels WHERE title = $1::TEXT AND account_id = $2::BIGINT
       )`,
      [labelName, provider.accountId],
    );

    const tagId = (
      await pgClient.query(
        `INSERT INTO tags (name, taggings_count)
         VALUES ($1::TEXT, 0)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [labelName],
      )
    ).rows[0]?.id;

    await pgClient.query(
      `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at)
       SELECT $1::INTEGER, 'Contact', contact_id, 'labels', NOW()
       FROM UNNEST($2::INTEGER[]) AS contact_id
       ON CONFLICT DO NOTHING`,
      [tagId, uniqueContactIds],
    );

    await pgClient.query(
      `UPDATE tags
       SET taggings_count = (
         SELECT COUNT(*) FROM taggings
         WHERE taggings.tag_id = tags.id
           AND taggings.context = 'labels'
       )
       WHERE id = $1::INTEGER`,
      [tagId],
    );
  }

  public async getContactsOrderByRecentConversations(
    inbox: inbox,
    provider: ChatwootModel,
    limit = 50,
  ): Promise<{ id: number; phone_number: string; identifier: string }[]> {
    try {
      const pgClient = postgresClient.getChatwootConnection();

      const sql = `SELECT contacts.id, contacts.identifier, contacts.phone_number
                     FROM conversations
                   JOIN contacts ON contacts.id = conversations.contact_id
                   WHERE conversations.account_id = $1
                     AND inbox_id = $2
                   ORDER BY conversations.last_activity_at DESC
                   LIMIT $3`;

      return (await pgClient.query(sql, [provider.accountId, inbox.id, limit]))?.rows;
    } catch (error) {
      this.logger.error(`Error on get recent conversations: ${error.toString()}`);
    }
  }

  public getContentMessage(chatwootService: ChatwootService, msg: IWebMessageInfo) {
    const contentMessage = chatwootService.getConversationMessage(msg.message);
    if (contentMessage) {
      return contentMessage;
    }

    if (!configService.get<Chatwoot>('CHATWOOT').IMPORT.PLACEHOLDER_MEDIA_MESSAGE) {
      return '';
    }

    const types = {
      documentMessage: msg.message.documentMessage,
      documentWithCaptionMessage: msg.message.documentWithCaptionMessage?.message?.documentMessage,
      imageMessage: msg.message.imageMessage,
      videoMessage: msg.message.videoMessage,
      audioMessage: msg.message.audioMessage,
      stickerMessage: msg.message.stickerMessage,
      templateMessage: msg.message.templateMessage?.hydratedTemplate?.hydratedContentText,
    };

    const typeKey = Object.keys(types).find((key) => types[key] !== undefined && types[key] !== null);
    switch (typeKey) {
      case 'documentMessage': {
        const doc = msg.message.documentMessage;
        const fileName = doc?.fileName || 'document';
        const caption = doc?.caption ? ` ${doc.caption}` : '';
        return `_<File: ${fileName}${caption}>_`;
      }

      case 'documentWithCaptionMessage': {
        const doc = msg.message.documentWithCaptionMessage?.message?.documentMessage;
        const fileName = doc?.fileName || 'document';
        const caption = doc?.caption ? ` ${doc.caption}` : '';
        return `_<File: ${fileName}${caption}>_`;
      }

      case 'templateMessage': {
        const template = msg.message.templateMessage?.hydratedTemplate;
        return (
          (template?.hydratedTitleText ? `*${template.hydratedTitleText}*\n` : '') +
          (template?.hydratedContentText || '')
        );
      }

      case 'imageMessage':
        return '_<Image Message>_';

      case 'videoMessage':
        return '_<Video Message>_';

      case 'audioMessage':
        return '_<Audio Message>_';

      case 'stickerMessage':
        return '_<Sticker Message>_';

      default:
        return '';
    }
  }

  public getHistoryContentMessage(chatwootService: ChatwootService, msg: IWebMessageInfo) {
    const content = this.getContentMessage(chatwootService, msg);
    const key = msg.key as {
      remoteJid?: string;
      participant?: string;
      participantAlt?: string;
      fromMe?: boolean;
    };

    if (!content || !isGroupJid(key?.remoteJid) || key.fromMe) {
      return content;
    }

    const participantJid = isPhoneJid(key?.participantAlt)
      ? key.participantAlt
      : isPhoneJid(key?.participant)
        ? key.participant
        : null;
    const participantPhone = participantJid ? `+${participantJid.split('@')[0].split(':')[0]}` : null;
    const participantName = msg.pushName?.trim() || 'Group participant';
    const participantLabel = participantPhone ? `${participantPhone} - ${participantName}` : participantName;

    return `**${participantLabel}:**\n\n${content}`;
  }

  public sliceIntoChunks(arr: any[], chunkSize: number) {
    return arr.splice(0, chunkSize);
  }

  public isGroup(remoteJid: string) {
    return remoteJid.includes('@g.us');
  }

  public isIgnorePhoneNumber(remoteJid: string) {
    return this.isGroup(remoteJid) || remoteJid === 'status@broadcast' || remoteJid === '0@s.whatsapp.net';
  }

  public updateMessageSourceID(messageId: string | number, sourceId: string) {
    const pgClient = postgresClient.getChatwootConnection();

    const sql = `UPDATE messages SET source_id = $1, status = 0, created_at = NOW(), updated_at = NOW() WHERE id = $2;`;

    return pgClient.query(sql, [`WAID:${sourceId}`, messageId]);
  }
}

export const chatwootImport = new ChatwootImport();
