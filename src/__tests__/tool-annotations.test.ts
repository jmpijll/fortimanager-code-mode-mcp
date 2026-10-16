/**
 * Tool annotation tests — an MCP client lists tools and inspects the
 * annotations it would use to decide whether to ask the user for
 * confirmation before calling them.
 */

import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer, type CreateServerOptions } from '../server/server.js';
import { SearchExecutor } from '../executor/search-executor.js';
import { CodeExecutor } from '../executor/code-executor.js';
import { FmgClient } from '../client/fmg-client.js';
import { SAMPLE_SPEC, SAMPLE_CLIENT_CONFIG } from './fixtures/index.js';

function createTestOptions(): CreateServerOptions {
  const searchExecutor = new SearchExecutor(SAMPLE_SPEC, {
    timeoutMs: 5_000,
    maxMemoryBytes: 16 * 1024 * 1024,
  });

  const fmgClient = new FmgClient(SAMPLE_CLIENT_CONFIG);
  vi.spyOn(fmgClient, 'rawRequest');
  const codeExecutor = new CodeExecutor(fmgClient, {
    timeoutMs: 10_000,
    maxMemoryBytes: 32 * 1024 * 1024,
  });

  return {
    searchExecutor,
    codeExecutor,
    specVersion: '7.6',
  };
}

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

describe('tool annotations', () => {
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
