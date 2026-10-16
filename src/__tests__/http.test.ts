/**
 * Tests for the HTTP edge — `createHttpApp` (routing, auth, rate limiting)
 * and `listenHttp` (the node socket + the full MCP handshake in both protocol
 * eras).
 *
 * Two layers:
 * - Socket-free: `app.fetch(new Request(...), { ip })` covers `/health`, 404s,
 *   the Bearer gate and the per-IP rate limit without opening a port.
 * - Over a real socket: `listenHttp(app, { port: 0 })` + a v2 `Client` covers
 *   the full handshake (legacy and modern era) and `X-FMG-Token` passthrough
 *   down to the mocked FortiManager client. Raw requests with an unfinished
 *   body pin down that every gate decides before that body is read.
 *
 * The sequential-clients test guards
 * https://github.com/jmpijll/fortimanager-code-mode-mcp/issues/13: every
 * `/mcp` request must be able to run its own handshake against a freshly
 * built server instance.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';

import {
  createHttpApp,
  listenHttp,
  type HttpApp,
  type HttpListener,
  type Logger,
} from '../server/http.js';
import { SearchExecutor } from '../executor/search-executor.js';
import { CodeExecutor } from '../executor/code-executor.js';
import { FmgClient } from '../client/fmg-client.js';
import { SAMPLE_SPEC, SAMPLE_CLIENT_CONFIG, makeSuccessResponse } from './fixtures/index.js';

// ─── Shared Helpers ─────────────────────────────────────────────────

const silentLogger: Logger = {
  info: (): void => {
    /* noop */
  },
  error: (): void => {
    /* noop */
  },
};

const EXECUTOR_OPTIONS = { timeoutMs: 5_000, maxMemoryBytes: 16 * 1024 * 1024 };

/** A 2025-era `initialize` payload, byte-identical to what old clients send. */
const INITIALIZE_2025 = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fetch-client', version: '1.0.0' },
  },
};

function mcpPost(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Parse the first JSON-RPC message out of a one-shot SSE response body. */
async function firstSseMessage(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`No data line in SSE response: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

// ─── Raw Socket Helpers ─────────────────────────────────────────────

/**
 * Write raw HTTP bytes and resolve with the response once the server closes
 * the connection. The caller never finishes the request body, so a response
 * that arrives proves the gate answered without buffering that body.
 */
function probeRawResponse(port: number, requestBytes: string, timeoutMs = 500): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const socket = netConnect(port, '127.0.0.1');
    socket.setEncoding('utf8');
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error('no response before the request body was completed'));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(requestBytes);
    });
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolvePromise(received);
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      // The server tearing the socket down after the answer is expected.
      if (received.length > 0) resolvePromise(received);
      else rejectPromise(err);
    });
  });
}

/** Head of a `POST` whose declared two-byte body is only half sent. */
function partialBodyHead(path: string, headers: string[] = []): string {
  return [
    `POST ${path} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Content-Type: application/json',
    'Content-Length: 2',
    ...headers,
    '',
    'x',
  ].join('\r\n');
}

