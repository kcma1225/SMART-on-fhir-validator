import { getPrismaClient } from './db/validator';

const SETTINGS_ID = 1;
const DEFAULT_POLLING_ENABLED = true;
const DEFAULT_POLLING_INTERVAL_SECONDS = 30;
const DEFAULT_POLLING_BATCH_SIZE = 100;

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
  const prisma = getPrismaClient();
  await prisma.validatorSetting.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      prismDatabaseUrl: process.env.PRISM_DATABASE_URL || null,
      pollingEnabled: DEFAULT_POLLING_ENABLED,
      pollingIntervalSeconds: DEFAULT_POLLING_INTERVAL_SECONDS,
      pollingBatchSize: DEFAULT_POLLING_BATCH_SIZE,
    },
    update: {},
  });
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

export async function getBaseUrl(): Promise<string | null> {
  await ensureSettingsRow();
  const prisma = getPrismaClient();
  const setting = await prisma.validatorSetting.findUnique({ where: { id: SETTINGS_ID } });
  return setting?.baseUrl ?? null;
}

export async function saveBaseUrl(url: string): Promise<string | null> {
  await ensureSettingsRow();
  const prisma = getPrismaClient();
  const trimmed = url.trim().replace(/\/$/, '');
  const setting = await prisma.validatorSetting.update({
    where: { id: SETTINGS_ID },
    data: { baseUrl: trimmed || null },
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
