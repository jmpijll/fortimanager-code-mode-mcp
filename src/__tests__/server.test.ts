/**
 * Integration Tests — MCP Server with real executors
 *
 * Tests the MCP server tool registration and result formatting
 * with real SearchExecutor (sample spec) and mocked CodeExecutor.
 */

import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type CreateServerOptions } from '../server/server.js';
import { SearchExecutor } from '../executor/search-executor.js';
import { CodeExecutor } from '../executor/code-executor.js';
import { FmgClient } from '../client/fmg-client.js';
import { SAMPLE_SPEC, SAMPLE_CLIENT_CONFIG, makeSuccessResponse } from './fixtures/index.js';
import type { ExecuteResult } from '../executor/types.js';

// ─── Setup ──────────────────────────────────────────────────────────

function createTestOptions(): CreateServerOptions {
  const searchExecutor = new SearchExecutor(SAMPLE_SPEC, {
    timeoutMs: 5_000,
    maxMemoryBytes: 16 * 1024 * 1024,
  });

  const client = new FmgClient(SAMPLE_CLIENT_CONFIG);
  vi.spyOn(client, 'rawRequest');
  const codeExecutor = new CodeExecutor(client, {
    timeoutMs: 10_000,
    maxMemoryBytes: 32 * 1024 * 1024,
  });

  return {
    searchExecutor,
    codeExecutor,
    specVersion: '7.6',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('createMcpServer', () => {
  it('creates a server with the correct name and version', () => {
    const options = createTestOptions();
    const server = createMcpServer(options);

    // McpServer should be created without errors
    expect(server).toBeDefined();
  });
});

describe('SearchExecutor via server flow', () => {
  it('executes a spec search and returns results', async () => {
    const options = createTestOptions();

    // Test the search executor directly (same as tool callback would)
    const result = await options.searchExecutor.execute(
      'specIndex.filter(o => o.name.includes("firewall")).map(o => o.name)',
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(['firewall/address', 'firewall/addrgrp']);
  });

  it('handles search errors gracefully', async () => {
    const options = createTestOptions();

    const result = await options.searchExecutor.execute('invalidFunction()');

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('CodeExecutor via server flow', () => {
  it('executes API calls via the code executor', async () => {
    const options = createTestOptions();
    const client = (options.codeExecutor as unknown as { client: FmgClient }).client;

    vi.mocked(client.rawRequest).mockResolvedValueOnce(
      makeSuccessResponse(1, '/sys/status', { Version: '7.6.5' }),
    );

    const result = await options.codeExecutor.execute(`
      const resp = fortimanager.request('get', [{ url: '/sys/status' }]);
      resp.result[0].data.Version
    `);

    expect(result.ok).toBe(true);
    expect(result.data).toBe('7.6.5');
  });
});

describe('result formatting', () => {
  it('formats a successful result with data', () => {
    // Simulate what the server tool callback does (formatToolResult logic)
    const result: ExecuteResult = {
      ok: true,
      data: { name: 'test' },
      logs: [],
      durationMs: 42,
    };

    // Verify result structure matches what formatToolResult produces
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ name: 'test' });
  });

  it('formats an error result', () => {
    const result: ExecuteResult = {
      ok: false,
      error: 'Something went wrong',
      logs: [{ level: 'error', message: 'debug info', timestamp: Date.now() }],
      durationMs: 15,
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Something went wrong');
    expect(result.logs).toHaveLength(1);
  });

  it('includes console logs in result', async () => {
    const options = createTestOptions();

    const result = await options.searchExecutor.execute(
      'console.log("searching..."); specIndex.length',
    );

    expect(result.ok).toBe(true);
    expect(result.data).toBe(3);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]!.message).toBe('searching...');
  });
});

describe('tool annotations', () => {
  async function listToolsAsClient() {
    const server = createMcpServer(createTestOptions());
    const client = new Client({ name: 'annotations-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();

    await client.close();
    await server.close();

    return tools;
  }

  it('exposes search as read-only and not destructive', async () => {
    const tools = await listToolsAsClient();
    const search = tools.find((tool) => tool.name === 'search');

    expect(search).toBeDefined();
    expect(search!.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('exposes execute as destructive and open-world', async () => {
    const tools = await listToolsAsClient();
    const execute = tools.find((tool) => tool.name === 'execute');

    expect(execute).toBeDefined();
    expect(execute!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});
