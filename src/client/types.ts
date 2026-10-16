/**
 * FortiManager JSON-RPC Client — Type Definitions
 *
 * Types for JSON-RPC requests, responses, error codes,
 * and FMG-specific method/URL patterns.
 */

// ─── JSON-RPC Base Types ────────────────────────────────────────────

/** JSON-RPC 2.0-style request (FMG uses a simplified variant) */
export interface JsonRpcRequest {
  id: number;
  method: FmgMethod;
  params: FmgRequestParams[];
  session?: string | null;
  verbose?: 0 | 1;
}

/** Individual parameter block within a JSON-RPC request */
export interface FmgRequestParams {
  url: string;
  data?: unknown;
  option?: FmgOption | FmgOption[];
  filter?: FmgFilter;
  fields?: string[];
  sortings?: FmgSorting[];
  range?: [number, number];
  loadsub?: 0 | 1;
  limit?: number;
  'sub fetch'?: number;
  extra_info?: 0 | 1;
  confirm?: 0 | 1;
  meta_fields?: string[];
}

/** JSON-RPC response envelope */
export interface JsonRpcResponse<T = unknown> {
  id: number;
  result: FmgResponseResult<T>[];
  session?: string;
}

/** Individual result block within a JSON-RPC response */
export interface FmgResponseResult<T = unknown> {
  status: FmgStatus;
  url: string;
  data?: T;
}

/** Status block in response */
export interface FmgStatus {
  code: number;
  message: string;
}

// ─── FMG Methods ────────────────────────────────────────────────────

/** Supported JSON-RPC methods */
export type FmgMethod =
  'get' | 'set' | 'add' | 'update' | 'delete' | 'exec' | 'clone' | 'move' | 'replace';

// ─── FMG Options ────────────────────────────────────────────────────

/** Request option flags (used in the `option` parameter) */
export type FmgOption =
  | 'count'
  | 'object member'
  | 'datasrc'
  | 'chksum'
  | 'syntax'
  | 'loadsub'
  | 'devinfo'
  | 'scope member'
  | 'get reserved';

// ─── Filter Types ───────────────────────────────────────────────────

/** Filter expression — can be a simple tuple or nested array */
export type FmgFilter = FmgFilterTuple | FmgFilterExpression;

/** Simple filter: [field, operator, value] */
export type FmgFilterTuple = [string, FmgFilterOperator, FmgFilterValue];

/** Compound filter with logical operators */
export type FmgFilterExpression = (FmgFilterTuple | '&&' | '||')[];

/** Filter operators */
export type FmgFilterOperator =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'not in'
  | 'like'
  | 'not like'
  | 'contain'
  | 'not contain';

/** Filter value */
export type FmgFilterValue = string | number | boolean | string[] | number[];

// ─── Sorting ────────────────────────────────────────────────────────

/** Sorting specification */
export interface FmgSorting {
  [field: string]: 1 | -1;
}

// ─── Client Configuration ───────────────────────────────────────────

/** Configuration for the FortiManager client */
export interface FmgClientConfig {
  /** FortiManager host URL (e.g., https://fmg.example.com) */
  host: string;
  /** HTTPS port (default: 443) */
  port: number;
  /** API token for authentication */
  apiToken: string;
  /** Whether to verify TLS certificates (default: true) */
  verifySsl: boolean;
}

/** Authentication mode */
export type FmgAuthMode = 'token' | 'session';

// ─── Error Codes ────────────────────────────────────────────────────

/** Common FMG JSON-RPC error codes */
export const FMG_ERROR_CODES = {
  SUCCESS: 0,
  INVALID_URL: -2,
  NO_PERMISSION: -6,
  OBJECT_ALREADY_EXISTS: -9,
  OBJECT_NOT_FOUND: -10,
  SESSION_TIMEOUT: -11,
  INVALID_SESSION: -12,
  WORKSPACE_LOCKED: -20,
  DEVICE_NOT_FOUND: -36,
  UNKNOWN_ERROR: -1,
} as const;

/** Map error codes to human-readable descriptions */
export const FMG_ERROR_MESSAGES: Record<number, string> = {
  [FMG_ERROR_CODES.SUCCESS]: 'Success',
  [FMG_ERROR_CODES.INVALID_URL]: 'Invalid URL or object not found',
  [FMG_ERROR_CODES.NO_PERMISSION]: 'No permission for this operation',
  [FMG_ERROR_CODES.OBJECT_ALREADY_EXISTS]: 'Object already exists',
  [FMG_ERROR_CODES.OBJECT_NOT_FOUND]: 'Object not found',
  [FMG_ERROR_CODES.SESSION_TIMEOUT]: 'Session timed out',
  [FMG_ERROR_CODES.INVALID_SESSION]: 'Invalid session ID',
  [FMG_ERROR_CODES.WORKSPACE_LOCKED]: 'Workspace is locked by another session',
  [FMG_ERROR_CODES.DEVICE_NOT_FOUND]: 'Device not found',
  [FMG_ERROR_CODES.UNKNOWN_ERROR]: 'Unknown error',
};

// ─── Custom Error Class ─────────────────────────────────────────────

/** Error thrown by the FMG client with structured context */
export class FmgApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly url: string,
    public readonly method: FmgMethod,
    public readonly response?: FmgStatus,
  ) {
    super(`FMG API Error [${statusCode}]: ${message} (method=${method}, url=${url})`);
    this.name = 'FmgApiError';
  }
}

/** Error thrown when the HTTP transport fails */
export class FmgTransportError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly endpoint?: string,
  ) {
    super(`FMG Transport Error: ${message}`);
    this.name = 'FmgTransportError';
  }
}
