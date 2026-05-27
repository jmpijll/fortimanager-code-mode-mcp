/**
 * Integration tests for the Streamable HTTP transport.
 *
 * Regression coverage for https://github.com/jmpijll/fortimanager-code-mode-mcp/issues/13
 * ("HTTP transport rejects all clients after first connection — Server already
 * initialized"). Each /mcp request must be able to perform its own `initialize`
 * handshake against a freshly minted `McpServer`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startHttpTransport, type HttpTransportHandle } from '../server/transport.js';
import { createMcpServer } from '../server/server.js';
import { SearchExecutor } from '../executor/search-executor.js';
import { CodeExecutor } from '../executor/code-executor.js';
import { FmgClient } from '../client/fmg-client.js';
import { SAMPLE_SPEC, SAMPLE_CLIENT_CONFIG, makeSuccessResponse } from './fixtures/index.js';
import type { AppConfig } from '../config.js';

// ─── Test Harness ───────────────────────────────────────────────────

const silentLogger = {
  info: (): void => {
    /* noop */
  },
  warn: (): void => {
    /* noop */
  },
  error: (): void => {
    /* noop */
  },
};

interface HarnessOptions {
  apiKey?: string;
  tokenPassthrough?: boolean;
}

interface Harness {
  handle: HttpTransportHandle;
  baseUrl: URL;
  /** State observed by the serverFactory across requests. */
  state: {
    factoryCalls: number;
    /** Most-recently observed per-request fmgToken (or `undefined` if none). */
    lastFmgToken: string | undefined;
    /** Every fmgToken value passed to the factory, in order. */
    fmgTokens: Array<string | undefined>;
  };
  /** The shared FmgClient used by the test harness — mock `rawRequest` on it. */
  fmgClient: FmgClient;
}

