import assert from 'node:assert/strict';
import test from 'node:test';

import { chatwootImport } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';

const message = {
  key: { id: 'synthetic-source', remoteJid: '123456789@s.whatsapp.net', fromMe: false },
  messageTimestamp: 100,
};

test('actual recovery importer propagates only bounded SQL identity fields without SQL or customer content', async () => {
  const originalUser = chatwootImport.getChatwootUser;
  const originalSources = chatwootImport.getExistingSourceIds;
  const logger = (chatwootImport as any).logger;
  const originalError = logger.error;
  try {
    logger.error = () => {};
    chatwootImport.getChatwootUser = async () => ({ user_id: 1, user_type: 'User' });
    chatwootImport.getExistingSourceIds = async () => {
      throw Object.assign(new Error('private customer text and SQL'), {
        code: '55P03',
        constraint: 'messages_source_guard',
        routine: 'LockAcquireExtended',
        query: 'private SELECT',
        detail: 'private customer data',
      });
    };
    await assert.rejects(
      chatwootImport.importHistoryMessages(
        { instanceName: 'synthetic' } as any,
        {} as any,
        { id: 39 } as any,
        {} as any,
        { messages: [message] as any },
      ),
      (error: Error) => {
        assert.equal(
          error.message,
          'Chatwoot recovery import refused phase=source_lookup code=55P03 constraint=messages_source_guard routine=LockAcquireExtended',
        );
        assert.equal(error.message.includes('private'), false);
        return true;
      },
    );
    chatwootImport.getExistingSourceIds = async () => {
      throw Object.assign(new Error('private'), {
        code: 'BAD code',
        constraint: 'customer phone',
        routine: 'x'.repeat(129),
      });
    };
    await assert.rejects(
      chatwootImport.importHistoryMessages(
        { instanceName: 'synthetic' } as any,
        {} as any,
        { id: 39 } as any,
        {} as any,
        { messages: [message] as any },
      ),
      { message: 'Chatwoot recovery import refused phase=source_lookup' },
    );
  } finally {
    chatwootImport.getChatwootUser = originalUser;
    chatwootImport.getExistingSourceIds = originalSources;
    logger.error = originalError;
  }
});
