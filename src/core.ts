import { classify } from './router';
import { check } from './checker';
import { saveResults } from './writer';
import { getCachedRules } from './rules-db';
import type { PrismConnection, ValidationOutput } from './types';

export function validateConnection(conn: PrismConnection): ValidationOutput {
  const rules = getCachedRules();
  const flowStep = classify(conn, rules);
  const results = check(conn, flowStep, rules);
  return {
    connectionId: conn.id,
    institutionId: conn.institution_id,
    userId: conn.user_id,
    flowStep,
    results,
  };
}

export async function validateAndSave(conn: PrismConnection): Promise<ValidationOutput> {
  const output = validateConnection(conn);
  await saveResults(output);
  return output;
}
