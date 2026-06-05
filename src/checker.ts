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
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  try {
    const result: Record<string, string> = {};
    new URLSearchParams(url.slice(idx + 1)).forEach((v, k) => { result[k] = v; });
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

function toValueString(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'object') return JSON.stringify(raw);
  return String(raw);
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
      ...(present ? { value: toValueString(data[field]) } : { detail: `field not present in ${location.replace(/_/g, ' ')}` }),
    });
  }

  for (const field of [...(def.optional ?? []), ...(def.conditional ?? [])]) {
    const present = field in data;
    results.push({
      field,
      location,
      required: false,
      status: present ? 'PASS' : 'SKIP',
      ...(present ? { value: toValueString(data[field]) } : {}),
    });
  }

  for (const field of def.forbidden ?? []) {
    const present = field in data;
    results.push({
      field,
      location,
      required: false,
      status: present ? 'FAIL' : 'PASS',
      ...(present ? { value: toValueString(data[field]), detail: `forbidden field present in ${location.replace(/_/g, ' ')}` } : {}),
    });
  }

  return results;
}

function checkHeaderFields(
  headers: Record<string, string>,
  def: CheckFields,
): FieldResult[] {
  const results: FieldResult[] = [];

  // required: absent → FAIL; present → optional pattern check
  for (const field of def.required ?? []) {
    const value = headers[field.toLowerCase()];

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
    if (pattern && !new RegExp(pattern).test(value)) {
      results.push({
        field,
        location: 'headers',
        required: true,
        status: 'FAIL',
        value,
        detail: `header present but does not match pattern ${pattern}`,
      });
    } else {
      results.push({ field, location: 'headers', required: true, status: 'PASS', value });
    }
  }

  // conditional / optional: absent → SKIP; present → optional pattern check
  for (const field of [...(def.optional ?? []), ...(def.conditional ?? [])]) {
    const value = headers[field.toLowerCase()];

    if (value === undefined) {
      results.push({ field, location: 'headers', required: false, status: 'SKIP' });
      continue;
    }

    const pattern = def.patterns?.[field];
    if (pattern && !new RegExp(pattern).test(value)) {
      results.push({
        field,
        location: 'headers',
        required: false,
        status: 'FAIL',
        value,
        detail: `header present but does not match pattern ${pattern}`,
      });
    } else {
      results.push({ field, location: 'headers', required: false, status: 'PASS', value });
    }
  }

  for (const field of def.forbidden ?? []) {
    const v = headers[field.toLowerCase()];
    const present = v !== undefined;
    results.push({
      field,
      location: 'headers',
      required: false,
      status: present ? 'FAIL' : 'PASS',
      ...(present ? { value: v, detail: 'forbidden header present in request' } : {}),
    });
  }

  return results;
}
