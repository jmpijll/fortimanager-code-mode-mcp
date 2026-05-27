/**
 * Integration tests for the Streamable HTTP transport.
 *
 * Regression coverage for https://github.com/jmpijll/fortimanager-code-mode-mcp/issues/13
 * ("HTTP transport rejects all clients after first connection — Server already
 * initialized"). Each /mcp request must be able to perform its own `initialize`
 * handshake against a freshly minted `McpServer`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startHttpTransport, type HttpTransportHandle } from '../server/transport.js';
import { createMcpServer } from '../server/server.js';
import { SearchExecutor } from '../executor/search-executor.js';
import { CodeExecutor } from '../executor/code-executor.js';
import { FmgClient } from '../client/fmg-client.js';
import { SAMPLE_SPEC, SAMPLE_CLIENT_CONFIG } from './fixtures/index.js';
import type { AppConfig } from '../config.js';

// ─── Test Harness ───────────────────────────────────────────────────

const silentLogger = {
  info: (): void => {
    /* noop */
  },
  error: (): void => {
    /* noop */
  },
};

interface Harness {
  handle: HttpTransportHandle;
  baseUrl: URL;
  /** Counter; mutated by the serverFactory passed to startHttpTransport. */
  state: { factoryCalls: number };
}

async function startHarness(): Promise<Harness> {
  const searchExecutor = new SearchExecutor(SAMPLE_SPEC, {
    timeoutMs: 5_000,
    maxMemoryBytes: 16 * 1024 * 1024,
  });
  const client = new FmgClient(SAMPLE_CLIENT_CONFIG);
  const codeExecutor = new CodeExecutor(client, {
    timeoutMs: 5_000,
    maxMemoryBytes: 16 * 1024 * 1024,
  });

  const state = { factoryCalls: 0 };

  const config: AppConfig = {
    fmgHost: SAMPLE_CLIENT_CONFIG.host,
    fmgPort: SAMPLE_CLIENT_CONFIG.port,
    fmgApiToken: SAMPLE_CLIENT_CONFIG.apiToken,
    fmgVerifySsl: SAMPLE_CLIENT_CONFIG.verifySsl,
    fmgApiVersion: '7.6',
    mcpTransport: 'http',
    // Port 0 → kernel picks a free port.
    mcpHttpPort: 0,
  };

  const handle = await startHttpTransport(
    {
      // Bind explicitly to loopback so test runs don't expose a public port.
      host: '127.0.0.1',
      serverFactory: () => {
        state.factoryCalls += 1;
        return createMcpServer({
          searchExecutor,
          codeExecutor,
          specVersion: '7.6',
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
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('startHttpTransport', () => {
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
});
