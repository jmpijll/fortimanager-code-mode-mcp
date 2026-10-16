/**
 * Integration Tests — MCP Server with real executors
 *
 * Tests the MCP server tool registration and result formatting through the
 * v2 `serveStdio` entry, with a real SearchExecutor (sample spec) and mocked
 * FortiManager HTTP calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  Client,
  InMemoryTransport,
  type ClientOptions,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer, type ToolDeps } from '../server/server.js';
import { SearchExecutor } from '../executor/search-executor.js';
import { CodeExecutor } from '../executor/code-executor.js';
import { FmgClient } from '../client/fmg-client.js';
import { SAMPLE_SPEC, SAMPLE_CLIENT_CONFIG, makeSuccessResponse } from './fixtures/index.js';

// ─── Setup ──────────────────────────────────────────────────────────

const EXECUTOR_OPTIONS = { timeoutMs: 10_000, maxMemoryBytes: 16 * 1024 * 1024 };

function createTestDeps(): { deps: ToolDeps; fmgClient: FmgClient } {
  const searchExecutor = new SearchExecutor(SAMPLE_SPEC, {
    timeoutMs: 5_000,
    maxMemoryBytes: 16 * 1024 * 1024,
  });

  const fmgClient = new FmgClient(SAMPLE_CLIENT_CONFIG);
  vi.spyOn(fmgClient, 'rawRequest');
  const codeExecutor = new CodeExecutor(fmgClient, EXECUTOR_OPTIONS);

  return {
    deps: { searchExecutor, codeExecutor, specVersion: '7.6' },
    fmgClient,
  };
}

interface Connected {
  client: Client;
  fmgClient: FmgClient;
  close: () => Promise<void>;
}

async function connect(versionNegotiation?: VersionNegotiationOptions): Promise<Connected> {
  const { deps, fmgClient } = createTestDeps();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stdio = serveStdio(() => buildServer(deps, {}), { transport: serverTransport });

  const options: ClientOptions | undefined = versionNegotiation
    ? { versionNegotiation }
    : undefined;
  const client = new Client({ name: 'server-test-client', version: '1.0.0' }, options);
  await client.connect(clientTransport);

  return {
    client,
    fmgClient,
    close: async () => {
      await client.close();
      await stdio.close();
    },
  };
}

function textBlocks(result: { content: unknown }): string[] {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '');
}

// ─── Tests ──────────────────────────────────────────────────────────

const CLIENT_ERAS: Array<{ label: string; options?: VersionNegotiationOptions }> = [
  { label: 'modern era (auto negotiation)', options: { mode: 'auto' } },
  { label: 'legacy era (default client)', options: undefined },
];

describe.each(CLIENT_ERAS)('buildServer over stdio — $label', ({ options }) => {
  it('advertises the server name and version', async () => {
    const { client, close } = await connect(options);
    try {
      const packageInfo = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      const serverVersion = client.getServerVersion();

      expect(serverVersion?.name).toBe('fortimanager-code-mode');
      expect(serverVersion?.version).toBe(packageInfo.version);
    } finally {
      await close();
    }
  });

  it('exposes search as read-only and not destructive', async () => {
    const { client, close } = await connect(options);
    try {
      const { tools } = await client.listTools();
      const search = tools.find((tool) => tool.name === 'search');

      expect(search).toBeDefined();
      expect(search!.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    } finally {
      await close();
    }
  });

  it('exposes execute as destructive and open-world', async () => {
    const { client, close } = await connect(options);
    try {
      const { tools } = await client.listTools();
      const execute = tools.find((tool) => tool.name === 'execute');

      expect(execute).toBeDefined();
      expect(execute!.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
    } finally {
      await close();
    }
  });

  it('runs a search through the sandbox', async () => {
    const { client, close } = await connect(options);
    try {
      const result = await client.callTool({
        name: 'search',
        arguments: {
          code: 'specIndex.filter(o => o.name.includes("firewall")).map(o => o.name)',
        },
      });

      expect(result.isError).not.toBe(true);
      const [data] = textBlocks(result);
      expect(JSON.parse(data!)).toEqual(['firewall/address', 'firewall/addrgrp']);
    } finally {
      await close();
    }
  });

  it('includes console logs in the tool result', async () => {
    const { client, close } = await connect(options);
    try {
      const result = await client.callTool({
        name: 'search',
        arguments: { code: 'console.log("searching..."); specIndex.length' },
      });

      expect(result.isError).not.toBe(true);
      const blocks = textBlocks(result);
      expect(blocks[0]).toBe('--- Console Output ---\n[log] searching...');
      expect(JSON.parse(blocks[1]!)).toBe(3);
    } finally {
      await close();
    }
  });

  it('reports sandbox errors as tool errors', async () => {
    const { client, close } = await connect(options);
    try {
      const result = await client.callTool({
        name: 'search',
        arguments: { code: 'invalidFunction()' },
      });

      expect(result.isError).toBe(true);
      expect(textBlocks(result).join('\n')).toContain('Error:');
    } finally {
      await close();
    }
  });

  it('runs an execute call through the mocked FortiManager client', async () => {
    const { client, fmgClient, close } = await connect(options);
    try {
      vi.mocked(fmgClient.rawRequest).mockResolvedValueOnce(
        makeSuccessResponse(1, '/sys/status', { Version: '7.6.5' }),
      );

      const result = await client.callTool({
        name: 'execute',
        arguments: {
          code: 'var resp = fortimanager.request("get", [{ url: "/sys/status" }]); resp.result[0].data.Version',
        },
      });

      expect(result.isError).not.toBe(true);
      expect(textBlocks(result).join('\n')).toContain('7.6.5');
      expect(fmgClient.rawRequest).toHaveBeenCalledWith('get', [{ url: '/sys/status' }], undefined);
    } finally {
      await close();
    }
  });

  it('rejects code over the 100 KB limit with a tool error', async () => {
    const { client, close } = await connect(options);
    try {
      const result = await client.callTool({
        name: 'search',
        arguments: { code: 'x'.repeat(100_001) },
      });

      expect(result.isError).toBe(true);
      expect(textBlocks(result).join('\n')).toMatch(/Code input too large|Too big/);
    } finally {
      await close();
    }
  });

  it('carries the tools/list cache hint only on the modern era', async () => {
    const { client, close } = await connect(options);
    try {
      const result = await client.listTools();

      if (options?.mode === 'auto') {
        expect(result['ttlMs']).toBe(300_000);
        expect(result['cacheScope']).toBe('public');
      } else {
        expect(result['ttlMs']).toBeUndefined();
        expect(result['cacheScope']).toBeUndefined();
      }
    } finally {
      await close();
    }
  });
});
