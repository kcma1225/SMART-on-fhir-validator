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

export type PipelineConnectionRole = 'token_issue' | 'resource' | 'validation';

export interface PipelineConnectionEntry {
  role: PipelineConnectionRole;
  conn: PrismConnection;
}

export interface PipelineBundle {
  id: string;
  shareToken: string | null;
  accessTokenPreview: string | null;
  participantUserId: number | null;
  authenticationServerId: string | null;
  issuedAt: string | null;
  complete: boolean;
  legal: boolean;
  success: boolean;
  resourceCallCount: number;
  createdAt: string;
  entries: PipelineConnectionEntry[];
}

interface PipelineRow {
  id: string;
  share_token: string | null;
  access_token_preview: string | null;
  token_issue_connection_id: string | null;
  participant_user_id: number | null;
  authentication_server_id: string | null;
  issued_at: Date | null;
  complete: boolean;
  legal: boolean;
  success: boolean;
  resource_call_count: number;
  created_at: Date;
}

const PIPELINE_COLUMNS = `
  id::text                        AS id,
  share_token,
  access_token_preview,
  token_issue_connection_id::text AS token_issue_connection_id,
  participant_user_id,
  authentication_server_id::text  AS authentication_server_id,
  issued_at,
  complete,
  legal,
  success,
  resource_call_count,
  created_at`;

// Given a single oauth_pipelines row, gather every connection that makes up that
// OAuth flow (ITI-71 token issue, each ITI-72 resource call + optional token
// validation) ordered as it happened, in one batched query to keep Prism load low.
async function buildPipelineBundle(db: Pool, pipeline: PipelineRow): Promise<PipelineBundle> {
  const { rows: callRows } = await db.query<{
    resource_connection_id: string | null;
    validation_connection_id: string | null;
  }>(
    `SELECT
       resource_connection_id::text   AS resource_connection_id,
       validation_connection_id::text AS validation_connection_id
     FROM oauth_pipeline_resource_calls
     WHERE pipeline_id = $1
     ORDER BY created_at ASC`,
    [pipeline.id],
  );

  // Ordered (id, role) plan: token issue first, then each resource call followed
  // by its validation call.
  const plan: { id: string; role: PipelineConnectionRole }[] = [];
  if (pipeline.token_issue_connection_id) {
    plan.push({ id: pipeline.token_issue_connection_id, role: 'token_issue' });
  }
  for (const call of callRows) {
    if (call.resource_connection_id) plan.push({ id: call.resource_connection_id, role: 'resource' });
    if (call.validation_connection_id) plan.push({ id: call.validation_connection_id, role: 'validation' });
  }

  const ids = plan.map(p => p.id);
  const connById = new Map<string, PrismConnection>();
  if (ids.length > 0) {
    const { rows: conns } = await db.query<PrismConnection>(
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
       WHERE id::text = ANY($1)`,
      [ids],
    );
    for (const c of conns) connById.set(c.id, c);
  }

  const entries: PipelineConnectionEntry[] = [];
  for (const p of plan) {
    const conn = connById.get(p.id);
    if (conn) entries.push({ role: p.role, conn });
  }

  return {
    id: pipeline.id,
    shareToken: pipeline.share_token,
    accessTokenPreview: pipeline.access_token_preview,
    participantUserId: pipeline.participant_user_id,
    authenticationServerId: pipeline.authentication_server_id,
    issuedAt: pipeline.issued_at ? pipeline.issued_at.toISOString() : null,
    complete: pipeline.complete,
    legal: pipeline.legal,
    success: pipeline.success,
    resourceCallCount: pipeline.resource_call_count,
    createdAt: pipeline.created_at.toISOString(),
    entries,
  };
}

export async function getPipelineBundleByShareToken(shareToken: string): Promise<PipelineBundle | null> {
  const db = await getPool();
  const { rows } = await db.query<PipelineRow>(
    `SELECT ${PIPELINE_COLUMNS} FROM oauth_pipelines WHERE share_token = $1 LIMIT 1`,
    [shareToken],
  );
  return rows[0] ? buildPipelineBundle(db, rows[0]) : null;
}

export async function getPipelineBundleById(id: string): Promise<PipelineBundle | null> {
  const db = await getPool();
  const { rows } = await db.query<PipelineRow>(
    `SELECT ${PIPELINE_COLUMNS} FROM oauth_pipelines WHERE id::text = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? buildPipelineBundle(db, rows[0]) : null;
}

export interface PipelineSummary {
  id: string;
  shareToken: string | null;
  participantUserId: number | null;
  authenticationServerId: string | null;
  authenticationServerName: string | null;
  resourceCallCount: number;
  complete: boolean;
  legal: boolean;
  success: boolean;
  issuedAt: string | null;
  createdAt: string;
}

// List all OAuth pipelines (newest first) for the pipeline table. A LEFT JOIN
// resolves the auth server name in the same query to avoid N extra lookups.
export async function getPipelines(limit: number, offset: number): Promise<PipelineSummary[]> {
  const db = await getPool();
  const { rows } = await db.query<{
    id: string;
    share_token: string | null;
    participant_user_id: number | null;
    authentication_server_id: string | null;
    authentication_server_name: string | null;
    resource_call_count: number;
    complete: boolean;
    legal: boolean;
    success: boolean;
    issued_at: Date | null;
    created_at: Date;
  }>(
    `SELECT
       p.id::text                       AS id,
       p.share_token,
       p.participant_user_id,
       p.authentication_server_id::text AS authentication_server_id,
       s.name                           AS authentication_server_name,
       p.resource_call_count,
       p.complete,
       p.legal,
       p.success,
       p.issued_at,
       p.created_at
     FROM oauth_pipelines p
     LEFT JOIN backend_servers s ON s.id = p.authentication_server_id
     ORDER BY p.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(r => ({
    id: r.id,
    shareToken: r.share_token,
    participantUserId: r.participant_user_id,
    authenticationServerId: r.authentication_server_id,
    authenticationServerName: r.authentication_server_name,
    resourceCallCount: r.resource_call_count,
    complete: r.complete,
    legal: r.legal,
    success: r.success,
    issuedAt: r.issued_at ? r.issued_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  }));
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
