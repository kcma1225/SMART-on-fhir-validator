import { getPrismaClient } from './db/validator';
import type { RulesConfig, FlowRule } from './types';

let cachedRules: RulesConfig | null = null;

const FIELD_LOCATIONS = ['query_params', 'body_params', 'headers', 'response_body'];
const FIELD_TYPES = ['required', 'conditional', 'optional'];
const FLOW_ORDER = [
  'smart_metadata',
  'authorization_request',
  'token_request_auth_code',
  'token_request_client_cred',
  'fhir_request',
  'token_request_refresh',
];

export interface RuleFieldInput {
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
  { flowStep: 'smart_metadata',            description: 'SMART 服務聲明 Metadata 請求 (Step 70)',                                  method: 'GET',  urlContains: '/.well-known/smart-configuration',       bodyGrantType: null,                 priority: 1 },
  { flowStep: 'authorization_request',     description: 'OAuth Authorization Endpoint 請求 (AppLaunch Step 200)',                  method: 'GET',  urlContains: '/protocol/openid-connect/auth',          bodyGrantType: null,                 priority: 2 },
  { flowStep: 'token_request_auth_code',   description: 'Token Endpoint 請求 — Authorization Code Flow (AppLaunch Step 210)',       method: 'POST', urlContains: '/protocol/openid-connect/token',         bodyGrantType: 'authorization_code', priority: 3 },
  { flowStep: 'token_request_client_cred', description: 'Token Endpoint 請求 — Client Credentials Flow (BackendServices Step 200)', method: 'POST', urlContains: '/protocol/openid-connect/token',         bodyGrantType: 'client_credentials', priority: 4 },
  { flowStep: 'fhir_request',              description: 'FHIR Resource 存取請求 (Step 300)',                                       method: '*',    urlContains: '/fhir',                                  bodyGrantType: null,                 priority: 5 },
  { flowStep: 'token_request_refresh',     description: 'Token Endpoint 請求 — Refresh Token Flow (AppLaunch Step 310)',            method: 'POST', urlContains: '/protocol/openid-connect/token',         bodyGrantType: 'refresh_token',      priority: 6 },
];

const DEFAULT_FIELDS = [
  // smart_metadata — response_body
  { flowStep: 'smart_metadata', fieldName: 'grant_types_supported',            fieldLocation: 'response_body', fieldType: 'required',    pattern: null, sortOrder: 0 },
  { flowStep: 'smart_metadata', fieldName: 'token_endpoint',                   fieldLocation: 'response_body', fieldType: 'required',    pattern: null, sortOrder: 1 },
  { flowStep: 'smart_metadata', fieldName: 'capabilities',                     fieldLocation: 'response_body', fieldType: 'required',    pattern: null, sortOrder: 2 },
  { flowStep: 'smart_metadata', fieldName: 'code_challenge_methods_supported', fieldLocation: 'response_body', fieldType: 'required',    pattern: null, sortOrder: 3 },
  { flowStep: 'smart_metadata', fieldName: 'issuer',                           fieldLocation: 'response_body', fieldType: 'conditional', pattern: null, sortOrder: 4 },
  { flowStep: 'smart_metadata', fieldName: 'jwks_uri',                         fieldLocation: 'response_body', fieldType: 'conditional', pattern: null, sortOrder: 5 },
  { flowStep: 'smart_metadata', fieldName: 'authorization_endpoint',           fieldLocation: 'response_body', fieldType: 'conditional', pattern: null, sortOrder: 6 },
  { flowStep: 'smart_metadata', fieldName: 'token_endpoint_auth_methods_supported', fieldLocation: 'response_body', fieldType: 'optional', pattern: null, sortOrder: 7 },
  { flowStep: 'smart_metadata', fieldName: 'registration_endpoint',            fieldLocation: 'response_body', fieldType: 'optional',    pattern: null, sortOrder: 8 },
  { flowStep: 'smart_metadata', fieldName: 'introspection_endpoint',           fieldLocation: 'response_body', fieldType: 'optional',    pattern: null, sortOrder: 9 },
  { flowStep: 'smart_metadata', fieldName: 'revocation_endpoint',              fieldLocation: 'response_body', fieldType: 'optional',    pattern: null, sortOrder: 10 },
  { flowStep: 'smart_metadata', fieldName: 'scopes_supported',                 fieldLocation: 'response_body', fieldType: 'optional',    pattern: null, sortOrder: 11 },
  { flowStep: 'smart_metadata', fieldName: 'response_types_supported',         fieldLocation: 'response_body', fieldType: 'optional',    pattern: null, sortOrder: 12 },

  // token_request_refresh — body_params
  { flowStep: 'token_request_refresh', fieldName: 'grant_type',    fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 0 },
  { flowStep: 'token_request_refresh', fieldName: 'refresh_token', fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 1 },
  { flowStep: 'token_request_refresh', fieldName: 'scope',         fieldLocation: 'body_params', fieldType: 'optional', pattern: null, sortOrder: 2 },

  // token_request_client_cred — body_params
  { flowStep: 'token_request_client_cred', fieldName: 'grant_type',            fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 0 },
  { flowStep: 'token_request_client_cred', fieldName: 'scope',                 fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 1 },
  { flowStep: 'token_request_client_cred', fieldName: 'client_assertion_type', fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 2 },
  { flowStep: 'token_request_client_cred', fieldName: 'client_assertion',      fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 3 },

  // token_request_auth_code — body_params
  { flowStep: 'token_request_auth_code', fieldName: 'grant_type',   fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 0 },
  { flowStep: 'token_request_auth_code', fieldName: 'code',         fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 1 },
  { flowStep: 'token_request_auth_code', fieldName: 'redirect_uri', fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 2 },
  { flowStep: 'token_request_auth_code', fieldName: 'code_verifier',fieldLocation: 'body_params', fieldType: 'required', pattern: null, sortOrder: 3 },
  { flowStep: 'token_request_auth_code', fieldName: 'client_id',    fieldLocation: 'body_params', fieldType: 'optional', pattern: null, sortOrder: 4 },

  // authorization_request — query_params
  { flowStep: 'authorization_request', fieldName: 'response_type',        fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 0 },
  { flowStep: 'authorization_request', fieldName: 'client_id',            fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 1 },
  { flowStep: 'authorization_request', fieldName: 'redirect_uri',         fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 2 },
  { flowStep: 'authorization_request', fieldName: 'scope',                fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 3 },
  { flowStep: 'authorization_request', fieldName: 'state',                fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 4 },
  { flowStep: 'authorization_request', fieldName: 'aud',                  fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 5 },
  { flowStep: 'authorization_request', fieldName: 'code_challenge',       fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 6 },
  { flowStep: 'authorization_request', fieldName: 'code_challenge_method',fieldLocation: 'query_params', fieldType: 'required', pattern: null, sortOrder: 7 },
  { flowStep: 'authorization_request', fieldName: 'launch',               fieldLocation: 'query_params', fieldType: 'optional', pattern: null, sortOrder: 8 },

  // fhir_request — headers
  { flowStep: 'fhir_request', fieldName: 'Authorization', fieldLocation: 'headers', fieldType: 'required', pattern: '^Bearer .+', sortOrder: 0 },
];

