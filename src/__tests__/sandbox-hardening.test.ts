/**
 * Sandbox Hardening Tests — limits, async bridge, escapes, and disposal
 *
 * Behavioural coverage that must hold on quickjs-emscripten 0.31 and 0.32:
 * interrupts fire, memory limits reject oversized allocations, the asyncify
 * bridge delivers FortiManager responses, errors keep their shape, guest code
 * cannot reach the host, and repeated executions dispose cleanly.
 */

import { describe, it, expect, vi } from 'vitest';
import { CodeExecutor } from '../executor/code-executor.js';
import { SearchExecutor } from '../executor/search-executor.js';
import { FmgClient } from '../client/fmg-client.js';
import type { ExecuteResult, ExecutorOptions } from '../executor/types.js';
import { SAMPLE_CLIENT_CONFIG, SAMPLE_SPEC, makeSuccessResponse } from './fixtures/index.js';

// ─── Helpers ────────────────────────────────────────────────────────

const STATUS_DATA = { Version: '7.6.5', Hostname: 'fmg-01' };

/** Guest expression that calls the FMG bridge (fortimanager.request is injected) */
const GET_STATUS = `fortimanager.request('get', [{ url: '/sys/status' }])`;

function createMockClient(): FmgClient {
  const client = new FmgClient(SAMPLE_CLIENT_CONFIG);
  vi.spyOn(client, 'rawRequest');
  return client;
}

function mockStatusSuccess(client: FmgClient): void {
  vi.mocked(client.rawRequest).mockResolvedValue(
    makeSuccessResponse(1, '/sys/status', STATUS_DATA),
  );
}

function createCodeExecutor(client: FmgClient, options?: ExecutorOptions): CodeExecutor {
  return new CodeExecutor(client, options);
}

function createSearchExecutor(options?: ExecutorOptions): SearchExecutor {
  return new SearchExecutor(SAMPLE_SPEC, {
    timeoutMs: 5_000,
    maxMemoryBytes: 16 * 1024 * 1024,
    ...options,
  });
}

/** Run `expr` in the sandbox, returning its stringified value or caught error */
async function runCaught(
  executor: { execute(code: string): Promise<ExecuteResult> },
  expr: string,
) {
  const result = await executor.execute(
    `(() => { try { return String(${expr}); } catch (e) { return 'caught: ' + e.message; } })()`,
  );
  expect(result.ok).toBe(true);
  return result.data;
}

// ─── Execution Timeouts ─────────────────────────────────────────────

