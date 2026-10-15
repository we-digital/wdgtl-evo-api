import type { Pool, PoolClient } from 'pg';

// No shared-pool mutation: each operation owns its leases, restores exact
// session settings and awaits every cleanup before the source guard unlocks.
export const createHistoryDatabaseScope = (pool: Pool, signal: AbortSignal) => {
  const leases = new Map<any, () => Promise<void>>();
  const cleanup = new Set<Promise<void>>();
  let closed = false;
  const admit = (sql?: any) => {
    if (typeof sql === 'string' && /^\s*ROLLBACK\s*;?\s*$/i.test(sql)) return;
    if (closed) throw new Error('History database scope is closed');
    signal.throwIfAborted();
  };
  const lease = async () => {
    admit();
    const client = await pool.connect();
    let settings: any;
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
            // Even after cancellation, rollback/restore remain admitted.
            await client.query('ROLLBACK');
            if (settings)
              await client.query(
                "SELECT set_config('statement_timeout',$1,false),set_config('idle_in_transaction_session_timeout',$2,false)",
                [settings.statement, settings.idle],
              );
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
        // Attach immediately so ignored synchronous release() cannot create an
        // unhandled rejection; close() still awaits and propagates its outcome.
        void released.catch(() => undefined);
      }
      return released;
    };
    leases.set(client, release);
    try {
      settings = (
        await client.query(
          "SELECT current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle",
        )
      ).rows[0];
      await client.query("SET statement_timeout='5s'; SET idle_in_transaction_session_timeout='10s'");
      admit();
    } catch (error) {
      await release();
      throw error;
    }
    return {
      query: async (...args: any[]) => {
        if (connectionError) throw connectionError;
        admit(args[0]);
        return (client.query as any)(...args);
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
        return await client.query(...args);
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
