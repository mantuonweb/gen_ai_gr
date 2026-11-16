import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool = new Pool({
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    database: process.env.DATABASE_NAME ?? 'ingest',
    user: process.env.DATABASE_USER ?? 'ingest',
    password: process.env.DATABASE_PASSWORD ?? 'local_dev_password',
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });

  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}