async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const searchExecutor = new SearchExecutor(SAMPLE_SPEC, {
    timeoutMs: 5_000,
    maxMemoryBytes: 16 * 1024 * 1024,
  });
  const fmgClient = new FmgClient(SAMPLE_CLIENT_CONFIG);
  const codeExecutor = new CodeExecutor(fmgClient, {
    timeoutMs: 5_000,
    maxMemoryBytes: 16 * 1024 * 1024,
  });

  const state = {
    factoryCalls: 0,
    lastFmgToken: undefined as string | undefined,
    fmgTokens: [] as Array<string | undefined>,
  };

  const config: AppConfig = {
    fmgHost: SAMPLE_CLIENT_CONFIG.host,
    fmgPort: SAMPLE_CLIENT_CONFIG.port,
    fmgApiToken: SAMPLE_CLIENT_CONFIG.apiToken,
    fmgVerifySsl: SAMPLE_CLIENT_CONFIG.verifySsl,
    fmgApiVersion: '7.6',
    mcpTransport: 'http',
    // Port 0 → kernel picks a free port.
    mcpHttpPort: 0,
    mcpTokenPassthrough: opts.tokenPassthrough ?? false,
    mcpApiKey: opts.apiKey,
  };

  const handle = await startHttpTransport(
    {
      // Bind explicitly to loopback so test runs don't expose a public port.
      host: '127.0.0.1',
      apiKey: opts.apiKey,
      tokenPassthrough: opts.tokenPassthrough,
      serverFactory: (ctx) => {
        state.factoryCalls += 1;
        state.lastFmgToken = ctx.fmgToken;
        state.fmgTokens.push(ctx.fmgToken);
        return createMcpServer({
          searchExecutor,
          codeExecutor,
          specVersion: '7.6',
          fmgToken: ctx.fmgToken,
        });
      },
    },
    config,
    silentLogger,
  );

  return {
    handle,
    baseUrl: new URL(`http://127.0.0.1:${String(handle.port)}/mcp`),
    state,
    fmgClient,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('startHttpTransport — open endpoint (no auth)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.handle.close();
  });

  it('serves the /health endpoint without going through MCP', async () => {
    const res = await fetch(`http://127.0.0.1:${String(harness.handle.port)}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; stats: { totalRequests: number } };
    expect(body.status).toBe('ok');
    expect(body.stats.totalRequests).toBeGreaterThan(0);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`http://127.0.0.1:${String(harness.handle.port)}/unknown`);
    expect(res.status).toBe(404);
  });

  it('allows two independent clients to initialize sequentially (regression for #13)', async () => {
    // First client — first ever connection succeeds today.
    const clientA = new Client({ name: 'test-client-a', version: '1.0.0' });
    const transportA = new StreamableHTTPClientTransport(harness.baseUrl);
    await clientA.connect(transportA);
    const toolsA = await clientA.listTools();
    expect(toolsA.tools.map((t) => t.name).sort()).toEqual(['execute', 'search']);
    await clientA.close();

    // Second client — used to fail with "Invalid Request: Server already initialized"
    // because the single module-scope McpServer/transport refused another `initialize`.
    const clientB = new Client({ name: 'test-client-b', version: '1.0.0' });
    const transportB = new StreamableHTTPClientTransport(harness.baseUrl);
    await clientB.connect(transportB);
    const toolsB = await clientB.listTools();
    expect(toolsB.tools.map((t) => t.name).sort()).toEqual(['execute', 'search']);
    await clientB.close();

    // Each client request triggered at least one fresh McpServer construction.
    expect(harness.state.factoryCalls).toBeGreaterThanOrEqual(2);
  });

  it('supports the same client reconnecting after a disconnect', async () => {
    const connectAndProbe = async (): Promise<string[]> => {
      const client = new Client({ name: 'reconnect-client', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(harness.baseUrl);
      await client.connect(transport);
      const tools = await client.listTools();
      await client.close();
      return tools.tools.map((t) => t.name).sort();
    };

    expect(await connectAndProbe()).toEqual(['execute', 'search']);
    expect(await connectAndProbe()).toEqual(['execute', 'search']);
    expect(await connectAndProbe()).toEqual(['execute', 'search']);
  });

  it('actually executes a tool through the HTTP transport', async () => {
    const client = new Client({ name: 'tool-call-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(harness.baseUrl);
    await client.connect(transport);

    const result = await client.callTool({
      name: 'search',
      arguments: {
        code: 'specIndex.filter(function(o) { return o.name.indexOf("firewall") === 0; }).map(function(o) { return o.name; })',
      },
    });

    expect(result.isError).not.toBe(true);
    // Result is delivered as text content blocks; first block holds the JSON.
    const content = result.content as Array<{ type: string; text: string }>;
    const dataBlock = content.find((c) => c.type === 'text' && c.text.startsWith('['));
    expect(dataBlock, 'expected a JSON-array text block in the result').toBeDefined();
    const parsed = JSON.parse(dataBlock!.text) as string[];
    expect(parsed.sort()).toEqual(['firewall/address', 'firewall/addrgrp']);

    await client.close();
  });

  it('does not invoke the serverFactory with an X-FMG-Token when passthrough is off', async () => {
    await fetch(harness.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-FMG-Token': 'should-be-ignored',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'no-passthrough-client', version: '1.0.0' },
        },
      }),
    });

    expect(harness.state.factoryCalls).toBeGreaterThan(0);
    expect(harness.state.lastFmgToken).toBeUndefined();
  });
});

// ─── Auth gate (MCP_API_KEY) ────────────────────────────────────────

describe('startHttpTransport — MCP_API_KEY gate', () => {
  const API_KEY = 'unit-test-mcp-api-key-1234567890';
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness({ apiKey: API_KEY });
  });

  afterEach(async () => {
    await harness.handle.close();
  });

  it('rejects requests without an Authorization header with 401', async () => {
    const res = await fetch(harness.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer\b/);
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32001);
    expect(harness.state.factoryCalls).toBe(0);
  });

  it('rejects requests with a wrong Bearer token with 401', async () => {
    const res = await fetch(harness.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer wrong-key',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}',
    });
    expect(res.status).toBe(401);
    expect(harness.state.factoryCalls).toBe(0);
  });

  it('rejects requests with a malformed Authorization header with 401', async () => {
    const res = await fetch(harness.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        // No "Bearer " prefix
        Authorization: API_KEY,
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}',
    });
    expect(res.status).toBe(401);
    expect(harness.state.factoryCalls).toBe(0);
  });

  it('accepts requests with the correct Bearer token', async () => {
    const client = new Client({ name: 'authed-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(harness.baseUrl, {
      requestInit: {
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['execute', 'search']);
    await client.close();
    expect(harness.state.factoryCalls).toBeGreaterThan(0);
  });

  it('leaves /health open (no auth required for healthchecks)', async () => {
    const res = await fetch(`http://127.0.0.1:${String(harness.handle.port)}/health`);
    expect(res.status).toBe(200);
  });
});

// ─── X-FMG-Token passthrough ────────────────────────────────────────

