import { getPrismaClient } from './db/validator';
import type { ValidationOutput } from './types';

export async function saveResults(output: ValidationOutput): Promise<void> {
  const prisma = getPrismaClient();

  await prisma.validationResult.deleteMany({ where: { connectionId: output.connectionId } });

  await prisma.processedConnection.upsert({
    where: { connectionId: output.connectionId },
    create: { connectionId: output.connectionId },
    update: { processedAt: new Date() },
  });

  if (output.results.length > 0) {
    await prisma.validationResult.createMany({
      data: output.results.map(r => ({
        connectionId: output.connectionId,
        userId: output.userId ?? null,
        serverId: output.serverId ?? null,
        serverName: output.serverName ?? null,
        flowStep: output.flowStep,
        fieldLocation: r.location,
        fieldName: r.field,
        required: r.required,
        status: r.status,
        detail: r.detail ?? null,
      })),
    });
  }
}
