import { getRecentConnections } from './db/prism';
import { getPrismaClient } from './db/validator';
import { validateAndSave } from './core';
import { getPollingSettings, getPrismDatabaseSettings } from './settings';

interface PollerStatus {
  running: boolean;
  lastRun: string | null;
  nextRun: string | null;
  processedInLastRun: number;
  lastSkipReason: string | null;
}

interface PollerStatusResponse extends PollerStatus {
  prismDatabaseReady: boolean;
  pollingEnabled: boolean;
  pollingIntervalSeconds: number;
  pollingBatchSize: number;
}

const status: PollerStatus = {
  running: false,
  lastRun: null,
  nextRun: null,
  processedInLastRun: 0,
  lastSkipReason: null,
};

let intervalId: ReturnType<typeof setInterval> | null = null;

export async function getPollerStatus(): Promise<PollerStatusResponse> {
  const [databaseSettings, pollingSettings] = await Promise.all([
    getPrismDatabaseSettings(),
    getPollingSettings(),
  ]);
  return {
    ...status,
    prismDatabaseReady: databaseSettings.isVerified,
    pollingEnabled: pollingSettings.enabled,
    pollingIntervalSeconds: pollingSettings.intervalSeconds,
    pollingBatchSize: pollingSettings.batchSize,
  };
}

export async function runOnce(): Promise<void> {
  if (status.running) return;
  status.running = true;

  let processed = 0;

  try {
    const [databaseSettings, pollingSettings] = await Promise.all([
      getPrismDatabaseSettings(),
      getPollingSettings(),
    ]);

    if (!pollingSettings.enabled) {
      status.lastSkipReason = 'Polling is disabled';
      return;
    }

    if (!databaseSettings.isVerified) {
      status.lastSkipReason = databaseSettings.url
        ? 'Prism database connection has not been verified'
        : 'Prism database URL is not configured';
      return;
    }
    status.lastSkipReason = null;

    const candidates = await getRecentConnections(pollingSettings.batchSize * 5);
    if (candidates.length === 0) return;

    const prisma = getPrismaClient();
    const existing = await prisma.processedConnection.findMany({
      where: { connectionId: { in: candidates.map(c => c.id) } },
      select: { connectionId: true },
    });
    const processedSet = new Set(existing.map(e => e.connectionId));

    const unprocessed = candidates
      .filter(c => !processedSet.has(c.id))
      .slice(0, pollingSettings.batchSize);

    for (const conn of unprocessed) {
      try {
        await validateAndSave(conn);
        processed++;
      } catch (err) {
        console.error(`[poller] error on connection ${conn.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[poller] fetch error:', err);
  } finally {
    status.running = false;
    status.lastRun = new Date().toISOString();
    status.processedInLastRun = processed;
  }
}

export async function startPoller(): Promise<void> {
  stopPoller();

  const settings = await getPollingSettings();
  if (!settings.enabled) {
    status.nextRun = null;
    console.log('[poller] disabled');
    return;
  }

  const intervalMs = settings.intervalSeconds * 1000;

  const tick = () => {
    status.nextRun = new Date(Date.now() + intervalMs).toISOString();
    runOnce();
  };

  tick();
  intervalId = setInterval(tick, intervalMs);
  console.log(`[poller] started, interval=${settings.intervalSeconds}s`);
}

export function stopPoller(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  status.nextRun = null;
}
