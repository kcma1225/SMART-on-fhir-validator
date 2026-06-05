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

  const rows = output.validations.flatMap(v =>
    v.results.map(r => ({
      connectionId: output.connectionId,
      userId: output.userId ?? null,
      serverId: output.serverId ?? null,
      serverName: output.serverName ?? null,
      standard: v.standard,
      flowStep: v.flowStep,
      fieldLocation: r.location,
      fieldName: r.field,
      required: r.required,
      status: r.status,
      detail: r.detail ?? null,
    })),
  );

  if (rows.length > 0) {
    await prisma.validationResult.createMany({ data: rows });
  }
}
