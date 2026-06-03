import Fastify from 'fastify';
import * as crypto from 'crypto';
import { getPrismaClient } from './db/validator';
import { getConnectionById, getBackendServers, getConnectionIdByShareToken, testPrismDatabaseConnection } from './db/prism';
import { validateAndSave } from './core';
import { runTests } from './tester';
import { startPoller, getPollerStatus } from './poller';
import {
  getPollingSettings,
  getPrismDatabaseSettings,
  savePollingSettings,
  saveVerifiedPrismDatabaseUrl,
  getBaseUrl,
  saveBaseUrl,
} from './settings';
import {
  createRuleField,
  deleteRuleField,
  initRules,
  listRuleDefinitions,
  reloadRulesFromDb,
  updateFlowIdentifier,
  updateRuleField,
} from './rules-db';
import type { FastifyRequest, FastifyReply } from 'fastify';

const app = Fastify({ logger: { level: 'info' } });

app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const str = (body as string).trim();
  if (!str) { done(null, {}); return; }
  try { done(null, JSON.parse(str)); } catch (err) { done(err as Error, undefined); }
});

const sessions = new Map<string, number>(); // token → createdAt ms
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin123';
const API_PORT = Number(process.env.API_PORT ?? 3000);

function createSession(): string {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  return token;
}

function checkSession(token: string): boolean {
  const ts = sessions.get(token);
  if (!ts) return false;
  if (Date.now() - ts > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ') || !checkSession(auth.slice(7))) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/auth/login', async (req, reply) => {
  const { username, password } = req.body as { username: string; password: string };
  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }
  return { token: createSession() };
});

app.post('/auth/logout', { preHandler: requireAuth }, async (req) => {
  sessions.delete(req.headers.authorization!.slice(7));
  return { ok: true };
});

// ── System ────────────────────────────────────────────────────────────────────

app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/polling/status', { preHandler: requireAuth }, async () => getPollerStatus());

app.post('/reload-rules', { preHandler: requireAuth }, async () => {
  await reloadRulesFromDb();
  return { ok: true, message: 'Rules reloaded from database' };
});

// ── Settings ─────────────────────────────────────────────────────────────────

app.get('/settings/prism-db', { preHandler: requireAuth }, async () => {
  const settings = await getPrismDatabaseSettings();
  return {
    url: settings.url ?? '',
    verifiedAt: settings.verifiedAt,
    isVerified: settings.isVerified,
  };
});

app.post('/settings/prism-db/test', { preHandler: requireAuth }, async (req, reply) => {
  const { url } = req.body as { url?: string };
  const trimmedUrl = url?.trim();
  if (!trimmedUrl) return reply.code(400).send({ error: 'Prism database URL required' });

  try {
    await testPrismDatabaseConnection(trimmedUrl);
    const settings = await saveVerifiedPrismDatabaseUrl(trimmedUrl);
    return {
      ok: true,
      url: settings.url,
      verifiedAt: settings.verifiedAt,
      isVerified: settings.isVerified,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    return reply.code(400).send({ error: message });
  }
});

app.get('/settings/base-url', { preHandler: requireAuth }, async () => ({ baseUrl: await getBaseUrl() }));

app.put('/settings/base-url', { preHandler: requireAuth }, async (req, reply) => {
  const { baseUrl } = req.body as { baseUrl?: string };
  try {
    const saved = await saveBaseUrl(baseUrl ?? '');
    return { ok: true, baseUrl: saved };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to save base URL';
    return reply.code(400).send({ error: message });
  }
});

app.get('/settings/polling', { preHandler: requireAuth }, async () => getPollingSettings());

app.put('/settings/polling', { preHandler: requireAuth }, async (req, reply) => {
  const body = req.body as {
    enabled?: boolean;
    intervalSeconds?: number;
    batchSize?: number;
  };

  try {
    const settings = await savePollingSettings({
      enabled: Boolean(body.enabled),
      intervalSeconds: Number(body.intervalSeconds),
      batchSize: Number(body.batchSize),
    });
    await startPoller();
    return { ok: true, settings };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to save polling settings';
    return reply.code(400).send({ error: message });
  }
});

// ── Rules ────────────────────────────────────────────────────────────────────

app.get('/rules', { preHandler: requireAuth }, async () => listRuleDefinitions());

app.put('/rules/flows/:flowStep', { preHandler: requireAuth }, async (req, reply) => {
  const { flowStep } = req.params as { flowStep: string };
  try {
    const flow = await updateFlowIdentifier(flowStep, req.body as {
      description: string;
      method: string;
      urlContains: string;
      bodyGrantType?: string | null;
    });
    return { ok: true, flow };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to update flow identifier';
    return reply.code(400).send({ error: message });
  }
});

app.post('/rules/fields', { preHandler: requireAuth }, async (req, reply) => {
  try {
    const field = await createRuleField(req.body as {
      flowStep: string;
      fieldName: string;
      fieldLocation: string;
      fieldType: string;
      pattern?: string | null;
      sortOrder?: number;
    });
    return { ok: true, field };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to create rule field';
    return reply.code(400).send({ error: message });
  }
});

app.put('/rules/fields/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    const field = await updateRuleField(id, req.body as {
      flowStep: string;
      fieldName: string;
      fieldLocation: string;
      fieldType: string;
      pattern?: string | null;
      sortOrder?: number;
    });
    return { ok: true, field };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to update rule field';
    return reply.code(400).send({ error: message });
  }
});

