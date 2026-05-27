import type { PrismConnection, FlowStep, RulesConfig, FlowRule } from './types';

export function classify(conn: PrismConnection, rules: RulesConfig): FlowStep {
  for (const [step, rule] of Object.entries(rules.flows)) {
    if (matches(conn, rule)) return step as FlowStep;
  }
  return 'unknown';
}

function matches(conn: PrismConnection, rule: FlowRule): boolean {
  const { identify } = rule;

  if (identify.method !== '*') {
    if (conn.req_method.toUpperCase() !== identify.method.toUpperCase()) return false;
  }

  if (!conn.req_url.includes(identify.url_contains)) return false;

  if (identify.body_contains) {
    const body = parseBody(conn.req_body);
    for (const [key, value] of Object.entries(identify.body_contains)) {
      if (body[key] !== value) return false;
    }
  }

  return true;
}

function parseBody(body: string | null): Record<string, string> {
  if (!body) return {};
  const trimmed = body.trim();

  if (!trimmed.startsWith('{')) {
    try {
      const params = new URLSearchParams(trimmed);
      const result: Record<string, string> = {};
      params.forEach((v, k) => { result[k] = v; });
      return result;
    } catch {
      // fall through to JSON parse
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
