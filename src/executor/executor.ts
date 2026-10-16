/**
 * Base QuickJS Sandbox Executor
 *
 * Provides the core sandbox lifecycle:
 * - Create QuickJS runtime + context with memory/CPU limits
 * - Wire up console capture
 * - Evaluate code and collect results
 * - Clean up handles and dispose resources
 */

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import {
  DEFAULT_EXECUTOR_OPTIONS,
  type ExecuteResult,
  type ExecutorOptions,
  type LogEntry,
} from './types.js';

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum total log size in bytes before truncation */
const MAX_LOG_SIZE_BYTES = 1_048_576; // 1 MB

/** Maximum number of log entries */
const MAX_LOG_ENTRIES = 1_000;

// ─── Singleton WASM Module ──────────────────────────────────────────

let quickJSModule: QuickJSWASMModule | null = null;

/** Get or initialize the shared QuickJS WASM module (singleton) */
export async function getQuickJSModule(): Promise<QuickJSWASMModule> {
  quickJSModule ??= await getQuickJS();
  return quickJSModule;
}

// ─── Base Executor ──────────────────────────────────────────────────

export abstract class BaseExecutor {
  protected options: Required<ExecutorOptions>;

  constructor(options?: ExecutorOptions) {
    this.options = { ...DEFAULT_EXECUTOR_OPTIONS, ...options };
  }

  /**
   * Execute JavaScript code in the sandbox.
   * Subclasses must implement `setupContext` to inject globals.
   */
  async execute(code: string): Promise<ExecuteResult> {
    const startTime = Date.now();
    const logs: LogEntry[] = [];

    const quickJS = await getQuickJSModule();
    const runtime = quickJS.newRuntime();
    const context = runtime.newContext();

    try {
      // Configure resource limits
      this.configureLimits(runtime);

      // Wire up console capture
      this.setupConsole(context, logs);

      // Let subclass inject globals (spec data, fortimanager proxy, etc.)
      await this.setupContext(context, runtime);

      // Evaluate the code
      const result = context.evalCode(code, 'sandbox.js', { type: 'global' });

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

  /**
   * Subclasses implement this to inject sandbox globals.
   * Called after console is set up, before code evaluation.
   */
  protected abstract setupContext(
    context: QuickJSContext,
    runtime: QuickJSRuntime,
  ): Promise<void> | void;

  // ── Resource Limits ─────────────────────────────────────────────

  private configureLimits(runtime: QuickJSRuntime): void {
    runtime.setMemoryLimit(this.options.maxMemoryBytes);
    runtime.setMaxStackSize(512 * 1024); // 512 KB stack

    const deadline = Date.now() + this.options.timeoutMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  }

  // ── Console Capture ─────────────────────────────────────────────

  private setupConsole(context: QuickJSContext, logs: LogEntry[]): void {
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
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Format an error value dumped from QuickJS into a string */
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

/** Stringify a value for console log output */
function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    // JSON.stringify only throws for BigInt values and circular structures
    return typeof value === 'bigint' ? value.toString() : '[object]';
  }
}