app.delete('/rules/fields/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    await deleteRuleField(id);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to delete rule field';
    return reply.code(400).send({ error: message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/stats', { preHandler: requireAuth }, async () => {
  const prisma = getPrismaClient();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [total, pass, fail] = await Promise.all([
    prisma.validationResult.count({ where: { validatedAt: { gte: todayStart } } }),
    prisma.validationResult.count({ where: { validatedAt: { gte: todayStart }, status: 'PASS' } }),
    prisma.validationResult.count({ where: { validatedAt: { gte: todayStart }, status: 'FAIL' } }),
  ]);

  return { total, pass, fail };
});

// ── Validate ──────────────────────────────────────────────────────────────────

app.post('/validate', { preHandler: requireAuth }, async (req, reply) => {
  const { connectionId } = req.body as { connectionId: string };
  if (!connectionId) return reply.code(400).send({ error: 'connectionId required' });

  const conn = await getConnectionById(connectionId);
  if (!conn) return reply.code(404).send({ error: 'Connection not found' });

  const output = await validateAndSave(conn);
  return {
    connectionId: output.connectionId,
    flowStep: output.flowStep,
    results: output.results.map(r => ({
      field: r.field,
      location: r.location,
      required: r.required,
      status: r.status,
      ...(r.detail ? { detail: r.detail } : {}),
    })),
  };
});

// ── Prism servers (for filter dropdown) ──────────────────────────────────────

app.get('/prism/servers', { preHandler: requireAuth }, async (_req, reply) => {
  try {
    return await getBackendServers();
  } catch {
    return reply.code(503).send({ error: 'Prism database unavailable' });
  }
});

// ── Results ───────────────────────────────────────────────────────────────────

app.get('/results', { preHandler: requireAuth }, async (req) => {
  const {
    shareToken,
    connectionId,
    serverId,
    flowStep,
    status,
    from,
    to,
    limit = '100',
    offset = '0',
  } = req.query as Record<string, string>;

  const prisma = getPrismaClient();

  if (shareToken) {
    const resolvedId = await getConnectionIdByShareToken(shareToken).catch(() => null);
    if (!resolvedId) return [];
    return prisma.validationResult.findMany({
      where: { connectionId: resolvedId },
      orderBy: { validatedAt: 'desc' },
      take: Math.min(Number(limit), 1000),
      skip: Number(offset),
    });
  }

  return prisma.validationResult.findMany({
    where: {
      ...(connectionId ? { connectionId: { contains: connectionId } } : {}),
      ...(serverId ? { serverId } : {}),
      ...(flowStep ? { flowStep } : {}),
      ...(status ? { status } : {}),
      ...((from ?? to) ? {
        validatedAt: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        },
      } : {}),
    },
    orderBy: { validatedAt: 'desc' },
    take: Math.min(Number(limit), 1000),
    skip: Number(offset),
  });
});

app.get('/results/:connectionId', { preHandler: requireAuth }, async (req) => {
  const { connectionId } = req.params as { connectionId: string };
  const prisma = getPrismaClient();
  return prisma.validationResult.findMany({
    where: { connectionId },
    orderBy: { validatedAt: 'desc' },
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

app.post('/test/run', { preHandler: requireAuth }, async () => runTests());

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.$connect();
  await initRules();

  await startPoller();

  await app.listen({ port: API_PORT, host: '0.0.0.0' });
  console.log(`[api] listening on port ${API_PORT}`);
}

main().catch(err => {
  console.error('[api] fatal:', err);
  process.exit(1);
});