describe('execution timeouts', () => {
  it('interrupts an infinite loop in the sync search executor', async () => {
    const executor = createSearchExecutor({ timeoutMs: 300 });

    const start = Date.now();
    const result = await executor.execute('while(true){}');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('interrupted');
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('interrupts an infinite loop in the async code executor', async () => {
    const executor = createCodeExecutor(createMockClient(), { timeoutMs: 300 });

    const start = Date.now();
    const result = await executor.execute('while(true){}');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('interrupted');
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('interrupts a loop that starts after a fortimanager bridge call', async () => {
    const client = createMockClient();
    mockStatusSuccess(client);
    const executor = createCodeExecutor(client, { timeoutMs: 300 });

    const start = Date.now();
    const result = await executor.execute(`const r = ${GET_STATUS}; while(true){}`);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('interrupted');
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(client.rawRequest).toHaveBeenCalledTimes(1);
  });

  it('an infinite loop after an await never runs (post-await continuations are not driven)', async () => {
    // fortimanager.request is asyncified: the host call blocks the guest and
    // returns its value at the call site. `await` then schedules a microtask that
    // evalCodeAsync never drains, so the loop cannot run, hang, or escape the
    // deadline. Same behaviour on 0.31 and 0.32.
    const client = createMockClient();
    mockStatusSuccess(client);
    const executor = createCodeExecutor(client, { timeoutMs: 300 });

    const start = Date.now();
    const result = await executor.execute(`(async () => { await ${GET_STATUS}; while(true){} })()`);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ type: 'pending' });
    expect(result.logs).toHaveLength(0);
    expect(Date.now() - start).toBeLessThan(3_000);
  });
});

// ─── Memory Limit ───────────────────────────────────────────────────

describe('memory limit', () => {
  it('rejects an oversized allocation in the sync search executor and survives', async () => {
    const executor = createSearchExecutor({ maxMemoryBytes: 8 * 1024 * 1024 });

    const result = await executor.execute('new Uint8Array(32 * 1024 * 1024).length');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('out of memory');

    const next = await executor.execute('2 + 2');
    expect(next.ok).toBe(true);
    expect(next.data).toBe(4);
  });

  it('rejects an oversized allocation in the async code executor and survives', async () => {
    const executor = createCodeExecutor(createMockClient(), { maxMemoryBytes: 8 * 1024 * 1024 });

    const result = await executor.execute('new Uint8Array(32 * 1024 * 1024).length');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('out of memory');

    const next = await executor.execute('2 + 2');
    expect(next.ok).toBe(true);
    expect(next.data).toBe(4);
  });
});

// ─── Async Bridge ───────────────────────────────────────────────────

describe('async bridge (evalCodeAsync)', () => {
  it('delivers FortiManager response data from fortimanager.request', async () => {
    const client = createMockClient();
    mockStatusSuccess(client);
    const executor = createCodeExecutor(client);

    const result = await executor.execute(`const r = ${GET_STATUS}; r.result[0].data`);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(STATUS_DATA);
  });

  it('lets sandbox code catch a host rejection with try/catch around the bridge call', async () => {
    const client = createMockClient();
    vi.mocked(client.rawRequest).mockRejectedValueOnce(new Error('Connection refused'));
    const executor = createCodeExecutor(client);

    const result = await executor.execute(`
      try {
        ${GET_STATUS};
      } catch (e) {
        'caught: ' + e.message;
      }
    `);

    expect(result.ok).toBe(true);
    expect(result.data).toBe('caught: Connection refused');
  });

  it('lets sandbox code catch a host rejection around an awaited bridge call', async () => {
    const client = createMockClient();
    vi.mocked(client.rawRequest).mockRejectedValueOnce(new Error('Connection refused'));
    const executor = createCodeExecutor(client);

    const result = await executor.execute(
      `(async () => { try { await ${GET_STATUS}; } catch (e) { return 'caught: ' + e.message; } })()`,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ type: 'fulfilled', value: 'caught: Connection refused' });
  });

  it('returns ok:false when a host rejection is not caught', async () => {
    const client = createMockClient();
    vi.mocked(client.rawRequest).mockRejectedValueOnce(new Error('Connection refused'));
    const executor = createCodeExecutor(client);

    const result = await executor.execute(GET_STATUS);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Connection refused');
  });
});

// ─── Error Marshalling ──────────────────────────────────────────────

describe('error marshalling', () => {
  it('keeps Error name and message from the async code executor', async () => {
    const executor = createCodeExecutor(createMockClient());

    const result = await executor.execute(`throw new RangeError('too big')`);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('RangeError: too big');
  });

  it('keeps Error name and message from the sync search executor', async () => {
    const executor = createSearchExecutor();

    const result = await executor.execute(`throw new TypeError('nope')`);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('TypeError: nope');
  });

  it.each([
    [`throw 'plain string'`, 'plain string'],
    ['throw 42', '42'],
    ['throw { code: 7 }', 'Error: Unknown error'],
  ])('marshals a non-Error throw: %s', async (code, expected) => {
    const executor = createCodeExecutor(createMockClient());

    const result = await executor.execute(code);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(expected);
  });
});

// ─── Sandbox Escapes ────────────────────────────────────────────────

describe('sandbox escape attempts', () => {
  const escapeCases = [
    { label: 'process', expr: 'typeof process', expected: 'undefined' },
    { label: 'require', expr: 'typeof require', expected: 'undefined' },
    { label: 'global', expr: 'typeof global', expected: 'undefined' },
    { label: 'Buffer', expr: 'typeof Buffer', expected: 'undefined' },
    { label: 'module', expr: 'typeof module', expected: 'undefined' },
    {
      label: `this.constructor.constructor('return process')()`,
      expr: `this.constructor.constructor('return process')()`,
      expected: `caught: 'process' is not defined`,
    },
    {
      label: `fortimanager.request.constructor('return process')()`,
      expr: `fortimanager.request.constructor('return process')()`,
      expected: `caught: 'process' is not defined`,
    },
    {
      label: `console.log.constructor('return process')()`,
      expr: `console.log.constructor('return process')()`,
      expected: `caught: 'process' is not defined`,
    },
    {
      label: `Function('return this')() is the guest globalThis`,
      expr: `Function('return this')() === globalThis`,
      expected: 'true',
    },
    {
      label: `Function('return this')().process`,
      expr: `Function('return this')().process === undefined`,
      expected: 'true',
    },
  ];

  it.each(escapeCases)('blocks $label', async ({ expr, expected }) => {
    const executor = createCodeExecutor(createMockClient());
    expect(await runCaught(executor, expr)).toBe(expected);
  });

  it('does not leak prototype pollution across executions', async () => {
    const executor = createCodeExecutor(createMockClient());

    const polluted = await executor.execute(`Object.prototype.polluted = 'yes'; 1`);
    expect(polluted.ok).toBe(true);

    const read = await executor.execute(`({}).polluted ?? 'clean'`);
    expect(read.ok).toBe(true);
    expect(read.data).toBe('clean');
  });

  it.each([`node:fs`, `data:text/javascript,export default 1`])(
    'does not load host modules through import(%s)',
    async (specifier) => {
      const executor = createCodeExecutor(createMockClient());

      const result = await executor.execute(`import('${specifier}')`);

      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ type: 'pending' });
    },
  );
});

