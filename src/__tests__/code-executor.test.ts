/**
 * Unit Tests — CodeExecutor (QuickJS async sandbox with FMG API proxy)
 *
 * Tests the code executor with a mocked FmgClient.
 * Validates async execution, fortimanager.request() proxy, error handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { CodeExecutor } from '../executor/code-executor.js';
import { FmgClient } from '../client/fmg-client.js';
import { SAMPLE_CLIENT_CONFIG, makeSuccessResponse, makeErrorResponse } from './fixtures/index.js';

// ─── Setup ──────────────────────────────────────────────────────────

function createMockClient(): FmgClient {
  const client = new FmgClient(SAMPLE_CLIENT_CONFIG);
  // Mock the rawRequest method
  vi.spyOn(client, 'rawRequest');
  return client;
}

function createExecutor(client: FmgClient): CodeExecutor {
  return new CodeExecutor(client, {
    timeoutMs: 10_000,
    maxMemoryBytes: 32 * 1024 * 1024,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('CodeExecutor', () => {
  describe('basic execution', () => {
    it('evaluates a simple expression', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      const result = await executor.execute('1 + 2');

      expect(result.ok).toBe(true);
      expect(result.data).toBe(3);
    });

    it('supports function declarations', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      const result = await executor.execute(`
        function greet(name) {
          return "hello " + name;
        }
        greet("world");
      `);

      expect(result.ok).toBe(true);
      expect(result.data).toBe('hello world');
    });
  });

  describe('fortimanager.request()', () => {
    it('proxies API calls to the host FmgClient', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      const mockResponse = makeSuccessResponse(1, '/sys/status', {
        Version: '7.6.5',
        Hostname: 'fmg-01',
      });
      vi.mocked(client.rawRequest).mockResolvedValueOnce(mockResponse);

      const result = await executor.execute(`
        const resp = fortimanager.request('get', [{ url: '/sys/status' }]);
        resp.result[0].data
      `);

      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ Version: '7.6.5', Hostname: 'fmg-01' });
      expect(client.rawRequest).toHaveBeenCalledWith('get', [{ url: '/sys/status' }], undefined);
    });

    it('forwards opts.fmgToken as a tokenOverride on the FmgClient call', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      vi.mocked(client.rawRequest).mockResolvedValueOnce(
        makeSuccessResponse(1, '/sys/status', { Hostname: 'tenant-a' }),
      );

      await executor.execute(
        `var r = fortimanager.request('get', [{ url: '/sys/status' }]); r.result[0].data`,
        { fmgToken: 'tenant-a-token' },
      );

      expect(client.rawRequest).toHaveBeenCalledWith('get', [{ url: '/sys/status' }], {
        tokenOverride: 'tenant-a-token',
      });
    });

    it('handles API error responses', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      const mockResponse = makeErrorResponse(1, '/bad/url', -10, 'Object not found');
      vi.mocked(client.rawRequest).mockResolvedValueOnce(mockResponse);

      const result = await executor.execute(`
        const resp = fortimanager.request('get', [{ url: '/bad/url' }]);
        resp.result[0].status
      `);

      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ code: -10, message: 'Object not found' });
    });

    it('handles host client exceptions as sandbox errors', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      vi.mocked(client.rawRequest).mockRejectedValueOnce(new Error('Connection refused'));

      const result = await executor.execute(`
        try {
          fortimanager.request('get', [{ url: '/sys/status' }]);
        } catch (e) {
          e.message;
        }
      `);

      expect(result.ok).toBe(true);
      expect(result.data).toContain('Connection refused');
    });

    it('supports multiple sequential API calls', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      vi.mocked(client.rawRequest)
        .mockResolvedValueOnce(makeSuccessResponse(1, '/dvmdb/adom', [{ name: 'root', oid: 3 }]))
        .mockResolvedValueOnce(
          makeSuccessResponse(2, '/dvmdb/adom/root/device', [{ name: 'fw-01', ip: '10.0.0.1' }]),
        );

      const result = await executor.execute(`
        const adoms = fortimanager.request('get', [{ url: '/dvmdb/adom' }]);
        const devices = fortimanager.request('get', [{ url: '/dvmdb/adom/root/device' }]);
        ({
          adomCount: adoms.result[0].data.length,
          deviceCount: devices.result[0].data.length
        })
      `);

      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ adomCount: 1, deviceCount: 1 });
      expect(client.rawRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('console capture', () => {
    it('captures console.log output', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      const result = await executor.execute('console.log("test message"); 42');

      expect(result.ok).toBe(true);
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]!.message).toBe('test message');
    });
  });

  describe('error handling', () => {
    it('returns error for syntax errors', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      const result = await executor.execute('{{{');

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns error for uncaught runtime exceptions', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      const result = await executor.execute('throw new Error("test error")');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('test error');
    });
  });

  describe('sandbox isolation', () => {
    it('does not expose Node.js process', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      const result = await executor.execute('typeof process');

      expect(result.ok).toBe(true);
      expect(result.data).toBe('undefined');
    });

    it('each execution gets a fresh context', async () => {
      const client = createMockClient();
      const executor = createExecutor(client);

      await executor.execute('globalThis.leaked = "secret"');
      const result = await executor.execute('typeof globalThis.leaked');

      expect(result.ok).toBe(true);
      expect(result.data).toBe('undefined');
    });
  });

  describe('API call limits', () => {
    it('enforces maximum API call count per execution', async () => {
      const client = createMockClient();
      vi.mocked(client.rawRequest).mockResolvedValue(
        makeSuccessResponse(1, '/sys/status', { ok: true }),
      );
      const executor = new CodeExecutor(client, {
        timeoutMs: 30_000,
        maxMemoryBytes: 32 * 1024 * 1024,
      });

      // Make 51 API calls (limit is 50)
      const result = await executor.execute(`
        var i = 0;
        try {
          for (i = 0; i < 51; i++) {
            fortimanager.request("get", [{ url: "/sys/status" }]);
          }
        } catch (e) {
          ({ error: e.message, callsMade: i });
        }
      `);

      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data['callsMade']).toBe(50);
      expect(data['error']).toContain('API call limit exceeded');
    });
  });
});
