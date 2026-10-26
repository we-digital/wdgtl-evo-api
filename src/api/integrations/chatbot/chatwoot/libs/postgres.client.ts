import { Chatwoot, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import postgresql from 'pg';

const { Pool } = postgresql;

type QueryableClient = {
  query: (query: string) => Promise<unknown>;
};

export const setChatwootSearchPath = async (client: QueryableClient) => {
  await client.query('SET search_path TO public');
};

class Postgres {
  private logger = new Logger('Postgres');
  private pool;

  getConnection(connectionString: string) {
    if (this.pool) {
      return this.pool;
    } else {
      this.pool = new Pool({
        connectionString,
        ssl: {
          rejectUnauthorized: false,
        },
      });

      this.pool.on('connect', (client) => {
        setChatwootSearchPath(client).catch((error) => {
          this.logger.error(`failed to initialize Chatwoot postgres search_path: ${error.toString()}`);
        });
      });

      this.pool.on('error', () => {
        this.logger.error('postgres disconnected');
      });

      // pg-pool removes failed idle clients itself. Keep the long-lived pool:
      // replacing it here splits callers across pools and their connection budgets.

      return this.pool;
    }
  }

  getChatwootConnection() {
    const uri = configService.get<Chatwoot>('CHATWOOT').IMPORT.DATABASE.CONNECTION.URI;

    return this.getConnection(uri);
  }
}

export const postgresClient = new Postgres();
