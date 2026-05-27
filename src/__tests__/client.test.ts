/**
 * Unit Tests — FortiManager JSON-RPC Client
 *
 * Tests the FmgClient class with mocked fetch() calls.
 * Never hits a real FortiManager instance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FmgClient } from '../client/fmg-client.js';
import { FmgApiError, FmgTransportError } from '../client/types.js';
import { SAMPLE_CLIENT_CONFIG, makeSuccessResponse, makeErrorResponse } from './fixtures/index.js';

// ─── Setup ──────────────────────────────────────────────────────────

let client: FmgClient;

beforeEach(() => {
  client = new FmgClient(SAMPLE_CLIENT_CONFIG);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Helper to mock a successful fetch response */
function mockFetch(body: unknown): void {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  } as Response);
}

/** Helper to mock a failing fetch response */
function mockFetchError(status: number, statusText: string): void {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
  } as Response);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('FmgClient', () => {
  describe('constructor', () => {
    it('builds endpoint from host and port', () => {
      // Check that requests go to the right URL
      mockFetch(makeSuccessResponse(1, '/sys/status', { Version: '7.6' }));
      void client.get('/sys/status');

      expect(fetch).toHaveBeenCalledWith(
        'https://fmg.example.com:443/jsonrpc',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('get()', () => {
    it('sends a GET request and returns data', async () => {
      const responseData = { Version: '7.6.5', Hostname: 'fmg-01' };
      mockFetch(makeSuccessResponse(1, '/sys/status', responseData));

      const result = await client.get('/sys/status');

      expect(result).toEqual(responseData);
      expect(fetch).toHaveBeenCalledOnce();

      // Verify request body structure
      const callArgs = vi.mocked(fetch).mock.calls[0]!;
      const body = JSON.parse(callArgs[1]!.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({
        method: 'get',
        params: [{ url: '/sys/status' }],
      });
    });

    it('passes filter, fields, range params', async () => {
      mockFetch(makeSuccessResponse(1, '/some/url', []));

      await client.get('/some/url', {
        filter: ['name', '==', 'test'],
        fields: ['name', 'ip'],
        range: [0, 10],
      });

      const callArgs = vi.mocked(fetch).mock.calls[0]!;
      const body = JSON.parse(callArgs[1]!.body as string) as Record<string, unknown>;
      const params = (body['params'] as Record<string, unknown>[])[0]!;

      expect(params['filter']).toEqual(['name', '==', 'test']);
      expect(params['fields']).toEqual(['name', 'ip']);
      expect(params['range']).toEqual([0, 10]);
    });

    it('throws FmgApiError on non-zero status code', async () => {
      mockFetch(makeErrorResponse(1, '/bad/url', -10, 'Object not found'));

      await expect(client.get('/bad/url')).rejects.toThrow(FmgApiError);
      await expect(
        client.get('/bad/url').catch((e: FmgApiError) => {
          expect(e.statusCode).toBe(-10);
          expect(e.url).toBe('/bad/url');
          expect(e.method).toBe('get');
          throw e;
        }),
      ).rejects.toThrow();
    });
  });

  describe('add()', () => {
    it('sends an ADD request with data payload', async () => {
      const payload = { name: 'test-addr', subnet: ['10.0.0.0', '255.255.255.0'] };
      mockFetch(makeSuccessResponse(1, '/pm/config/adom/root/obj/firewall/address', payload));

      await client.add('/pm/config/adom/root/obj/firewall/address', payload);

      const callArgs = vi.mocked(fetch).mock.calls[0]!;
      const body = JSON.parse(callArgs[1]!.body as string) as Record<string, unknown>;
      expect(body['method']).toBe('add');
      const params = (body['params'] as Record<string, unknown>[])[0]!;
      expect(params['data']).toEqual(payload);
    });
  });

  describe('delete()', () => {
    it('sends a DELETE request', async () => {
      mockFetch(makeSuccessResponse(1, '/some/object', null));

      await client.delete('/some/object');

      const callArgs = vi.mocked(fetch).mock.calls[0]!;
      const body = JSON.parse(callArgs[1]!.body as string) as Record<string, unknown>;
      expect(body['method']).toBe('delete');
    });
  });

  describe('batch()', () => {
    it('sends multiple params in one request', async () => {
      const response = {
        id: 1,
        result: [
          { status: { code: 0, message: 'OK' }, url: '/url/1', data: 'a' },
          { status: { code: 0, message: 'OK' }, url: '/url/2', data: 'b' },
        ],
      };
      mockFetch(response);

      const results = await client.batch('get', [{ url: '/url/1' }, { url: '/url/2' }]);

      expect(results).toHaveLength(2);
      expect(results[0]!.data).toBe('a');
      expect(results[1]!.data).toBe('b');

      const callArgs = vi.mocked(fetch).mock.calls[0]!;
      const body = JSON.parse(callArgs[1]!.body as string) as Record<string, unknown>;
      expect(body['params']).toHaveLength(2);
    });
  });

  describe('rawRequest()', () => {
    it('returns the full JSON-RPC response envelope', async () => {
      const fullResponse = makeSuccessResponse(1, '/sys/status', { Version: '7.6' });
      mockFetch(fullResponse);

      const result = await client.rawRequest('get', [{ url: '/sys/status' }]);

      expect(result.id).toBe(1);
      expect(result.result).toHaveLength(1);
      expect(result.result[0]!.status.code).toBe(0);
    });

    it('uses tokenOverride for the Authorization header when supplied', async () => {
      mockFetch(makeSuccessResponse(1, '/sys/status', {}));

      await client.rawRequest('get', [{ url: '/sys/status' }], {
        tokenOverride: 'override-token-xyz',
      });

      const callArgs = vi.mocked(fetch).mock.calls[0]!;
      const headers = (callArgs[1]!.headers as Record<string, string>) ?? {};
      expect(headers['Authorization']).toBe('Bearer override-token-xyz');
    });

    it('falls back to the configured token when tokenOverride is omitted', async () => {
      mockFetch(makeSuccessResponse(1, '/sys/status', {}));

      await client.rawRequest('get', [{ url: '/sys/status' }]);

      const callArgs = vi.mocked(fetch).mock.calls[0]!;
      const headers = (callArgs[1]!.headers as Record<string, string>) ?? {};
      expect(headers['Authorization']).toBe(`Bearer ${SAMPLE_CLIENT_CONFIG.apiToken}`);
    });

    it('does not mutate the client state — subsequent calls use the configured token', async () => {
      mockFetch(makeSuccessResponse(1, '/sys/status', {}));
      mockFetch(makeSuccessResponse(2, '/sys/status', {}));

      await client.rawRequest('get', [{ url: '/sys/status' }], {
        tokenOverride: 'one-shot-token',
      });
      await client.rawRequest('get', [{ url: '/sys/status' }]);

      const firstHeaders =
        (vi.mocked(fetch).mock.calls[0]![1]!.headers as Record<string, string>) ?? {};
      const secondHeaders =
        (vi.mocked(fetch).mock.calls[1]![1]!.headers as Record<string, string>) ?? {};
      expect(firstHeaders['Authorization']).toBe('Bearer one-shot-token');
      expect(secondHeaders['Authorization']).toBe(`Bearer ${SAMPLE_CLIENT_CONFIG.apiToken}`);
    });
  });

  describe('checkHealth()', () => {
    it('returns connected=true with version info on success', async () => {
      mockFetch(
        makeSuccessResponse(1, '/sys/status', {
          Version: '7.6.5',
          Hostname: 'fmg-lab',
        }),
      );

      const health = await client.checkHealth();

      expect(health.connected).toBe(true);
      expect(health.version).toBe('7.6.5');
      expect(health.hostname).toBe('fmg-lab');
    });

    it('returns connected=false on error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection refused'));

      const health = await client.checkHealth();

      expect(health.connected).toBe(false);
    });
  });

  describe('authentication', () => {
    it('includes Bearer token header', async () => {
      mockFetch(makeSuccessResponse(1, '/sys/status', {}));

      await client.get('/sys/status');

      const callArgs = vi.mocked(fetch).mock.calls[0]!;
      const headers = (callArgs[1]!.headers as Record<string, string>) ?? {};
      expect(headers['Authorization']).toBe('Bearer test-api-token-12345');
    });

    it('does not include session in body for token auth', async () => {
      mockFetch(makeSuccessResponse(1, '/sys/status', {}));

      await client.get('/sys/status');

      const callArgs = vi.mocked(fetch).mock.calls[0]!;
      const body = JSON.parse(callArgs[1]!.body as string) as Record<string, unknown>;
      expect(body['session']).toBeNull();
    });
  });

  describe('error handling', () => {
    it('throws FmgTransportError on HTTP failure', async () => {
      mockFetchError(502, 'Bad Gateway');

      await expect(client.get('/sys/status')).rejects.toThrow(FmgTransportError);
    });

    it('throws FmgTransportError on network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.get('/sys/status')).rejects.toThrow(FmgTransportError);
    });

    it('throws FmgApiError with empty result array', async () => {
      mockFetch({ id: 1, result: [] });

      await expect(client.get('/sys/status')).rejects.toThrow(FmgApiError);
    });
  });

  describe('request ID', () => {
    it('increments request ID across calls', async () => {
      mockFetch(makeSuccessResponse(1, '/url/1', null));
      mockFetch(makeSuccessResponse(2, '/url/2', null));

      await client.get('/url/1');
      await client.get('/url/2');

      const body1 = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<
        string,
        unknown
      >;
      const body2 = JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string) as Record<
        string,
        unknown
      >;

      expect(body1['id']).toBe(1);
      expect(body2['id']).toBe(2);
    });
  });
});
