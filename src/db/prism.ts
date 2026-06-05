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

export async function getRecentConnections(limit: number, sinceHours = 24): Promise<PrismConnection[]> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const db = await getPool();
  const { rows } = await db.query<PrismConnection>(
    `SELECT
       id::text        AS id,
       user_id,
       server_id::text AS server_id,
       share_token,
       req_method,
       req_url,
       req_headers,
       req_body,
       res_body
     FROM connections
     WHERE created_at >= $1
       AND is_system_heartbeat = false
       -- Prism flags discovery docs (e.g. /.well-known/smart-configuration) as
       -- path-ignored; keep them so SMART metadata still gets validated.
       AND (is_path_ignored = false OR req_url LIKE '%/.well-known/%')
     ORDER BY created_at DESC
     LIMIT $2`,
    [since, limit],
  );
  return rows;
}

// Batched fetch of every qualifying connection in the last `hours` window.
// A single query (response body included) keeps external-DB load minimal — used
// by the "purge & re-ingest" action so it does not hit Prism once per row.
export async function getConnectionsSince(hours: number, maxRows = 10000): Promise<PrismConnection[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const db = await getPool();
  const { rows } = await db.query<PrismConnection>(
    `SELECT
       id::text        AS id,
       user_id,
       server_id::text AS server_id,
       share_token,
       req_method,
       req_url,
       req_headers,
       req_body,
       res_body
     FROM connections
     WHERE created_at >= $1
       AND is_system_heartbeat = false
       AND (is_path_ignored = false OR req_url LIKE '%/.well-known/%')
     ORDER BY created_at ASC
     LIMIT $2`,
    [since, maxRows],
  );
  return rows;
}

export async function getConnectionById(id: string): Promise<PrismConnection | null> {
  const db = await getPool();
  const { rows } = await db.query<PrismConnection>(
    `SELECT
       id::text        AS id,
       user_id,
       server_id::text AS server_id,
       share_token,
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

export async function getConnectionIdByShareToken(shareToken: string): Promise<string | null> {
  const db = await getPool();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM connections WHERE share_token = $1 LIMIT 1`,
    [shareToken],
  );
  return rows[0]?.id ?? null;
}

export async function getBackendServers(): Promise<{ id: string; name: string }[]> {
  const db = await getPool();
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM backend_servers ORDER BY name`,
  );
  return rows;
}

let serverNameCache: Map<string, string> | null = null;
let serverNameCacheAt = 0;

export async function getServerName(serverId: string): Promise<string | null> {
  if (!serverNameCache || Date.now() - serverNameCacheAt > 60_000) {
    const servers = await getBackendServers();
    serverNameCache = new Map(servers.map(s => [s.id, s.name]));
    serverNameCacheAt = Date.now();
  }
  return serverNameCache.get(serverId) ?? null;
}
