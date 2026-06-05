import { classify } from './router';
import { check } from './checker';
import { saveResults } from './writer';
import { getCachedRules } from './rules-db';
import { getServerName } from './db/prism';
import { STANDARDS } from './types';
import type { PrismConnection, ValidationOutput, StandardValidation } from './types';

export function validateConnection(conn: PrismConnection): ValidationOutput {
  const validations: StandardValidation[] = STANDARDS.map(standard => {
    const rules = getCachedRules(standard);
    const flowStep = classify(conn, rules);
    const results = check(conn, flowStep, rules);
    return { standard, flowStep, results };
  });

  return {
    connectionId: conn.id,
    userId: conn.user_id,
    serverId: conn.server_id ?? null,
    serverName: null,
    validations,
  };
}

export async function validateAndSave(conn: PrismConnection): Promise<ValidationOutput> {
  const output = validateConnection(conn);
  if (conn.server_id) {
    output.serverName = await getServerName(conn.server_id);
  }
  await saveResults(output);
  return output;
}
