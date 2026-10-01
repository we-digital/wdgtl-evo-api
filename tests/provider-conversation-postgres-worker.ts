// Invoked by Chatwoot's synthetic concurrency spec, never by a production job.
import readline from 'node:readline';

import { Pool } from 'pg';

import { resolveProviderHistoryConversations } from '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-provider-conversation';

async function main() {
  if (process.env.PGDATABASE !== 'chatwoot_test' || !['127.0.0.1', 'localhost', 'postgres'].includes(process.env.PGHOST)) {
    throw new Error('Synthetic database required');
  }
  const input = readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const setup = JSON.parse((await input.next()).value);
  const pool = new Pool({ max: 3, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
  try {
    const account = await pool.query('SELECT name FROM accounts WHERE id = $1', [setup.accountId]);
    if (!account.rows[0]?.name?.startsWith('Provider conversation synthetic ')) throw new Error('Synthetic account required');
    process.stdout.write('ready\n');
    await input.next();
    const identity = { identityKey: setup.peer, identifier: setup.peer, phoneNumber: null,
      name: 'Synthetic group', first: 1_700_000_000, last: 1_700_000_000 };
    const results = await Promise.all([0, 1].map(() => resolveProviderHistoryConversations(pool, setup.accountId, setup.inboxId, [identity])));
    process.stdout.write(JSON.stringify(results.map((result) => result?.get(setup.peer))) + '\n');
  } finally {
    await pool.end();
    process.stdin.destroy();
  }
}

main().catch(() => {
  process.stderr.write('synthetic_provider_concurrency_failed\n');
  process.exitCode = 1;
  process.stdin.destroy();
});
