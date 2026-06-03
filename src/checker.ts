import type {
  PrismConnection,
  FlowStep,
  RulesConfig,
  FieldResult,
  FieldLocation,
  CheckFields,
} from './types';

export function check(conn: PrismConnection, flowStep: FlowStep, rules: RulesConfig): FieldResult[] {
  if (flowStep === 'unknown') return [];

  const ruleDef = rules.flows[flowStep];
  if (!ruleDef) return [];

  const results: FieldResult[] = [];
  const { check: checkDef } = ruleDef;

  if (checkDef.query_params) {
    const params = parseQueryParams(conn.req_url);
    results.push(...checkSimpleFields(params, checkDef.query_params, 'query_params'));
  }

  if (checkDef.body_params) {
    const body = parseFormBody(conn.req_body);
    results.push(...checkSimpleFields(body, checkDef.body_params, 'body_params'));
  }

  if (checkDef.headers) {
    const headers = normalizeHeaders(conn.req_headers);
    results.push(...checkHeaderFields(headers, checkDef.headers));
  }

  if (checkDef.response_body) {
    const resBody = parseJsonBody(conn.res_body);
    results.push(...checkSimpleFields(resBody, checkDef.response_body, 'response_body'));
  }

  return results;
}

function parseQueryParams(url: string): Record<string, string> {
  try {
    const u = new URL(url);
    const result: Record<string, string> = {};
    u.searchParams.forEach((v, k) => { result[k] = v; });
    return result;
  } catch {
    return {};
  }
}

function parseFormBody(body: string | null): Record<string, string> {
  if (!body) return {};
  const trimmed = body.trim();

  if (!trimmed.startsWith('{')) {
    try {
      const params = new URLSearchParams(trimmed);
      const result: Record<string, string> = {};
      params.forEach((v, k) => { result[k] = v; });
      return result;
    } catch {
      // fall through
    }
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {
    // not parseable
  }

  return {};
}

function parseJsonBody(body: string | null): Record<string, unknown> {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body.trim());
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return {};
}

function normalizeHeaders(headers: Record<string, string> | null): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    result[k.toLowerCase()] = v;
  }
  return result;
}

function checkSimpleFields(
  data: Record<string, unknown>,
  def: CheckFields,
  location: FieldLocation,
): FieldResult[] {
  const results: FieldResult[] = [];

  for (const field of def.required ?? []) {
    const present = field in data;
    results.push({
      field,
      location,
      required: true,
      status: present ? 'PASS' : 'FAIL',
      ...(present ? {} : { detail: `field not present in ${location.replace('_', ' ')}` }),
    });
  }

  for (const field of [...(def.optional ?? []), ...(def.conditional ?? [])]) {
    results.push({
      field,
      location,
      required: false,
      status: field in data ? 'PASS' : 'SKIP',
    });
  }

  for (const field of def.forbidden ?? []) {
    const present = field in data;
    results.push({
      field,
      location,
      required: false,
      status: present ? 'FAIL' : 'PASS',
      ...(present ? { detail: `forbidden field present in ${location.replace(/_/g, ' ')}` } : {}),
    });
  }

  return results;
}

function checkHeaderFields(
  headers: Record<string, string>,
  def: CheckFields,
): FieldResult[] {
  const results: FieldResult[] = [];

  for (const field of def.required ?? []) {
    const lowerField = field.toLowerCase();
    const value = headers[lowerField];

    if (value === undefined) {
      results.push({
        field,
        location: 'headers',
        required: true,
        status: 'FAIL',
        detail: 'header not present in request',
      });
      continue;
    }

    const pattern = def.patterns?.[field];
    if (pattern) {
      const ok = new RegExp(pattern).test(value);
      results.push({
        field,
        location: 'headers',
        required: true,
        status: ok ? 'PASS' : 'FAIL',
        ...(ok ? {} : { detail: `header present but does not match pattern ${pattern}` }),
      });
    } else {
      results.push({ field, location: 'headers', required: true, status: 'PASS' });
    }
  }

  for (const field of def.optional ?? []) {
    results.push({
      field,
      location: 'headers',
      required: false,
      status: headers[field.toLowerCase()] !== undefined ? 'PASS' : 'SKIP',
    });
  }

  for (const field of def.forbidden ?? []) {
    const present = headers[field.toLowerCase()] !== undefined;
    results.push({
      field,
      location: 'headers',
      required: false,
      status: present ? 'FAIL' : 'PASS',
      ...(present ? { detail: 'forbidden header present in request' } : {}),
    });
  }

  return results;
}
