import type { Pool, PoolClient } from 'pg';

// Operation-owned transactions use LOCAL settings only, including through a
// transaction pooler. Cleanup settles before the native source guard unlocks.
export const createHistoryDatabaseScope = (pool: Pool, signal: AbortSignal) => {
  const leases = new Map<any, () => Promise<void>>();
  const cleanup = new Set<Promise<void>>();
  let closed = false;
  const sqlText = (value: any) => (typeof value === 'string' ? value : value?.text || '');
  const rollback = (sql: string) => /^\s*ROLLBACK\s*;?\s*$/i.test(sql);
  const admit = () => {
    if (closed) throw new Error('History database scope is closed');
    signal.throwIfAborted();
  };
  const lease = async () => {
    admit();
    const client = await pool.connect();
    let transaction = false;
    let connectionError: Error | undefined;
    const failed = (error: Error) => {
      connectionError = error;
    };
    client.on('error', failed);
    let released: Promise<void> | undefined;
    const release = () => {
      if (!released) {
        released = (async () => {
          try {
            if (transaction) await client.query('ROLLBACK');
            client.release();
          } catch (error) {
            client.release(true);
            throw error;
          } finally {
            client.removeListener('error', failed);
            leases.delete(client);
          }
        })();
        cleanup.add(released);
        void released.catch(() => undefined);
      }
      return released;
    };
    leases.set(client, release);
    try {
      admit();
    } catch (error) {
      await release();
      throw error;
    }
    return {
      query: async (...args: any[]) => {
        const sql = sqlText(args[0]);
        if (connectionError) throw connectionError;
        // Rollback remains admitted after cancellation/close; commit never does.
        if (rollback(sql)) {
          const result = await (client.query as any)(...args);
          transaction = false;
          return result;
        }
        admit();
        if (/^\s*BEGIN\b/i.test(sql)) {
          if (transaction) throw new Error('History transaction already started');
          const result = await (client.query as any)(...args);
          transaction = true;
          await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s'");
          admit();
          return result;
        }
        if (!transaction) throw new Error('History query requires an owned transaction');
        const result = await (client.query as any)(...args);
        if (/^\s*COMMIT\s*;?\s*$/i.test(sql)) transaction = false;
        return result;
      },
      release: () => {
        void release();
      },
      _release: release,
    };
  };
  const database = {
    query: async (...args: any[]) => {
      const client = await lease();
      try {
        await client.query('BEGIN');
        const result = await client.query(...args);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        await client._release();
      }
    },
    connect: async () => lease() as unknown as Promise<PoolClient>,
  } as unknown as Pool;
  return {
    database,
    close: async () => {
      closed = true;
      for (const release of [...leases.values()]) void release();
      await Promise.all([...cleanup]);
    },
  };
};