/** Head of a `POST` claiming a 4 MiB + 1 body that is never sent. */
function oversizedBodyHead(path: string, headers: string[] = []): string {
  return [
    `POST ${path} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Content-Type: application/json',
    'Content-Length: 4194305',
    ...headers,
    '',
    '',
  ].join('\r\n');
}

// ─── App Harness ────────────────────────────────────────────────────

interface AppOptions {
  apiKey?: string;
  tokenPassthrough?: boolean;
  rateLimit?: { windowMs: number; max: number };
}

interface AppHarness {
  app: HttpApp;
  /** Shared client used by the executors — mock `rawRequest` on it. */
  fmgClient: FmgClient;
}

const openApps: HttpApp[] = [];
const openListeners: HttpListener[] = [];

afterEach(async () => {
  for (const listener of openListeners.splice(0)) {
    await listener.close();
  }
  for (const app of openApps.splice(0)) {
    await app.close();
  }
  vi.restoreAllMocks();
});

function makeApp(opts: AppOptions = {}): AppHarness {
  const searchExecutor = new SearchExecutor(SAMPLE_SPEC, EXECUTOR_OPTIONS);
  const fmgClient = new FmgClient(SAMPLE_CLIENT_CONFIG);
  vi.spyOn(fmgClient, 'rawRequest');
  const codeExecutor = new CodeExecutor(fmgClient, EXECUTOR_OPTIONS);

  const app = createHttpApp({
    deps: { searchExecutor, codeExecutor, specVersion: '7.6' },
    apiKey: opts.apiKey,
    tokenPassthrough: opts.tokenPassthrough ?? false,
    logger: silentLogger,
    rateLimit: opts.rateLimit,
  });
  openApps.push(app);

  return { app, fmgClient };
}

interface ListenerHarness extends AppHarness {
  baseUrl: URL;
}

async function makeListener(opts: AppOptions = {}): Promise<ListenerHarness> {
  const harness = makeApp(opts);
  // Bind to loopback so a test run never exposes a public port.
  const listener = await listenHttp(harness.app, { port: 0, host: '127.0.0.1' });
  openListeners.push(listener);

  return { ...harness, baseUrl: new URL(`http://127.0.0.1:${String(listener.port)}/mcp`) };
}

interface TestClient {
  client: Client;
  close: () => Promise<void>;
}

interface ConnectOptions {
  era?: VersionNegotiationOptions;
  headers?: Record<string, string>;
}

async function connect(baseUrl: URL, opts: ConnectOptions = {}): Promise<TestClient> {
  const transport = new StreamableHTTPClientTransport(
    baseUrl,
    opts.headers ? { requestInit: { headers: opts.headers } } : undefined,
  );
  const clientOptions: ClientOptions | undefined = opts.era
    ? { versionNegotiation: opts.era }
    : undefined;
  const client = new Client({ name: 'http-test-client', version: '1.0.0' }, clientOptions);
  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

function textBlocks(result: { content: unknown }): string[] {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '');
}

// ─── Routing (no socket) ────────────────────────────────────────────

describe('createHttpApp — routing without a socket', () => {
  it('serves /health with the server version and request stats', async () => {
    const { app } = makeApp();
    const res = await app.fetch(new Request('http://localhost/health'), { ip: '10.0.0.1' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      version: string;
      stats: { totalRequests: number; mcpRequests: number };
    };
    const packageInfo = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(body.status).toBe('ok');
    expect(body.version).toBe(packageInfo.version);
    expect(body.stats.totalRequests).toBe(1);
    expect(body.stats.mcpRequests).toBe(0);
  });

  it('returns a 404 JSON body for unknown paths', async () => {
    const { app } = makeApp();
    const res = await app.fetch(new Request('http://localhost/unknown'), { ip: '10.0.0.1' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 for methods other than GET on /health', async () => {
    const { app } = makeApp();
    const res = await app.fetch(new Request('http://localhost/health', { method: 'POST' }), {
      ip: '10.0.0.1',
    });

    expect(res.status).toBe(404);
  });

  it('answers GET /mcp with 405 from the MCP handler', async () => {
    const { app } = makeApp();
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { Accept: 'application/json, text/event-stream' },
      }),
      { ip: '10.0.0.1' },
    );

    expect(res.status).toBe(405);
  });

  it('completes a 2025-era initialize from a plain JSON request', async () => {
    const { app } = makeApp();
    const res = await app.fetch(mcpPost(INITIALIZE_2025), { ip: '10.0.0.1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    // The legacy handler answers on a one-shot SSE stream; the JSON-RPC
    // result is the `data:` line.
    const message = await firstSseMessage(res);
    expect(message['id']).toBe(1);
    const result = message['result'] as
      { protocolVersion?: string; serverInfo?: { name?: string } } | undefined;
    expect(result?.protocolVersion).toBe('2025-06-18');
    expect(result?.serverInfo?.name).toBe('fortimanager-code-mode');
  });

  it('rejects a POST that does not accept both content types with 406', async () => {
    const { app } = makeApp();
    const res = await app.fetch(mcpPost(INITIALIZE_2025, { Accept: 'application/json' }), {
      ip: '10.0.0.1',
    });

    expect(res.status).toBe(406);
  });
});

// ─── Auth gate (MCP_API_KEY, no socket) ─────────────────────────────

describe('createHttpApp — MCP_API_KEY gate', () => {
  const API_KEY = 'unit-test-mcp-api-key-1234567890';

  it('rejects a request without an Authorization header with 401', async () => {
    const { app } = makeApp({ apiKey: API_KEY });
    const res = await app.fetch(mcpPost(INITIALIZE_2025), { ip: '10.0.0.1' });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="mcp"');
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toBe('Unauthorized');
  });

  it('rejects a wrong Bearer token with 401', async () => {
    const { app } = makeApp({ apiKey: API_KEY });
    const res = await app.fetch(mcpPost(INITIALIZE_2025, { Authorization: 'Bearer wrong-key' }), {
      ip: '10.0.0.1',
    });

    expect(res.status).toBe(401);
  });

  it('rejects a malformed Authorization header with 401', async () => {
    const { app } = makeApp({ apiKey: API_KEY });
    // No "Bearer " prefix — a bare key must not be accepted.
    const res = await app.fetch(mcpPost(INITIALIZE_2025, { Authorization: API_KEY }), {
      ip: '10.0.0.1',
    });

    expect(res.status).toBe(401);
  });

  it('accepts the correct Bearer token', async () => {
    const { app } = makeApp({ apiKey: API_KEY });
    const res = await app.fetch(mcpPost(INITIALIZE_2025, { Authorization: `Bearer ${API_KEY}` }), {
      ip: '10.0.0.1',
    });

    expect(res.status).toBe(200);
  });

  it('leaves /health open (no auth required for healthchecks)', async () => {
    const { app } = makeApp({ apiKey: API_KEY });
    const res = await app.fetch(new Request('http://localhost/health'), { ip: '10.0.0.1' });

    expect(res.status).toBe(200);
  });
});

// ─── Rate limiting (no socket) ──────────────────────────────────────

describe('createHttpApp — per-IP rate limiting', () => {
  const SMALL_LIMIT = { windowMs: 60_000, max: 2 };

  it('returns 429 with Retry-After once the window limit is exceeded', async () => {
    const { app } = makeApp({ rateLimit: SMALL_LIMIT });
    const send = (): Promise<Response> => app.fetch(mcpPost(INITIALIZE_2025), { ip: '10.0.0.1' });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    const body = (await limited.json()) as { error?: string };
    expect(body.error).toContain('Too many requests');
  });

  it('tracks each client IP independently', async () => {
    const { app } = makeApp({ rateLimit: { windowMs: 60_000, max: 1 } });

    expect((await app.fetch(mcpPost(INITIALIZE_2025), { ip: '10.0.0.1' })).status).toBe(200);
    expect((await app.fetch(mcpPost(INITIALIZE_2025), { ip: '10.0.0.1' })).status).toBe(429);
    expect((await app.fetch(mcpPost(INITIALIZE_2025), { ip: '10.0.0.2' })).status).toBe(200);
  });

  it('exempts /health from the rate limit', async () => {
    const { app } = makeApp({ rateLimit: { windowMs: 60_000, max: 1 } });

    expect((await app.fetch(mcpPost(INITIALIZE_2025), { ip: '10.0.0.1' })).status).toBe(200);
    expect((await app.fetch(mcpPost(INITIALIZE_2025), { ip: '10.0.0.1' })).status).toBe(429);

    const health = await app.fetch(new Request('http://localhost/health'), { ip: '10.0.0.1' });
    expect(health.status).toBe(200);
  });
});

// ─── Gates run before the body (real socket) ────────────────────────

describe('listenHttp — gate responses before the request body', () => {
  const API_KEY = 'gate-before-body-key';

  it('answers an unauthenticated POST before its body is complete', async () => {
    const { baseUrl } = await makeListener({ apiKey: API_KEY });
    const response = await probeRawResponse(Number(baseUrl.port), partialBodyHead('/mcp'));

    expect(response).toMatch(/^HTTP\/1\.1 401 /);
    expect(response.toLowerCase()).toContain('www-authenticate: bearer realm="mcp"');
  });

  it('answers a rate-limited POST before its body is complete', async () => {
    const { app, baseUrl } = await makeListener({
      apiKey: API_KEY,
      rateLimit: { windowMs: 60_000, max: 1 },
    });
    const authorized = mcpPost(INITIALIZE_2025, { Authorization: `Bearer ${API_KEY}` });
    expect((await app.fetch(authorized, { ip: '10.0.0.1' })).status).toBe(200);

    const response = await probeRawResponse(
      Number(baseUrl.port),
      partialBodyHead('/mcp', ['X-Forwarded-For: 10.0.0.1']),
    );

    expect(response).toMatch(/^HTTP\/1\.1 429 /);
    expect(response.toLowerCase()).toContain('retry-after: 60');
  });

  it('answers an unknown path before its body is complete', async () => {
    const { baseUrl } = await makeListener();
    const response = await probeRawResponse(Number(baseUrl.port), partialBodyHead('/unknown'));

    expect(response).toMatch(/^HTTP\/1\.1 404 /);
    expect(response).toContain('{"error":"Not found"}');
  });

  it('challenges an unauthenticated oversized body instead of returning 413', async () => {
    const { baseUrl } = await makeListener({ apiKey: API_KEY });
    const response = await probeRawResponse(Number(baseUrl.port), oversizedBodyHead('/mcp'));

    expect(response).toMatch(/^HTTP\/1\.1 401 /);
    expect(response.toLowerCase()).toContain('www-authenticate: bearer realm="mcp"');
  });

  it('still applies the SDK body cap to an authenticated request', async () => {
    const { baseUrl } = await makeListener({ apiKey: API_KEY });
    const response = await probeRawResponse(
      Number(baseUrl.port),
      oversizedBodyHead('/mcp', [`Authorization: Bearer ${API_KEY}`]),
    );

    expect(response).toMatch(/^HTTP\/1\.1 413 /);
  });
});

// ─── Over a socket: both protocol eras ──────────────────────────────

const CLIENT_ERAS: Array<{ label: string; era?: VersionNegotiationOptions }> = [
  { label: 'modern era (pinned 2026-07-28)', era: { mode: { pin: '2026-07-28' } } },
  { label: 'legacy era (default client)', era: undefined },
];

describe.each(CLIENT_ERAS)('listenHttp — $label', ({ era }) => {
  it('performs a handshake, lists the tools and reports the server version', async () => {
    const { baseUrl } = await makeListener();
    const { client, close } = await connect(baseUrl, { era });

    try {
      const packageInfo = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      expect(client.getServerVersion()?.version).toBe(packageInfo.version);

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(['execute', 'search']);

      const result = await client.callTool({
        name: 'search',
        arguments: {
          code: 'specIndex.filter(function(o) { return o.name.indexOf("firewall") === 0; }).map(function(o) { return o.name; })',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(textBlocks(result)[0]!)).toEqual(['firewall/address', 'firewall/addrgrp']);
    } finally {
      await close();
    }
  });

  it('supports two independent clients initializing sequentially', async () => {
    const { baseUrl } = await makeListener();

    for (const name of ['test-client-a', 'test-client-b']) {
      const transport = new StreamableHTTPClientTransport(baseUrl);
      const clientOptions: ClientOptions | undefined = era
        ? { versionNegotiation: era }
        : undefined;
      const client = new Client({ name, version: '1.0.0' }, clientOptions);
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual(['execute', 'search']);
      } finally {
        await client.close();
      }
    }
  });

  it('forwards a per-request X-FMG-Token to FortiManager', async () => {
    const { baseUrl, fmgClient } = await makeListener({ tokenPassthrough: true });
    vi.mocked(fmgClient.rawRequest).mockResolvedValue(
      makeSuccessResponse(1, '/sys/status', { Hostname: 'test-fmg', Version: '7.6.6' }),
    );
    const { client, close } = await connect(baseUrl, {
      era,
      headers: { 'X-FMG-Token': 'per-request-token-abc' },
    });

    try {
      const result = await client.callTool({
        name: 'execute',
        arguments: {
          code: 'var r = fortimanager.request("get", [{ url: "/sys/status" }]); r.result[0].data.Hostname',
        },
      });

      expect(result.isError).not.toBe(true);
      expect(textBlocks(result).join('\n')).toContain('test-fmg');
      expect(fmgClient.rawRequest).toHaveBeenCalledWith('get', [{ url: '/sys/status' }], {
        tokenOverride: 'per-request-token-abc',
      });
    } finally {
      await close();
    }
  });

  it('falls back to the configured token when X-FMG-Token is absent', async () => {
    const { baseUrl, fmgClient } = await makeListener({ tokenPassthrough: true });
    vi.mocked(fmgClient.rawRequest).mockResolvedValue(
      makeSuccessResponse(1, '/sys/status', { Hostname: 'test-fmg' }),
    );
    const { client, close } = await connect(baseUrl, { era });

    try {
      await client.callTool({
        name: 'execute',
        arguments: {
          code: 'var r = fortimanager.request("get", [{ url: "/sys/status" }]); r.result[0].data',
        },
      });

      // No tokenOverride means the executor uses FmgClient's configured token.
      expect(fmgClient.rawRequest).toHaveBeenCalledWith('get', [{ url: '/sys/status' }], undefined);
    } finally {
      await close();
    }
  });

  it('treats an empty X-FMG-Token as absent', async () => {
    const { baseUrl, fmgClient } = await makeListener({ tokenPassthrough: true });
    vi.mocked(fmgClient.rawRequest).mockResolvedValue(
      makeSuccessResponse(1, '/sys/status', { Hostname: 'test-fmg' }),
    );
    const { client, close } = await connect(baseUrl, { era, headers: { 'X-FMG-Token': '' } });

    try {
      await client.callTool({
        name: 'execute',
        arguments: {
          code: 'var r = fortimanager.request("get", [{ url: "/sys/status" }]); r.result[0].data',
        },
      });

      expect(fmgClient.rawRequest).toHaveBeenCalledWith('get', [{ url: '/sys/status' }], undefined);
    } finally {
      await close();
    }
  });

  it('ignores X-FMG-Token when passthrough is off', async () => {
    const { baseUrl, fmgClient } = await makeListener();
    vi.mocked(fmgClient.rawRequest).mockResolvedValue(
      makeSuccessResponse(1, '/sys/status', { Hostname: 'test-fmg' }),
    );
    const { client, close } = await connect(baseUrl, {
      era,
      headers: { 'X-FMG-Token': 'should-be-ignored' },
    });

    try {
      await client.callTool({
        name: 'execute',
        arguments: {
          code: 'var r = fortimanager.request("get", [{ url: "/sys/status" }]); r.result[0].data',
        },
      });

      expect(fmgClient.rawRequest).toHaveBeenCalledWith('get', [{ url: '/sys/status' }], undefined);
    } finally {
      await close();
    }
  });
});

// ─── Over a socket: gate + passthrough together ─────────────────────

describe('listenHttp — MCP_API_KEY + MCP_TOKEN_PASSTHROUGH together', () => {
  const API_KEY = 'gate-key-and-token-passthrough-combo';

  it('uses Authorization for the gate and X-FMG-Token for the FMG token', async () => {
    const { baseUrl, fmgClient } = await makeListener({
      apiKey: API_KEY,
      tokenPassthrough: true,
    });
    vi.mocked(fmgClient.rawRequest).mockResolvedValue(
      makeSuccessResponse(1, '/sys/status', { Hostname: 'combo-test' }),
    );
    const { client, close } = await connect(baseUrl, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'X-FMG-Token': 'combo-fmg-token',
      },
    });

    try {
      await client.callTool({
        name: 'execute',
        arguments: {
          code: 'var r = fortimanager.request("get", [{ url: "/sys/status" }]); r.result[0].data',
        },
      });

      expect(fmgClient.rawRequest).toHaveBeenCalledWith('get', [{ url: '/sys/status' }], {
        tokenOverride: 'combo-fmg-token',
      });
    } finally {
      await close();
    }
  });

  it('rejects a wrong gate key even with a valid X-FMG-Token', async () => {
    const { baseUrl, fmgClient } = await makeListener({
      apiKey: API_KEY,
      tokenPassthrough: true,
    });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-the-real-key',
        'X-FMG-Token': 'irrelevant',
      },
      body: JSON.stringify(INITIALIZE_2025),
    });

    expect(res.status).toBe(401);
    expect(fmgClient.rawRequest).not.toHaveBeenCalled();
  });
});
