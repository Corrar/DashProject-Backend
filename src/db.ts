import { Pool } from 'pg';
import { env } from './env';
import { log } from './lib';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.pgSsl ? { rejectUnauthorized: true } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Erro em cliente ocioso não deve derrubar o processo.
pool.on('error', (err) => { log('error', 'pg_pool_error', { err: String(err) }); });
