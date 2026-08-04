import assert from 'node:assert/strict';
import test from 'node:test';

import { setChatwootSearchPath } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';

test('initializes each Chatwoot PostgreSQL session with the public schema', async () => {
  const queries: string[] = [];

  await setChatwootSearchPath({
    query: async (query: string) => {
      queries.push(query);
    },
  });

  assert.deepEqual(queries, ['SET search_path TO public']);
});
