import { Pool } from 'pg';
import { getVerifiedPrismDatabaseUrl } from '../settings';
import type { PrismConnection } from '../types';

let pool: Pool | null = null;
let poolUrl: string | null = null;

async function getPool(): Promise<Pool> {
  const url = await getVerifiedPrismDatabaseUrl();
  if (!pool || poolUrl !== url) {
    if (pool) await pool.end();
    pool = new Pool({ connectionString: url, ssl: false });
    poolUrl = url;
  }
  return pool;
}

export async function testPrismDatabaseConnection(url: string): Promise<void> {
  const poolToTest = new Pool({ connectionString: url.trim(), ssl: false });
  try {
    await poolToTest.query('SELECT 1');
  } finally {
    await poolToTest.end();
  }
}

export async function getRecentConnections(limit: number): Promise<PrismConnection[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const db = await getPool();
  const { rows } = await db.query<PrismConnection>(
    `SELECT
       id::text        AS id,
       institution_id,
       user_id,
       req_method,
       req_url,
       req_headers,
       req_body,
       res_body
     FROM connections
     WHERE created_at >= $1
       AND is_system_heartbeat = false
       AND is_path_ignored = false
     ORDER BY created_at ASC
     LIMIT $2`,
    [since, limit],
  );
  return rows;
}

export async function getConnectionById(id: string): Promise<PrismConnection | null> {
  const db = await getPool();
  const { rows } = await db.query<PrismConnection>(
    `SELECT
       id::text        AS id,
       institution_id,
       user_id,
       req_method,
       req_url,
       req_headers,
       req_body,
       res_body
     FROM connections
     WHERE id::text = $1`,
    [id],
  );
  return rows[0] ?? null;
}
