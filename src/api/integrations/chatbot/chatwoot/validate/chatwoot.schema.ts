import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

const isNotEmpty = (...propertyNames: string[]): JSONSchema7 => {
  const properties = {};
  propertyNames.forEach(
    (property) =>
      (properties[property] = {
        minLength: 1,
        description: `The "${property}" cannot be empty`,
      }),
  );
  return {
    if: {
      propertyNames: {
        enum: [...propertyNames],
      },
    },
    then: { properties },
  };
};

export const chatwootSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    enabled: { type: 'boolean', enum: [true, false] },
    accountId: { type: 'string' },
    token: { type: 'string' },
    url: { type: 'string' },
    signMsg: { type: 'boolean', enum: [true, false] },
    signDelimiter: { type: ['string', 'null'] },
    nameInbox: { type: ['string', 'null'] },
    reopenConversation: { type: 'boolean', enum: [true, false] },
    conversationPending: { type: 'boolean', enum: [true, false] },
    autoCreate: { type: 'boolean', enum: [true, false] },
    importContacts: { type: 'boolean', enum: [true, false] },
    mergeBrazilContacts: { type: 'boolean', enum: [true, false] },
    importMessages: { type: 'boolean', enum: [true, false] },
    daysLimitImportMessages: { type: 'number' },
    ignoreJids: { type: 'array', items: { type: 'string' } },
  },
  required: ['enabled', 'accountId', 'token', 'url', 'signMsg', 'reopenConversation', 'conversationPending'],
  ...isNotEmpty('enabled', 'accountId', 'token', 'url', 'signMsg', 'reopenConversation', 'conversationPending'),
};

export const chatwootHistorySyncSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  additionalProperties: false,
  properties: {
    dryRun: { type: 'boolean' },
    since: { type: 'string', format: 'date-time' },
    remoteJid: {
      type: 'string',
      pattern: '^[0-9:-]+@(s\\.whatsapp\\.net|hosted|lid|hosted\\.lid|g\\.us)$',
    },
    limit: { type: 'integer', minimum: 1, maximum: 4000 },
    scope: { type: 'string', enum: ['direct', 'groups', 'all'] },
    unresolvedLidMode: { type: 'string', enum: ['skip', 'provisional'] },
    refreshLidMappings: { type: 'boolean' },
  },
};

export const chatwootHistorySyncBatchSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  additionalProperties: false,
  properties: {
    contractVersion: { type: 'string', enum: ['2026-08-01'] },
    dryRun: { type: 'boolean', enum: [false] },
    scope: { type: 'string', enum: ['direct', 'groups', 'all'] },
    unresolvedLidMode: { type: 'string', enum: ['skip', 'provisional'] },
    refreshLidMappings: { type: 'boolean' },
    messages: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceId: { type: 'string', pattern: '^WAID:[^\\s]+$', maxLength: 255 },
          message: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 255 },
              key: {
                type: 'object',
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: 255 },
                },
                required: ['id'],
              },
            },
            required: ['id', 'key'],
          },
        },
        required: ['sourceId', 'message'],
      },
    },
  },
  required: ['contractVersion', 'dryRun', 'scope', 'unresolvedLidMode', 'refreshLidMappings', 'messages'],
};

export const chatwootHistoryRecoveryBatchSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  additionalProperties: false,
  properties: {
    contractVersion: { type: 'string', enum: ['2026-08-28'] },
    dryRun: { type: 'boolean', enum: [false] },
    scope: { type: 'string', enum: ['direct', 'groups', 'all'] },
    unresolvedLidMode: { type: 'string', enum: ['skip', 'provisional'] },
    refreshLidMappings: { type: 'boolean' },
    recoveryMode: { type: 'string', enum: ['standard', 'maximize'] },
    messages: chatwootHistorySyncBatchSchema.properties.messages,
  },
  required: [
    'contractVersion',
    'dryRun',
    'scope',
    'unresolvedLidMode',
    'refreshLidMappings',
    'recoveryMode',
    'messages',
  ],
};
