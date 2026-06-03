import { getPrismaClient } from './db/validator';

const SETTINGS_ID = 1;
const DEFAULT_POLLING_ENABLED = true;
const DEFAULT_POLLING_INTERVAL_SECONDS = 30;
const DEFAULT_POLLING_BATCH_SIZE = 100;
let settingsInitialized = false;
let settingsInitPromise: Promise<void> | null = null;

function normalizeBaseUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/$/, '');
  if (!trimmed) return null;

  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Base URL must start with http:// or https://');
  }
  return trimmed;
}

export interface PrismDatabaseSettings {
  url: string | null;
  verifiedAt: string | null;
  isVerified: boolean;
}

export interface PollingSettings {
  enabled: boolean;
  intervalSeconds: number;
  batchSize: number;
}

async function ensureSettingsRow(): Promise<void> {
  if (settingsInitialized) return;
  if (settingsInitPromise) return settingsInitPromise;

  settingsInitPromise = (async () => {
    const prisma = getPrismaClient();
    const existing = await prisma.validatorSetting.findUnique({ where: { id: SETTINGS_ID } });
    if (!existing) {
      await prisma.validatorSetting.create({
        data: {
          id: SETTINGS_ID,
          prismDatabaseUrl: process.env.PRISM_DATABASE_URL || null,
          baseUrl: process.env.BASE_URL ? normalizeBaseUrl(process.env.BASE_URL) : null,
          pollingEnabled: DEFAULT_POLLING_ENABLED,
          pollingIntervalSeconds: DEFAULT_POLLING_INTERVAL_SECONDS,
          pollingBatchSize: DEFAULT_POLLING_BATCH_SIZE,
        },
      });
    }
    settingsInitialized = true;
  })();

  try {
    await settingsInitPromise;
  } finally {
    settingsInitPromise = null;
  }
}

export async function getPrismDatabaseSettings(): Promise<PrismDatabaseSettings> {
  await ensureSettingsRow();
  const prisma = getPrismaClient();
  const setting = await prisma.validatorSetting.findUnique({ where: { id: SETTINGS_ID } });
  const fallbackUrl = process.env.PRISM_DATABASE_URL ?? null;
  const url = setting?.prismDatabaseUrl ?? fallbackUrl;
  const isVerified = Boolean(
    setting?.prismDatabaseVerifiedAt
      && setting.prismDatabaseVerifiedUrl
      && setting.prismDatabaseVerifiedUrl === url,
  );

  return {
    url,
    verifiedAt: isVerified ? setting!.prismDatabaseVerifiedAt!.toISOString() : null,
    isVerified,
  };
}

export async function getVerifiedPrismDatabaseUrl(): Promise<string> {
  const settings = await getPrismDatabaseSettings();
  if (!settings.url) throw new Error('Prism database URL is not configured');
  if (!settings.isVerified) throw new Error('Prism database connection has not been verified');
  return settings.url;
}

export async function saveVerifiedPrismDatabaseUrl(url: string): Promise<PrismDatabaseSettings> {
  await ensureSettingsRow();
  const trimmedUrl = url.trim();
  const prisma = getPrismaClient();
  const setting = await prisma.validatorSetting.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      prismDatabaseUrl: trimmedUrl,
      prismDatabaseVerifiedAt: new Date(),
      prismDatabaseVerifiedUrl: trimmedUrl,
    },
    update: {
      prismDatabaseUrl: trimmedUrl,
      prismDatabaseVerifiedAt: new Date(),
      prismDatabaseVerifiedUrl: trimmedUrl,
    },
  });

  return {
    url: setting.prismDatabaseUrl,
    verifiedAt: setting.prismDatabaseVerifiedAt?.toISOString() ?? null,
    isVerified: true,
  };
}

export async function getPollingSettings(): Promise<PollingSettings> {
  await ensureSettingsRow();
  const prisma = getPrismaClient();
  const setting = await prisma.validatorSetting.findUniqueOrThrow({ where: { id: SETTINGS_ID } });

  return {
    enabled: setting.pollingEnabled,
    intervalSeconds: setting.pollingIntervalSeconds,
    batchSize: setting.pollingBatchSize,
  };
}

export async function touchRulesUpdatedAt(): Promise<void> {
  await ensureSettingsRow();
  const prisma = getPrismaClient();
  await Promise.all([
    prisma.validatorSetting.update({
      where: { id: SETTINGS_ID },
      data: { rulesUpdatedAt: new Date() },
    }),
    prisma.processedConnection.deleteMany(),
  ]);
}

export async function getRulesUpdatedAt(): Promise<string | null> {
  await ensureSettingsRow();
  const prisma = getPrismaClient();
  const setting = await prisma.validatorSetting.findUnique({ where: { id: SETTINGS_ID } });
  return setting?.rulesUpdatedAt?.toISOString() ?? null;
}

export async function getBaseUrl(): Promise<string | null> {
  await ensureSettingsRow();
  const prisma = getPrismaClient();
  const setting = await prisma.validatorSetting.findUnique({ where: { id: SETTINGS_ID } });
  const raw = setting?.baseUrl ?? process.env.BASE_URL ?? null;
  if (!raw) return null;
  try {
    return normalizeBaseUrl(raw);
  } catch {
    return null;
  }
}

export async function saveBaseUrl(url: string): Promise<string | null> {
  await ensureSettingsRow();
  const prisma = getPrismaClient();
  const trimmed = normalizeBaseUrl(url);
  const setting = await prisma.validatorSetting.update({
    where: { id: SETTINGS_ID },
    data: { baseUrl: trimmed },
  });
  return setting.baseUrl;
}

export async function savePollingSettings(input: {
  enabled: boolean;
  intervalSeconds: number;
  batchSize: number;
}): Promise<PollingSettings> {
  const intervalSeconds = Number(input.intervalSeconds);
  const batchSize = Number(input.batchSize);

  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 3600) {
    throw new Error('Polling interval must be an integer between 5 and 3600 seconds');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error('Polling batch size must be an integer between 1 and 1000');
  }

  await ensureSettingsRow();
  const prisma = getPrismaClient();
  const setting = await prisma.validatorSetting.update({
    where: { id: SETTINGS_ID },
    data: {
      pollingEnabled: Boolean(input.enabled),
      pollingIntervalSeconds: intervalSeconds,
      pollingBatchSize: batchSize,
    },
  });

  return {
    enabled: setting.pollingEnabled,
    intervalSeconds: setting.pollingIntervalSeconds,
    batchSize: setting.pollingBatchSize,
  };
}
