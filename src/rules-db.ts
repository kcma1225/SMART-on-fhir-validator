import { getPrismaClient } from './db/validator';
import { touchRulesUpdatedAt } from './settings';
import { STANDARDS } from './types';
import type { RulesConfig, FlowRule, Standard } from './types';

let cachedRules: Map<Standard, RulesConfig> = new Map();

const FIELD_LOCATIONS = ['query_params', 'body_params', 'headers', 'response_body'];
const FIELD_TYPES = ['required', 'conditional', 'optional', 'forbidden'];
const FLOW_ORDER = [
  'smart_metadata',
  'authorization_request',
  'token_request_auth_code',
  'token_request_client_cred',
  'fhir_request',
  'token_request_refresh',
];

function isStandard(value: string): value is Standard {
  return (STANDARDS as string[]).includes(value);
}

export interface RuleFieldInput {
  standard: string;
  flowStep: string;
  fieldName: string;
  fieldLocation: string;
  fieldType: string;
  pattern?: string | null;
  sortOrder?: number;
}

export interface FlowIdentifierInput {
  description: string;
  method: string;
  urlContains: string;
  bodyGrantType?: string | null;
}

// ── Default seed data ────────────────────────────────────────────────────────

const DEFAULT_IDENTIFIERS = [
  // ── SMART ──────────────────────────────────────────────────────────────────
  { standard: 'SMART', flowStep: 'smart_metadata',            description: 'SMART 服務聲明 Metadata 請求 (Step 70)',                                  method: 'GET',  urlContains: '/.well-known/smart-configuration|/.well-known/openid-configuration', bodyGrantType: null, priority: 1 },
  { standard: 'SMART', flowStep: 'authorization_request',     description: 'OAuth Authorization Endpoint 請求 (AppLaunch Step 200)',                  method: 'GET',  urlContains: '/protocol/openid-connect/auth',    bodyGrantType: null,                 priority: 2 },
  { standard: 'SMART', flowStep: 'token_request_auth_code',   description: 'Token Endpoint 請求 — Authorization Code Flow (AppLaunch Step 210)',       method: 'POST', urlContains: '/protocol/openid-connect/token',   bodyGrantType: 'authorization_code', priority: 3 },
  { standard: 'SMART', flowStep: 'token_request_client_cred', description: 'Token Endpoint 請求 — Client Credentials Flow (BackendServices Step 200)', method: 'POST', urlContains: '/protocol/openid-connect/token',   bodyGrantType: 'client_credentials', priority: 4 },
  { standard: 'SMART', flowStep: 'fhir_request',              description: 'FHIR Resource 存取請求 (Step 300)',                                       method: '*',    urlContains: '/fhir',                            bodyGrantType: null,                 priority: 5 },
  { standard: 'SMART', flowStep: 'token_request_refresh',     description: 'Token Endpoint 請求 — Refresh Token Flow (AppLaunch Step 310)',            method: 'POST', urlContains: '/protocol/openid-connect/token',   bodyGrantType: 'refresh_token',      priority: 6 },

  // ── IUA — ITI-71 / ITI-72 (no metadata discovery step) ──────────────────────
  { standard: 'IUA', flowStep: 'authorization_request',     description: 'IUA Step 1 — Authorization Request',                              method: 'GET',  urlContains: '/protocol/openid-connect/auth',  bodyGrantType: null,                 priority: 1 },
  { standard: 'IUA', flowStep: 'token_request_auth_code',   description: 'IUA Step 2 — ITI-71 Get Access Token (Authorization Code Grant)', method: 'POST', urlContains: '/protocol/openid-connect/token', bodyGrantType: 'authorization_code', priority: 2 },
  { standard: 'IUA', flowStep: 'token_request_client_cred', description: 'IUA Step 2 — ITI-71 Get Access Token (Client Credentials Grant)', method: 'POST', urlContains: '/protocol/openid-connect/token', bodyGrantType: 'client_credentials', priority: 3 },
  { standard: 'IUA', flowStep: 'token_request_refresh',     description: 'IUA Step 2 — ITI-71 Get Access Token (Refresh Token)',            method: 'POST', urlContains: '/protocol/openid-connect/token', bodyGrantType: 'refresh_token',      priority: 4 },
  { standard: 'IUA', flowStep: 'fhir_request',              description: 'IUA Step 3 — ITI-72 Incorporate Access Token',                    method: '*',    urlContains: '/fhir',                          bodyGrantType: null,                 priority: 5 },
];

