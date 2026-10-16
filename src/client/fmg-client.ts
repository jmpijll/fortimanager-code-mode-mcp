/**
 * FortiManager JSON-RPC Client
 *
 * Stateless HTTP client for FortiManager's JSON-RPC API (`POST /jsonrpc`).
 * Supports request multiplexing (multiple params in a single request),
 * and all standard FMG methods: get, set, add, update, delete, exec, clone, move.
 */

import type { Dispatcher } from 'undici';
import { type AuthProvider, createAuthProvider } from './auth.js';
import {
  FmgApiError,
  FmgTransportError,
  type FmgClientConfig,
  type FmgMethod,
  type FmgRequestParams,
  type FmgResponseResult,
  type FmgStatus,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './types.js';

// ─── Client ─────────────────────────────────────────────────────────

/** Default HTTP request timeout in milliseconds */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Maximum request ID before wrapping */
const MAX_REQUEST_ID = 1_000_000_000;

/** Response surface the client needs; satisfied by both fetch implementations */
interface FetchedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

/** Request init shared by both fetch implementations (no version-specific fields) */
interface FetchedRequestInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export class FmgClient {
  private readonly endpoint: string;
  private readonly auth: AuthProvider;
  private readonly verifySsl: boolean;
  private readonly requestTimeoutMs: number;
  private requestId = 0;

  /** Cached undici Agent for SSL bypass — created lazily, reused across requests */
  private unsafeDispatcher: Dispatcher | null = null;

  constructor(
    private readonly config: FmgClientConfig,
    auth?: AuthProvider,
  ) {
    this.endpoint = `${config.host}:${config.port}/jsonrpc`;
    this.auth = auth ?? createAuthProvider(config);
    this.verifySsl = config.verifySsl;
    this.requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  }

  // ── Public API Methods ──────────────────────────────────────────

  /** GET — Retrieve object(s) at the given URL */
  async get<T = unknown>(url: string, params?: Partial<FmgRequestParams>): Promise<T> {
    return this.singleRequest<T>('get', { url, ...params });
  }

  /** SET — Replace object(s) at the given URL */
  async set<T = unknown>(
    url: string,
    data: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('set', { url, data, ...params });
  }

  /** ADD — Create new object(s) at the given URL */
  async add<T = unknown>(
    url: string,
    data: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('add', { url, data, ...params });
  }

  /** UPDATE — Partially update object(s) at the given URL */
  async update<T = unknown>(
    url: string,
    data: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('update', { url, data, ...params });
  }

  /** DELETE — Remove object(s) at the given URL */
  async delete<T = unknown>(url: string, params?: Partial<FmgRequestParams>): Promise<T> {
    return this.singleRequest<T>('delete', { url, ...params });
  }

  /** EXEC — Execute a command at the given URL */
  async exec<T = unknown>(
    url: string,
    data?: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('exec', { url, data, ...params });
  }

  /** CLONE — Clone an object at the given URL */
  async clone<T = unknown>(
    url: string,
    data: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('clone', { url, data, ...params });
  }

  /** MOVE — Move an object at the given URL */
  async move<T = unknown>(
    url: string,
    data: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('move', { url, data, ...params });
  }

  // ── Request Multiplexing ────────────────────────────────────────

  /**
   * Send a batch of parameter blocks in a single JSON-RPC request.
   * FMG supports multiple `params` entries in one call.
   */
  async batch<T = unknown>(
    method: FmgMethod,
    paramsList: FmgRequestParams[],
  ): Promise<FmgResponseResult<T>[]> {
    const request = this.buildRequest(method, paramsList);
    const response = await this.sendRequest<T>(request);
    return response.result;
  }

  // ── Raw Request Access ──────────────────────────────────────────

  /**
   * Send a raw JSON-RPC request. Useful for advanced use cases
   * or when called from the sandbox executor.
   *
   * `opts.tokenOverride` — if supplied, this token is used in the
   * `Authorization: Bearer …` header for just this request instead of
   * the configured auth provider's token. Lets the HTTP transport thread
   * a per-MCP-client FortiManager token down through the executor without
   * having to construct a whole new `FmgClient` (and a new undici Agent)
   * per request. See `MCP_TOKEN_PASSTHROUGH` in `src/config.ts`.
   */
  async rawRequest<T = unknown>(
    method: FmgMethod,
    params: FmgRequestParams[],
    opts?: { tokenOverride?: string },
  ): Promise<JsonRpcResponse<T>> {
    const request = this.buildRequest(method, params);
    return this.sendRequest<T>(request, opts?.tokenOverride);
  }

  // ── Health Check ────────────────────────────────────────────────

  /** Check connectivity by fetching system status */
  async checkHealth(): Promise<{ connected: boolean; version?: string; hostname?: string }> {
    try {
      const data = await this.get<Record<string, string>>('/sys/status');
      return {
        connected: true,
        version: data['Version'],
        hostname: data['Hostname'],
      };
    } catch {
      return { connected: false };
    }
  }

  // ── Internal Methods ────────────────────────────────────────────

  /** Build a JSON-RPC request envelope */
  private buildRequest(method: FmgMethod, params: FmgRequestParams[]): JsonRpcRequest {
    this.requestId = (this.requestId + 1) % MAX_REQUEST_ID;
    return {
      id: this.requestId,
      method,
      params,
      session: this.auth.getSession(),
    };
  }

  /** Send a single-param request and extract the first result's data */
  private async singleRequest<T>(method: FmgMethod, params: FmgRequestParams): Promise<T> {
    const request = this.buildRequest(method, [params]);
    const response = await this.sendRequest<T>(request);

    const result = response.result[0];
    if (!result) {
      throw new FmgApiError('Empty result array', -1, params.url, method);
    }

    this.checkStatus(result.status, params.url, method);

    return result.data as T;
  }

  /** Execute the HTTP request to FortiManager */
  private async sendRequest<T>(
    request: JsonRpcRequest,
    tokenOverride?: string,
  ): Promise<JsonRpcResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(tokenOverride
        ? { Authorization: `Bearer ${tokenOverride}` }
        : this.auth.getAuthHeaders()),
    };

    const init: FetchedRequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    };

    // A TLS-bypass Agent only works with a fetch from the same undici instance;
    // Node's bundled fetch rejects Agents from other versions (undici 8 breaks
    // the dispatcher handler API), so that path loads both from the installed
    // undici. The verifying path keeps using the built-in fetch and no Agent.
    const send: () => Promise<FetchedResponse> = this.verifySsl
      ? () => fetch(this.endpoint, init)
      : await this.createInsecureSender(init);

    let httpResponse: FetchedResponse;
    try {
      httpResponse = await send();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      // fetch() hides the real TLS/network failure in `cause`; surface it
      const cause =
        err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
      throw new FmgTransportError(
        isTimeout
          ? `Request to ${this.endpoint} timed out after ${String(this.requestTimeoutMs)}ms`
          : `Failed to connect to ${this.endpoint}: ${message}${cause}`,
        undefined,
        this.endpoint,
      );
    }

    if (!httpResponse.ok) {
      throw new FmgTransportError(
        `HTTP ${httpResponse.status} ${httpResponse.statusText}`,
        httpResponse.status,
        this.endpoint,
      );
    }

    // Parse and validate response shape
    const body: unknown = await httpResponse.json();
    const bodyObj = body as Record<string, unknown> | null;

    if (!bodyObj || typeof bodyObj !== 'object' || !Array.isArray(bodyObj['result'])) {
      throw new FmgTransportError(
        'Invalid JSON-RPC response: missing or non-array "result" field',
        httpResponse.status,
        this.endpoint,
      );
    }

    return bodyObj as unknown as JsonRpcResponse<T>;
  }

  /** Throw FmgApiError if status code indicates failure */
  private checkStatus(status: FmgStatus, url: string, method: FmgMethod): void {
    if (status.code !== 0) {
      throw new FmgApiError(status.message, status.code, url, method, status);
    }
  }

  /**
   * Build a sender that skips TLS verification.
   * Only used when FMG_VERIFY_SSL=false (e.g., self-signed certs in lab environments).
   * The Agent is cached and reused across requests.
   */
  private async createInsecureSender(
    init: FetchedRequestInit,
  ): Promise<() => Promise<FetchedResponse>> {
    let undici: typeof import('undici');
    try {
      undici = await import('undici');
    } catch {
      throw new FmgTransportError(
        'Cannot disable SSL verification: undici package not available. ' +
          'Install undici (npm i undici) or set FMG_VERIFY_SSL=true.',
        undefined,
        this.endpoint,
      );
    }

    const dispatcher = (this.unsafeDispatcher ??= new undici.Agent({
      connect: { rejectUnauthorized: false },
    }));

    return () => undici.fetch(this.endpoint, { ...init, dispatcher });
  }
}
