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

  // url_contains may list several alternatives separated by "|"; the request
  // matches if it contains ANY of them (e.g. smart-configuration OR openid-configuration).
  const urlAlternatives = identify.url_contains.split('|').map(s => s.trim()).filter(Boolean);
  if (!urlAlternatives.some(part => conn.req_url.includes(part))) return false;

  // A .well-known discovery document (e.g. /fhir/.well-known/smart-configuration)
  // is never a resource/auth request — it must only match a metadata-style rule
  // whose url_contains itself targets .well-known. This stops the broad `/fhir`
  // rule from greedily claiming discovery docs (notably for IUA, which has no
  // metadata flow), which would otherwise produce a misleading Authorization FAIL.
  if (conn.req_url.includes('/.well-known/') && !identify.url_contains.includes('.well-known')) {
    return false;
  }

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