const DEFAULT_FIELDS = [
  // ════════════════════════════════════════════════════════════════════════════
  // SMART
  // ════════════════════════════════════════════════════════════════════════════
  // smart_metadata — response_body
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'grant_types_supported',            fieldLocation: 'response_body', fieldType: 'required',    pattern: null, sortOrder: 0 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'token_endpoint',                   fieldLocation: 'response_body', fieldType: 'required',    pattern: null, sortOrder: 1 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'capabilities',                     fieldLocation: 'response_body', fieldType: 'conditional', pattern: null, sortOrder: 2 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'code_challenge_methods_supported', fieldLocation: 'response_body', fieldType: 'required',    pattern: null, sortOrder: 3 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'issuer',                           fieldLocation: 'response_body', fieldType: 'conditional', pattern: null, sortOrder: 4 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'jwks_uri',                         fieldLocation: 'response_body', fieldType: 'conditional', pattern: null, sortOrder: 5 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'authorization_endpoint',           fieldLocation: 'response_body', fieldType: 'required',    pattern: null, sortOrder: 6 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'token_endpoint_auth_methods_supported', fieldLocation: 'response_body', fieldType: 'optional', pattern: null, sortOrder: 7 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'registration_endpoint',            fieldLocation: 'response_body', fieldType: 'optional',    pattern: null, sortOrder: 8 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'introspection_endpoint',           fieldLocation: 'response_body', fieldType: 'optional',    pattern: null, sortOrder: 9 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'revocation_endpoint',              fieldLocation: 'response_body', fieldType: 'optional',    pattern: null, sortOrder: 10 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'scopes_supported',                 fieldLocation: 'response_body', fieldType: 'optional',    pattern: null, sortOrder: 11 },
  { standard: 'SMART', flowStep: 'smart_metadata', fieldName: 'response_types_supported',         fieldLocation: 'response_body', fieldType: 'optional',    pattern: null, sortOrder: 12 },

  // token_request_refresh — body_params
  { standard: 'SMART', flowStep: 'token_request_refresh', fieldName: 'grant_type',    fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 0 },
  { standard: 'SMART', flowStep: 'token_request_refresh', fieldName: 'refresh_token', fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 1 },
  { standard: 'SMART', flowStep: 'token_request_refresh', fieldName: 'scope',         fieldLocation: 'body_params', fieldType: 'optional', pattern: null, sortOrder: 2 },

  // token_request_client_cred — body_params
  { standard: 'SMART', flowStep: 'token_request_client_cred', fieldName: 'grant_type',            fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 0 },
  { standard: 'SMART', flowStep: 'token_request_client_cred', fieldName: 'scope',                 fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 1 },
  { standard: 'SMART', flowStep: 'token_request_client_cred', fieldName: 'client_assertion_type', fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 2 },
  { standard: 'SMART', flowStep: 'token_request_client_cred', fieldName: 'client_assertion',      fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 3 },

  // token_request_auth_code — body_params
  { standard: 'SMART', flowStep: 'token_request_auth_code', fieldName: 'grant_type',   fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 0 },
  { standard: 'SMART', flowStep: 'token_request_auth_code', fieldName: 'code',         fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 1 },
  { standard: 'SMART', flowStep: 'token_request_auth_code', fieldName: 'redirect_uri', fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 2 },
  { standard: 'SMART', flowStep: 'token_request_auth_code', fieldName: 'code_verifier',fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 3 },
  { standard: 'SMART', flowStep: 'token_request_auth_code', fieldName: 'client_id',    fieldLocation: 'body_params', fieldType: 'optional', pattern: null, sortOrder: 4 },

  // authorization_request — query_params
  { standard: 'SMART', flowStep: 'authorization_request', fieldName: 'response_type',        fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 0 },
  { standard: 'SMART', flowStep: 'authorization_request', fieldName: 'client_id',            fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 1 },
  { standard: 'SMART', flowStep: 'authorization_request', fieldName: 'redirect_uri',         fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 2 },
  { standard: 'SMART', flowStep: 'authorization_request', fieldName: 'scope',                fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 3 },
  { standard: 'SMART', flowStep: 'authorization_request', fieldName: 'state',                fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 4 },
  { standard: 'SMART', flowStep: 'authorization_request', fieldName: 'aud',                  fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 5 },
  { standard: 'SMART', flowStep: 'authorization_request', fieldName: 'code_challenge',       fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 6 },
  { standard: 'SMART', flowStep: 'authorization_request', fieldName: 'code_challenge_method',fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 7 },
  { standard: 'SMART', flowStep: 'authorization_request', fieldName: 'launch',               fieldLocation: 'query_params', fieldType: 'optional', pattern: null, sortOrder: 8 },

  // fhir_request — headers
  { standard: 'SMART', flowStep: 'fhir_request', fieldName: 'Authorization', fieldLocation: 'headers', fieldType: 'required', pattern: '^Bearer .+', sortOrder: 0 },

  // ════════════════════════════════════════════════════════════════════════════
  // IUA — ITI-71 / ITI-72
  // ════════════════════════════════════════════════════════════════════════════
  // Step 1 — Authorization Request — query_params
  { standard: 'IUA', flowStep: 'authorization_request', fieldName: 'response_type',         fieldLocation: 'query_params', fieldType: 'required', pattern: '^code$', sortOrder: 0 },
  { standard: 'IUA', flowStep: 'authorization_request', fieldName: 'client_id',             fieldLocation: 'query_params', fieldType: 'required', pattern: null,     sortOrder: 1 },
  { standard: 'IUA', flowStep: 'authorization_request', fieldName: 'state',                 fieldLocation: 'query_params', fieldType: 'required', pattern: null,     sortOrder: 2 },
  { standard: 'IUA', flowStep: 'authorization_request', fieldName: 'code_challenge',        fieldLocation: 'query_params', fieldType: 'required', pattern: null,     sortOrder: 3 },
  { standard: 'IUA', flowStep: 'authorization_request', fieldName: 'redirect_uri',          fieldLocation: 'query_params', fieldType: 'optional', pattern: null,     sortOrder: 4 },
  { standard: 'IUA', flowStep: 'authorization_request', fieldName: 'scope',                 fieldLocation: 'query_params', fieldType: 'optional', pattern: null,     sortOrder: 5 },
  { standard: 'IUA', flowStep: 'authorization_request', fieldName: 'code_challenge_method', fieldLocation: 'query_params', fieldType: 'optional', pattern: '^S256$', sortOrder: 6 },
  { standard: 'IUA', flowStep: 'authorization_request', fieldName: 'resource',              fieldLocation: 'query_params', fieldType: 'optional', pattern: null,     sortOrder: 7 },

  // Step 2 — ITI-71 Token Request — Authorization Code Grant
  { standard: 'IUA', flowStep: 'token_request_auth_code', fieldName: 'Authorization',        fieldLocation: 'headers',     fieldType: 'required', pattern: null,                                  sortOrder: 0 },
  { standard: 'IUA', flowStep: 'token_request_auth_code', fieldName: 'Content-Type',         fieldLocation: 'headers',     fieldType: 'required', pattern: '^application/x-www-form-urlencoded', sortOrder: 1 },
  { standard: 'IUA', flowStep: 'token_request_auth_code', fieldName: 'grant_type',           fieldLocation: 'body_params', fieldType: 'required', pattern: '^authorization_code$',              sortOrder: 0 },
  { standard: 'IUA', flowStep: 'token_request_auth_code', fieldName: 'code',                 fieldLocation: 'body_params', fieldType: 'required', pattern: null,                                  sortOrder: 1 },
  { standard: 'IUA', flowStep: 'token_request_auth_code', fieldName: 'code_verifier',        fieldLocation: 'body_params', fieldType: 'required', pattern: null,                                  sortOrder: 2 },
  { standard: 'IUA', flowStep: 'token_request_auth_code', fieldName: 'requested_token_type', fieldLocation: 'body_params', fieldType: 'optional', pattern: null,                                  sortOrder: 3 },

  // Step 2 — ITI-71 Token Request — Client Credentials Grant
  { standard: 'IUA', flowStep: 'token_request_client_cred', fieldName: 'Content-Type',  fieldLocation: 'headers',     fieldType: 'required', pattern: '^application/x-www-form-urlencoded', sortOrder: 0 },
  { standard: 'IUA', flowStep: 'token_request_client_cred', fieldName: 'Authorization', fieldLocation: 'headers',     fieldType: 'required', pattern: null,                                  sortOrder: 1 },
  { standard: 'IUA', flowStep: 'token_request_client_cred', fieldName: 'grant_type',           fieldLocation: 'body_params', fieldType: 'required', pattern: '^client_credentials$', sortOrder: 0 },
  { standard: 'IUA', flowStep: 'token_request_client_cred', fieldName: 'scope',                fieldLocation: 'body_params', fieldType: 'required', pattern: null,                    sortOrder: 1 },
  { standard: 'IUA', flowStep: 'token_request_client_cred', fieldName: 'resource',             fieldLocation: 'body_params', fieldType: 'optional', pattern: null,                    sortOrder: 2 },
  { standard: 'IUA', flowStep: 'token_request_client_cred', fieldName: 'requested_token_type', fieldLocation: 'body_params', fieldType: 'optional', pattern: null,                    sortOrder: 3 },

  // Step 2 — ITI-71 Token Request — Refresh Token
  { standard: 'IUA', flowStep: 'token_request_refresh', fieldName: 'Content-Type',  fieldLocation: 'headers',     fieldType: 'required', pattern: '^application/x-www-form-urlencoded', sortOrder: 0 },
  { standard: 'IUA', flowStep: 'token_request_refresh', fieldName: 'grant_type',    fieldLocation: 'body_params', fieldType: 'required', pattern: '^refresh_token$',                   sortOrder: 0 },
  { standard: 'IUA', flowStep: 'token_request_refresh', fieldName: 'refresh_token', fieldLocation: 'body_params', fieldType: 'required', pattern: null,                                  sortOrder: 1 },
  { standard: 'IUA', flowStep: 'token_request_refresh', fieldName: 'scope',         fieldLocation: 'body_params', fieldType: 'optional', pattern: null,                                  sortOrder: 2 },

  // Step 3 — ITI-72 Incorporate Access Token — headers
  { standard: 'IUA', flowStep: 'fhir_request', fieldName: 'Authorization', fieldLocation: 'headers', fieldType: 'required', pattern: '^Bearer .+', sortOrder: 0 },
];

