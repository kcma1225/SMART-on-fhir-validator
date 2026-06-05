// Token Validation for an OAuth pipeline's introspection (token-validation) call.
//
// In a pipeline the validation connection introspects the issued access token:
// its REQUEST carries the JWT in the `token` form field, and its RESPONSE returns
// the decoded claims (plus `active`). A token is considered valid when the claims
// decoded straight from the request JWT match the introspection response — i.e.
// the server validated the very same token it was handed.

export interface TokenValidationResult {
  checked: boolean;          // false = nothing to compare (no JWT / non-JSON response)
  valid: boolean;
  active: boolean | null;    // introspection response "active" flag, when present
  matched: string[];         // claims that decoded identically in JWT and response
  mismatched: string[];      // claims present in both but with differing values
  detail: string;
}

function parseForm(body: string | null): Record<string, string> {
  if (!body) return {};
  const out: Record<string, string> = {};
  try {
    new URLSearchParams(body.trim()).forEach((v, k) => { out[k] = v; });
  } catch { /* ignore malformed body */ }
  return out;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function validateIntrospection(reqBody: string | null, resBody: string | null): TokenValidationResult {
  const skip = (detail: string): TokenValidationResult =>
    ({ checked: false, valid: false, active: null, matched: [], mismatched: [], detail });

  const jwt = parseForm(reqBody).token;
  if (!jwt) return skip('請求中找不到要驗證的 token');

  const payload = decodeJwtPayload(jwt);
  if (!payload) return skip('無法解碼請求中的 JWT');

  let res: Record<string, unknown>;
  try {
    const parsed = JSON.parse((resBody ?? '').trim());
    if (!parsed || typeof parsed !== 'object') return skip('introspection 回應非 JSON');
    res = parsed as Record<string, unknown>;
  } catch {
    return skip('introspection 回應非 JSON');
  }

  const active = typeof res.active === 'boolean' ? (res.active as boolean) : null;

  const matched: string[] = [];
  const mismatched: string[] = [];
  for (const key of Object.keys(payload)) {
    if (!(key in res)) continue;
    if (JSON.stringify(payload[key]) === JSON.stringify(res[key])) matched.push(key);
    else mismatched.push(key);
  }

  const valid = matched.length > 0 && mismatched.length === 0 && active !== false;

  let detail: string;
  if (active === false) detail = 'introspection 回應 active=false，token 無效';
  else if (matched.length === 0) detail = '請求 JWT 與回應沒有可比對的共同 claim';
  else if (mismatched.length > 0) detail = `claim 不一致：${mismatched.join(', ')}`;
  else detail = `JWT 解碼後與 introspection 回應一致（${matched.length} 個 claim 相符）`;

  return { checked: true, valid, active, matched, mismatched, detail };
}
