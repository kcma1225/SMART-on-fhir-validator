export type FlowStep = string;

export type FieldStatus = 'PASS' | 'FAIL' | 'SKIP';

export type FieldLocation = 'query_params' | 'body_params' | 'headers' | 'response_body';

export interface PrismConnection {
  id: string;
  institution_id: number | null;
  user_id: number | null;
  req_method: string;
  req_url: string;
  req_headers: Record<string, string> | null;
  req_body: string | null;
  res_body: string | null;
}

export interface FieldResult {
  field: string;
  location: FieldLocation;
  required: boolean;
  status: FieldStatus;
  detail?: string;
}

export interface ValidationOutput {
  connectionId: string;
  institutionId: number | null;
  userId: number | null;
  flowStep: FlowStep;
  results: FieldResult[];
}

export interface CheckFields {
  required?: string[];
  optional?: string[];
  conditional?: string[];
  patterns?: Record<string, string>;
}

export interface IdentifyCondition {
  method: string;
  url_contains: string;
  body_contains?: Record<string, string>;
}

export interface FlowRule {
  description: string;
  identify: IdentifyCondition;
  check: {
    query_params?: CheckFields;
    body_params?: CheckFields;
    headers?: CheckFields;
    response_body?: CheckFields;
  };
}

export interface RulesConfig {
  flows: Record<string, FlowRule>;
}