// ─── globalThis Allow-List ──────────────────────────────────────────

// Superset of engine globals across quickjs-emscripten 0.31 and 0.32 — 0.32's
// QuickJS adds FinalizationRegistry, Float16Array, Iterator and WeakRef.
// A global outside this list and outside the injected host globals fails the
// test, so a future upgrade exposing a new host API cannot pass unnoticed.
const ENGINE_GLOBALS = [
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Function',
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'InternalError',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'RangeError',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Set',
  'SharedArrayBuffer',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'eval',
  'globalThis',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'undefined',
  'unescape',
];

const ASYNC_INJECTED_GLOBALS = ['console', 'fortimanager'];
const SEARCH_INJECTED_GLOBALS = [
  'console',
  'errorCodes',
  'getObject',
  'moduleList',
  'specIndex',
  'specVersion',
];

describe('globalThis allow-list', () => {
  async function assertOnlyInjectedGlobals(
    executor: { execute(code: string): Promise<ExecuteResult> },
    injected: string[],
  ): Promise<void> {
    const result = await executor.execute('Object.getOwnPropertyNames(globalThis).sort()');
    expect(result.ok).toBe(true);

    const names = result.data as string[];
    const nonEngine = names.filter((name) => !ENGINE_GLOBALS.includes(name));
    expect(nonEngine).toEqual(injected);
  }

  it('async code executor exposes only engine globals and injected host APIs', async () => {
    await assertOnlyInjectedGlobals(createCodeExecutor(createMockClient()), ASYNC_INJECTED_GLOBALS);
  });

  it('sync search executor exposes only engine globals and injected host APIs', async () => {
    await assertOnlyInjectedGlobals(createSearchExecutor(), SEARCH_INJECTED_GLOBALS);
  });
});

// ─── Repeated Disposal ──────────────────────────────────────────────

describe('repeated disposal', () => {
  it('runs 200 mixed async executions without disposal errors', async () => {
    const client = createMockClient();
    mockStatusSuccess(client);
    const executor = createCodeExecutor(client, {
      timeoutMs: 200,
      maxMemoryBytes: 16 * 1024 * 1024,
    });

    let bridgeCalls = 0;
    for (let i = 0; i < 200; i++) {
      const kind = i % 20;
      let code: string;
      if (kind === 0) {
        code = 'while(true){}';
      } else if (kind === 1) {
        code = `const r = ${GET_STATUS}; r.result[0].data.Hostname`;
        bridgeCalls++;
      } else if (kind === 2) {
        code = `throw new Error('boom-${String(i)}')`;
      } else if (kind === 3) {
        code = 'new Uint8Array(32 * 1024 * 1024).length';
      } else {
        code = '1 + 1';
      }

      let result: ExecuteResult;
      try {
        result = await executor.execute(code);
      } catch (err) {
        throw new Error(
          `execution ${String(i)} rejected: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      if (kind === 0) {
        expect(result.ok).toBe(false);
        expect(result.error).toContain('interrupted');
      } else if (kind === 1) {
        expect(result.ok).toBe(true);
        expect(result.data).toBe('fmg-01');
      } else if (kind === 2) {
        expect(result.ok).toBe(false);
        expect(result.error).toContain(`boom-${String(i)}`);
      } else if (kind === 3) {
        expect(result.ok).toBe(false);
        expect(result.error).toContain('out of memory');
      } else {
        expect(result.ok).toBe(true);
        expect(result.data).toBe(2);
      }
    }

    expect(bridgeCalls).toBe(10);
    expect(client.rawRequest).toHaveBeenCalledTimes(bridgeCalls);
  });

  it('runs a mixed sync executor batch without disposal errors', async () => {
    const executor = createSearchExecutor({ timeoutMs: 300 });

    for (let i = 0; i < 50; i++) {
      const kind = i % 10;
      let code: string;
      if (kind === 0) {
        code = 'while(true){}';
      } else if (kind === 1) {
        code = `throw new RangeError('sync-boom')`;
      } else {
        code = 'specVersion';
      }

      let result: ExecuteResult;
      try {
        result = await executor.execute(code);
      } catch (err) {
        throw new Error(
          `execution ${String(i)} rejected: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      if (kind === 0) {
        expect(result.ok).toBe(false);
        expect(result.error).toContain('interrupted');
      } else if (kind === 1) {
        expect(result.ok).toBe(false);
        expect(result.error).toContain('sync-boom');
      } else {
        expect(result.ok).toBe(true);
        expect(result.data).toBe('7.6');
      }
    }
  });
});
