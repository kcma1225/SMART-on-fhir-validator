import { PrismaClient } from '@prisma/client';

let _client: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!_client) {
    _client = new PrismaClient({ log: ['warn', 'error'] });
  }
  return _client;
}