function normalizeRuleFieldInput(input: RuleFieldInput): RuleFieldInput {
  const standard = input.standard?.trim();
  const flowStep = input.flowStep.trim();
  const fieldName = input.fieldName.trim();
  const fieldLocation = input.fieldLocation.trim();
  const fieldType = input.fieldType.trim();
  const pattern = input.pattern?.trim() || null;
  const sortOrder = Number(input.sortOrder ?? 0);

  if (!standard || !isStandard(standard)) throw new Error('invalid standard');
  if (!flowStep) throw new Error('flowStep required');
  if (!fieldName) throw new Error('fieldName required');
  if (!FIELD_LOCATIONS.includes(fieldLocation)) throw new Error('invalid fieldLocation');
  if (!FIELD_TYPES.includes(fieldType)) throw new Error('invalid fieldType');
  if (!Number.isFinite(sortOrder)) throw new Error('invalid sortOrder');

  return { standard, flowStep, fieldName, fieldLocation, fieldType, pattern, sortOrder };
}

function normalizeFlowIdentifierInput(input: FlowIdentifierInput): FlowIdentifierInput {
  const description = input.description.trim();
  const method = input.method.trim().toUpperCase();
  const urlContains = input.urlContains.trim();
  const bodyGrantType = input.bodyGrantType?.trim() || null;

  if (!description) throw new Error('description required');
  if (!method) throw new Error('method required');
  if (!urlContains) throw new Error('urlContains required');

  return { description, method, urlContains, bodyGrantType };
}

