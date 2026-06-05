import * as fs from 'fs';
import * as path from 'path';
import { classify } from './router';
import { check } from './checker';
import { getCachedRules } from './rules-db';
import { STANDARDS } from './types';
import type { PrismConnection, FieldStatus, Standard } from './types';

interface FixtureInput {
  req_method: string;
  req_url: string;
  req_headers: Record<string, string>;
  req_body: string | null;
  res_body: string | null;
}

interface FixtureExpectedField {
  field: string;
  status: FieldStatus;
  detail?: string;
}

interface Fixture {
  id: string;
  description: string;
  standard?: string; // 'SMART' (default) | 'IUA'
  input: FixtureInput;
  expected: {
    flowStep: string;
    results: FixtureExpectedField[];
  };
}

export interface FieldComparison {
  field: string;
  expected: FieldStatus;
  actual: FieldStatus;
  mismatch?: boolean;
}

export interface CaseResult {
  id: string;
  standard: Standard;
  description: string;
  expectedFlowStep: string;
  actualFlowStep: string;
  status: 'PASS' | 'FAIL';
  fields: FieldComparison[];
}

function resolveStandard(value: string | undefined): Standard {
  return value && (STANDARDS as string[]).includes(value) ? (value as Standard) : 'SMART';
}

export interface TestReport {
  total: number;
  passed: number;
  failed: number;
  cases: CaseResult[];
}

export function runTests(): TestReport {
  const fixturesPath = path.join(process.cwd(), 'tests', 'test-fixtures.json');
  const fixtures: Fixture[] = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

  const cases: CaseResult[] = fixtures.map(fixture => {
    const standard = resolveStandard(fixture.standard);
    const rules = getCachedRules(standard);

    const conn: PrismConnection = {
      id: fixture.id,
      user_id: null,
      server_id: null,
      share_token: null,
      req_method: fixture.input.req_method,
      req_url: fixture.input.req_url,
      req_headers: fixture.input.req_headers,
      req_body: fixture.input.req_body,
      res_body: fixture.input.res_body,
    };

    const actualFlowStep = classify(conn, rules);
    const actualResults = check(conn, actualFlowStep, rules);
    const actualMap = new Map(actualResults.map(r => [r.field, r]));

    const fields: FieldComparison[] = fixture.expected.results.map(exp => {
      const actual = actualMap.get(exp.field);
      const actualStatus = actual?.status ?? ('SKIP' as FieldStatus);
      return {
        field: exp.field,
        expected: exp.status,
        actual: actualStatus,
        ...(actualStatus !== exp.status ? { mismatch: true } : {}),
      };
    });

    const flowMatch = actualFlowStep === fixture.expected.flowStep;
    const fieldsMatch = fields.every(f => !f.mismatch);
    const caseStatus: 'PASS' | 'FAIL' = flowMatch && fieldsMatch ? 'PASS' : 'FAIL';

    return {
      id: fixture.id,
      standard,
      description: fixture.description,
      expectedFlowStep: fixture.expected.flowStep,
      actualFlowStep,
      status: caseStatus,
      fields,
    };
  });

  const passed = cases.filter(c => c.status === 'PASS').length;

  return { total: cases.length, passed, failed: cases.length - passed, cases };
}
