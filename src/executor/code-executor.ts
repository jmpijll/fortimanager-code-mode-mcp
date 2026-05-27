/**
 * Code Executor — Run code that calls the live FortiManager API
 *
 * Injects a `fortimanager` global with a `request()` method that proxies
 * JSON-RPC calls from the sandbox to the host FMG client.
 *
 * Uses the async variant of QuickJS so sandbox code can `await` API calls.
 */

import {
  newAsyncContext,
  shouldInterruptAfterDeadline,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from 'quickjs-emscripten';
import type { FmgClient } from '../client/fmg-client.js';
import type { FmgRequestParams } from '../client/types.js';
import {
  DEFAULT_EXECUTOR_OPTIONS,
  type ExecuteResult,
  type ExecutorOptions,
  type LogEntry,
} from './types.js';

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum number of API calls per single execute() invocation */
const MAX_API_CALLS_PER_EXECUTION = 50;

/** Maximum total log size in bytes before truncation */
const MAX_LOG_SIZE_BYTES = 1_048_576; // 1 MB

/** Maximum number of log entries */
const MAX_LOG_ENTRIES = 1_000;

/** Allowed FMG JSON-RPC methods */
const ALLOWED_METHODS = new Set([
  'get',
  'set',
  'add',
  'update',
  'delete',
  'exec',
  'clone',
  'move',
  'replace',
]);

// ─── Code Executor ──────────────────────────────────────────────────

export class CodeExecutor {
  private readonly client: FmgClient;
  private readonly options: Required<ExecutorOptions>;

  constructor(client: FmgClient, options?: ExecutorOptions) {
    this.client = client;
    this.options = { ...DEFAULT_EXECUTOR_OPTIONS, ...options };
  }

  /**
   * Execute JavaScript code that can call the FortiManager API.
   *
   * Inside the sandbox, `fortimanager.request(method, params)` is available.
   * It takes a JSON-RPC method and params array, proxies the call to the
   * host FMG client, and returns the response.
   *
   * `opts.fmgToken` — if supplied, every FortiManager call made from inside
   * the sandbox uses this token in the `Authorization` header for this
   * execution only, instead of the client's configured token. Used by the
   * HTTP transport when `MCP_TOKEN_PASSTHROUGH=true` to forward a per-MCP-
   * client token to FortiManager.
   */
  async execute(code: string, opts?: { fmgToken?: string }): Promise<ExecuteResult> {
    const startTime = Date.now();
    const logs: LogEntry[] = [];

    // Create an isolated async context (separate WASM module)
    const context = await newAsyncContext();
    const runtime = context.runtime;

    try {
      // Configure resource limits
      runtime.setMemoryLimit(this.options.maxMemoryBytes);
      runtime.setMaxStackSize(512 * 1024);
      runtime.setInterruptHandler(
        shouldInterruptAfterDeadline(Date.now() + this.options.timeoutMs),
      );

      // Wire up console
      this.setupConsole(context, logs);

      // Inject fortimanager.request() proxy
      this.setupFortiManagerProxy(context, opts?.fmgToken);

      // Evaluate the code (async — supports await)
      const result = await context.evalCodeAsync(code, 'sandbox.js', { type: 'global' });

      if (result.error) {
        const errorValue: unknown = context.dump(result.error);
        result.error.dispose();

        return {
          ok: false,
          error: formatError(errorValue),
          logs,
          durationMs: Date.now() - startTime,
        };
      }

      const value: unknown = context.dump(result.value);
      result.value.dispose();

      return {
        ok: true,
        data: value,
        logs,
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        logs,
        durationMs: Date.now() - startTime,
      };
    } finally {
      context.dispose();
      runtime.dispose();
    }
  }

  // ── Console Capture ─────────────────────────────────────────────

  private setupConsole(context: QuickJSAsyncContext, logs: LogEntry[]): void {
    const consoleObj = context.newObject();
    let totalLogSize = 0;

    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      const fn = context.newFunction(level, (...args: QuickJSHandle[]) => {
        // Enforce log limits
        if (logs.length >= MAX_LOG_ENTRIES || totalLogSize >= MAX_LOG_SIZE_BYTES) {
          return;
        }

        const parts = args.map((a) => {
          try {
            return stringifyValue(context.dump(a));
          } catch {
            return '[unserializable]';
          }
        });

        const message = parts.join(' ');
        totalLogSize += message.length;

        if (totalLogSize > MAX_LOG_SIZE_BYTES) {
          logs.push({
            level: 'warn',
            message: `[log output truncated — exceeded ${String(MAX_LOG_SIZE_BYTES)} byte limit]`,
            timestamp: Date.now(),
          });
          return;
        }

        logs.push({
          level,
          message,
          timestamp: Date.now(),
        });
      });

      context.setProp(consoleObj, level, fn);
      fn.dispose();
    }

    context.setProp(context.global, 'console', consoleObj);
    consoleObj.dispose();
  }

  // ── FortiManager Proxy ──────────────────────────────────────────

  private setupFortiManagerProxy(context: QuickJSAsyncContext, tokenOverride?: string): void {
    const fmgObj = context.newObject();

    // Track API call count to prevent runaway loops
    let apiCallCount = 0;

    // fortimanager.request(method, params) -> Promise<response>
    const requestFn = context.newAsyncifiedFunction(
      'request',
      async (methodHandle: QuickJSHandle, paramsHandle: QuickJSHandle) => {
        // Enforce call limit
        apiCallCount++;
        if (apiCallCount > MAX_API_CALLS_PER_EXECUTION) {
          throw new Error(
            `API call limit exceeded (max ${String(MAX_API_CALLS_PER_EXECUTION)} calls per execution). ` +
              'Use more targeted queries or batch multiple URLs in a single request.',
          );
        }

        const method = context.getString(methodHandle);
        const params: unknown = context.dump(paramsHandle);

        // Validate method
        if (!ALLOWED_METHODS.has(method)) {
          throw new Error(
            `Invalid method "${method}". Allowed: ${[...ALLOWED_METHODS].join(', ')}`,
          );
        }

        // Validate params is an array with url fields
        if (!Array.isArray(params)) {
          throw new Error(
            'params must be an array of objects, each with at least a "url" string field.',
          );
        }
        for (const p of params) {
          const pObj = p as Record<string, unknown> | null;
          if (!pObj || typeof pObj !== 'object' || typeof pObj['url'] !== 'string') {
            throw new Error('Each param must be an object with at least a "url" string field.');
          }
        }

        const validatedParams = params as FmgRequestParams[];

        try {
          const response = await this.client.rawRequest(
            method as import('../client/types.js').FmgMethod,
            validatedParams,
            tokenOverride ? { tokenOverride } : undefined,
          );
          const responseJson = JSON.stringify(response);
          const responseStr = context.newString(responseJson);
          const parseExpr = context.evalCode('JSON.parse');

          if (parseExpr.error) {
            parseExpr.error.dispose();
            responseStr.dispose();
            return context.newError('Failed to parse response in sandbox');
          }

          const parsed = context.callFunction(parseExpr.value, context.undefined, responseStr);
          parseExpr.value.dispose();
          responseStr.dispose();

          if (parsed.error) {
            const err = context.newError('Failed to parse response');
            parsed.error.dispose();
            return err;
          }

          return parsed.value;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(message);
        }
      },
    );

    context.setProp(fmgObj, 'request', requestFn);
    requestFn.dispose();

    context.setProp(context.global, 'fortimanager', fmgObj);
    fmgObj.dispose();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatError(errorValue: unknown): string {
  if (typeof errorValue === 'string') return errorValue;
  if (errorValue && typeof errorValue === 'object') {
    const err = errorValue as Record<string, unknown>;
    const name = typeof err['name'] === 'string' ? err['name'] : 'Error';
    const message = typeof err['message'] === 'string' ? err['message'] : 'Unknown error';
    const stack = typeof err['stack'] === 'string' ? err['stack'] : undefined;
    if (stack) {
      return `${name}: ${message}\n${stack}`;
    }
    return `${name}: ${message}`;
  }
  return String(errorValue);
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value === 'object' ? '[object]' : String(value as string);
  }
}