// ── Build RulesConfig from DB rows ───────────────────────────────────────────

async function buildRulesConfigFor(standard: Standard): Promise<RulesConfig> {
  const prisma = getPrismaClient();
  const [identifiers, fields] = await Promise.all([
    prisma.flowIdentifier.findMany({ where: { standard }, orderBy: { priority: 'asc' } }),
    prisma.flowRuleField.findMany({ where: { standard }, orderBy: { sortOrder: 'asc' } }),
  ]);

  const flows: Record<string, FlowRule> = {};

  for (const ident of identifiers) {
    const flowFields = fields.filter(f => f.flowStep === ident.flowStep);
    const check: FlowRule['check'] = {};
    const LOCATIONS = ['query_params', 'body_params', 'headers', 'response_body'] as const;

    for (const loc of LOCATIONS) {
      const locFields = flowFields.filter(f => f.fieldLocation === loc);
      if (locFields.length === 0) continue;

      const required    = locFields.filter(f => f.fieldType === 'required').map(f => f.fieldName);
      const conditional = locFields.filter(f => f.fieldType === 'conditional').map(f => f.fieldName);
      const optional    = locFields.filter(f => f.fieldType === 'optional').map(f => f.fieldName);
      const forbidden   = locFields.filter(f => f.fieldType === 'forbidden').map(f => f.fieldName);
      const patterns: Record<string, string> = {};
      for (const f of locFields) {
        if (f.pattern) patterns[f.fieldName] = f.pattern;
      }

      check[loc] = {
        ...(required.length    ? { required }    : {}),
        ...(conditional.length ? { conditional } : {}),
        ...(optional.length    ? { optional }    : {}),
        ...(forbidden.length   ? { forbidden }   : {}),
        ...(Object.keys(patterns).length ? { patterns } : {}),
      };
    }

    flows[ident.flowStep] = {
      description: ident.description,
      identify: {
        method: ident.method,
        url_contains: ident.urlContains,
        ...(ident.bodyGrantType ? { body_contains: { grant_type: ident.bodyGrantType } } : {}),
      },
      check,
    };
  }

  return { flows };
}