describe('startHttpTransport — MCP_TOKEN_PASSTHROUGH', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness({ tokenPassthrough: true });
    // Mock the executor's downstream FMG call so we can observe the
    // tokenOverride without hitting a real FortiManager.
    vi.spyOn(harness.fmgClient, 'rawRequest').mockResolvedValue(
      makeSuccessResponse(1, '/sys/status', { Hostname: 'test-fmg', Version: '7.6.6' }),
    );
  });

  afterEach(async () => {
    await harness.handle.close();
    vi.restoreAllMocks();
  });

  it('exposes the X-FMG-Token header on McpRequestContext when present', async () => {
    const client = new Client({ name: 'passthrough-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(harness.baseUrl, {
      requestInit: {
        headers: { 'X-FMG-Token': 'per-client-token-abc' },
      },
    });
    await client.connect(transport);
    await client.listTools();
    await client.close();

    expect(harness.state.fmgTokens).toContain('per-client-token-abc');
  });

  it('forwards the per-request token to FortiManager via the execute tool', async () => {
    const client = new Client({ name: 'passthrough-exec-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(harness.baseUrl, {
      requestInit: {
        headers: { 'X-FMG-Token': 'forwarded-fmg-token-xyz' },
      },
    });
    await client.connect(transport);

    const result = await client.callTool({
      name: 'execute',
      arguments: {
        code: 'var r = fortimanager.request("get", [{ url: "/sys/status" }]); r.result[0].data.Hostname',
      },
    });
    expect(result.isError).not.toBe(true);

    expect(harness.fmgClient.rawRequest).toHaveBeenCalledWith('get', [{ url: '/sys/status' }], {
      tokenOverride: 'forwarded-fmg-token-xyz',
    });

    await client.close();
  });

  it('falls back to the configured token when X-FMG-Token is absent', async () => {
    const client = new Client({ name: 'fallback-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(harness.baseUrl);
    await client.connect(transport);

    await client.callTool({
      name: 'execute',
      arguments: {
        code: 'var r = fortimanager.request("get", [{ url: "/sys/status" }]); r.result[0].data',
      },
    });

    // No tokenOverride supplied when header is missing — executor uses
    // the FmgClient's configured (env) token internally.
    expect(harness.fmgClient.rawRequest).toHaveBeenCalledWith(
      'get',
      [{ url: '/sys/status' }],
      undefined,
    );
    expect(harness.state.lastFmgToken).toBeUndefined();

    await client.close();
  });

  it('treats an empty X-FMG-Token as absent (falls back to configured token)', async () => {
    await fetch(harness.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-FMG-Token': '',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}',
    });

    expect(harness.state.lastFmgToken).toBeUndefined();
  });
});

// ─── Combined: gate + passthrough ───────────────────────────────────

describe('startHttpTransport — MCP_API_KEY + MCP_TOKEN_PASSTHROUGH together', () => {
  const API_KEY = 'gate-key-and-token-passthrough-combo';
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness({ apiKey: API_KEY, tokenPassthrough: true });
    vi.spyOn(harness.fmgClient, 'rawRequest').mockResolvedValue(
      makeSuccessResponse(1, '/sys/status', { Hostname: 'combo-test' }),
    );
  });

  afterEach(async () => {
    await harness.handle.close();
    vi.restoreAllMocks();
  });

  it('uses Authorization for the gate and X-FMG-Token for the FMG token', async () => {
    const client = new Client({ name: 'combo-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(harness.baseUrl, {
      requestInit: {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'X-FMG-Token': 'combo-fmg-token',
        },
      },
    });
    await client.connect(transport);

    await client.callTool({
      name: 'execute',
      arguments: {
        code: 'var r = fortimanager.request("get", [{ url: "/sys/status" }]); r.result[0].data',
      },
    });

    expect(harness.fmgClient.rawRequest).toHaveBeenCalledWith('get', [{ url: '/sys/status' }], {
      tokenOverride: 'combo-fmg-token',
    });

    await client.close();
  });

  it('still rejects when the MCP gate key is wrong, even with a valid X-FMG-Token', async () => {
    const res = await fetch(harness.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-the-real-key',
        'X-FMG-Token': 'irrelevant',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}',
    });
    expect(res.status).toBe(401);
    expect(harness.state.factoryCalls).toBe(0);
    expect(harness.fmgClient.rawRequest).not.toHaveBeenCalled();
  });
});