function normalizeRuleFieldInput(input: RuleFieldInput): RuleFieldInput {
  const flowStep = input.flowStep.trim();
  const fieldName = input.fieldName.trim();
  const fieldLocation = input.fieldLocation.trim();
  const fieldType = input.fieldType.trim();
  const pattern = input.pattern?.trim() || null;
  const sortOrder = Number(input.sortOrder ?? 0);

  if (!flowStep) throw new Error('flowStep required');
  if (!fieldName) throw new Error('fieldName required');
  if (!FIELD_LOCATIONS.includes(fieldLocation)) throw new Error('invalid fieldLocation');
  if (!FIELD_TYPES.includes(fieldType)) throw new Error('invalid fieldType');
  if (!Number.isFinite(sortOrder)) throw new Error('invalid sortOrder');

  return { flowStep, fieldName, fieldLocation, fieldType, pattern, sortOrder };
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

async function buildRulesConfig(): Promise<RulesConfig> {
  const prisma = getPrismaClient();
  const [identifiers, fields] = await Promise.all([
    prisma.flowIdentifier.findMany({ orderBy: { priority: 'asc' } }),
    prisma.flowRuleField.findMany({ orderBy: { sortOrder: 'asc' } }),
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
      const patterns: Record<string, string> = {};
      for (const f of locFields) {
        if (f.pattern) patterns[f.fieldName] = f.pattern;
      }

      check[loc] = {
        ...(required.length    ? { required }    : {}),
        ...(conditional.length ? { conditional } : {}),
        ...(optional.length    ? { optional }    : {}),
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

// ── Public API ────────────────────────────────────────────────────────────────

export async function initRules(): Promise<void> {
  const prisma = getPrismaClient();
  const count = await prisma.flowIdentifier.count();

  if (count === 0) {
    for (const ident of DEFAULT_IDENTIFIERS) {
      await prisma.flowIdentifier.create({ data: ident });
    }
    await prisma.flowRuleField.createMany({ data: DEFAULT_FIELDS });
    console.log('[rules-db] seeded default rules');
  } else {
    await Promise.all(
      DEFAULT_IDENTIFIERS.map(ident => prisma.flowIdentifier.updateMany({
        where: { flowStep: ident.flowStep },
        data: { priority: ident.priority },
      })),
    );
  }

  cachedRules = await buildRulesConfig();
  console.log('[rules-db] rules loaded from DB');
}

export function getCachedRules(): RulesConfig {
  if (!cachedRules) throw new Error('Rules not initialized — call initRules() first');
  return cachedRules;
}

export async function reloadRulesFromDb(): Promise<RulesConfig> {
  cachedRules = await buildRulesConfig();
  return cachedRules;
}

export async function listRuleDefinitions(): Promise<{ flows: unknown[]; fields: unknown[] }> {
  const prisma = getPrismaClient();
  const [flows, fields] = await Promise.all([
    prisma.flowIdentifier.findMany({ orderBy: { priority: 'asc' } }),
    prisma.flowRuleField.findMany({
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
  const flow = await prisma.flowIdentifier.findUnique({ where: { flowStep: data.flowStep } });
  if (!flow) throw new Error('flowStep not found');

  const field = await prisma.flowRuleField.create({ data });
  await reloadRulesFromDb();
  return field;
}

export async function updateRuleField(id: string, input: RuleFieldInput): Promise<unknown> {
  const data = normalizeRuleFieldInput(input);
  const prisma = getPrismaClient();
  const flow = await prisma.flowIdentifier.findUnique({ where: { flowStep: data.flowStep } });
  if (!flow) throw new Error('flowStep not found');

  const field = await prisma.flowRuleField.update({ where: { id }, data });
  await reloadRulesFromDb();
  return field;
}

export async function deleteRuleField(id: string): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.flowRuleField.delete({ where: { id } });
  await reloadRulesFromDb();
}

export async function updateFlowIdentifier(flowStep: string, input: FlowIdentifierInput): Promise<unknown> {
  const data = normalizeFlowIdentifierInput(input);
  const prisma = getPrismaClient();
  const flow = await prisma.flowIdentifier.update({
    where: { flowStep },
    data,
  });
  await reloadRulesFromDb();
  return flow;
}