async function buildAllRules(): Promise<Map<Standard, RulesConfig>> {
  const map = new Map<Standard, RulesConfig>();
  for (const standard of STANDARDS) {
    map.set(standard, await buildRulesConfigFor(standard));
  }
  return map;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initRules(): Promise<void> {
  const prisma = getPrismaClient();
  const count = await prisma.flowIdentifier.count();

  if (count === 0) {
    for (const ident of DEFAULT_IDENTIFIERS) {
      await prisma.flowIdentifier.create({ data: ident });
    }
    await prisma.flowRuleField.createMany({ data: DEFAULT_FIELDS });
    console.log('[rules-db] seeded default rules (SMART + IUA)');
  } else {
    await Promise.all(
      DEFAULT_IDENTIFIERS.map(ident => prisma.flowIdentifier.updateMany({
        where: { standard: ident.standard, flowStep: ident.flowStep },
        data: { priority: ident.priority },
      })),
    );
  }

  cachedRules = await buildAllRules();
  console.log('[rules-db] rules loaded from DB');
}

export function getCachedRules(standard: Standard): RulesConfig {
  const rules = cachedRules.get(standard);
  if (!rules) throw new Error(`Rules not initialized for standard ${standard} — call initRules() first`);
  return rules;
}

export async function reloadRulesFromDb(): Promise<Map<Standard, RulesConfig>> {
  cachedRules = await buildAllRules();
  return cachedRules;
}

export async function listRuleDefinitions(standard: Standard): Promise<{ flows: unknown[]; fields: unknown[] }> {
  const prisma = getPrismaClient();
  const [flows, fields] = await Promise.all([
    prisma.flowIdentifier.findMany({ where: { standard }, orderBy: { priority: 'asc' } }),
    prisma.flowRuleField.findMany({
      where: { standard },
      orderBy: [
        { fieldLocation: 'asc' },
        { sortOrder: 'asc' },
        { fieldName: 'asc' },
      ],
    }),
  ]);

  const flowOrder = new Map(FLOW_ORDER.map((flowStep, index) => [flowStep, index]));
  const sortedFlows = [...flows].sort((a, b) => {
    const aOrder = flowOrder.get(a.flowStep) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = flowOrder.get(b.flowStep) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder || a.priority - b.priority || a.flowStep.localeCompare(b.flowStep);
  });
  const sortedFields = [...fields].sort((a, b) => {
    const aOrder = flowOrder.get(a.flowStep) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = flowOrder.get(b.flowStep) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder
      || a.fieldLocation.localeCompare(b.fieldLocation)
      || a.sortOrder - b.sortOrder
      || a.fieldName.localeCompare(b.fieldName);
  });

  return { flows: sortedFlows, fields: sortedFields };
}

export async function createRuleField(input: RuleFieldInput): Promise<unknown> {
  const data = normalizeRuleFieldInput(input);
  const prisma = getPrismaClient();
  const flow = await prisma.flowIdentifier.findUnique({
    where: { standard_flowStep: { standard: data.standard, flowStep: data.flowStep } },
  });
  if (!flow) throw new Error('flowStep not found');

  const field = await prisma.flowRuleField.create({ data });
  await Promise.all([reloadRulesFromDb(), touchRulesUpdatedAt()]);
  return field;
}

export async function updateRuleField(id: string, input: RuleFieldInput): Promise<unknown> {
  const data = normalizeRuleFieldInput(input);
  const prisma = getPrismaClient();
  const flow = await prisma.flowIdentifier.findUnique({
    where: { standard_flowStep: { standard: data.standard, flowStep: data.flowStep } },
  });
  if (!flow) throw new Error('flowStep not found');

  const field = await prisma.flowRuleField.update({ where: { id }, data });
  await Promise.all([reloadRulesFromDb(), touchRulesUpdatedAt()]);
  return field;
}

export async function deleteRuleField(id: string): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.flowRuleField.delete({ where: { id } });
  await Promise.all([reloadRulesFromDb(), touchRulesUpdatedAt()]);
}

export async function updateFlowIdentifier(standard: string, flowStep: string, input: FlowIdentifierInput): Promise<unknown> {
  if (!isStandard(standard)) throw new Error('invalid standard');
  const data = normalizeFlowIdentifierInput(input);
  const prisma = getPrismaClient();
  const flow = await prisma.flowIdentifier.update({
    where: { standard_flowStep: { standard, flowStep } },
    data,
  });
  await Promise.all([reloadRulesFromDb(), touchRulesUpdatedAt()]);
  return flow;
}
