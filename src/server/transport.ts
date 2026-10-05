/**
 * Transport layer — Stdio or Streamable HTTP
 *
 * Configures and starts the appropriate MCP transport based on
 * the MCP_TRANSPORT environment variable.
 */

import { SERVER_VERSION } from '../version.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from '../config.js';

/** Logger matching the shape used in index.ts */
interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

// ─── Rate Limiter ───────────────────────────────────────────────────

/** Simple sliding-window rate limiter per client IP */
class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly windows: Map<string, number[]> = new Map();

  constructor(windowMs: number = 60_000, maxRequests: number = 60) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /** Returns true if the request is allowed, false if rate-limited */
  allow(clientIp: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(clientIp);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(clientIp, timestamps);
    }

    // Remove expired timestamps
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxRequests) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /** Periodically clean up stale entries (call every ~5 minutes) */
  cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [ip, timestamps] of this.windows) {
      while (timestamps.length > 0 && timestamps[0]! < cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.windows.delete(ip);
      }
    }
  }
}

// ─── Request Stats ──────────────────────────────────────────────────

interface RequestStats {
  totalRequests: number;
  mcpRequests: number;
  healthRequests: number;
  rateLimited: number;
  errors: number;
  startedAt: string;
}

function createStats(): RequestStats {
  return {
    totalRequests: 0,
    mcpRequests: 0,
    healthRequests: 0,
    rateLimited: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
  };
}

/** Extract client IP from request (supports X-Forwarded-For) */
function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Constant-time check of the request's `Authorization` header against the
 * expected `Bearer <apiKey>` string. Returns true when they match.
 *
 * Uses `crypto.timingSafeEqual` to avoid leaking the API key via response-
 * time differences on early-mismatch. The length check is itself observable
 * but only reveals the length of the configured key, not its contents.
 */
function checkAuthHeader(req: IncomingMessage, expected: string): boolean {
  const provided = req.headers['authorization'];
  if (typeof provided !== 'string') return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Start the Stdio transport — reads from stdin, writes to stdout.
 */
export async function startStdioTransport(server: McpServer, logger: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server listening on stdio');

  // Graceful shutdown for stdio transport
  const shutdown = (): void => {
    logger.info('Shutting down stdio transport...');
    void transport.close().catch(() => {
      /* ignore close errors */
    });
    void server.close().catch(() => {
      /* ignore close errors */
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/**
 * Per-request context derived from the incoming HTTP request, passed to the
 * caller's `serverFactory`.
 */
export interface McpRequestContext {
  /**
   * Per-request FortiManager API token taken from the `X-FMG-Token` request
   * header (only populated when `MCP_TOKEN_PASSTHROUGH=true` is set on the
   * server *and* the client supplied the header). Undefined otherwise; the
   * caller should fall back to its configured default token.
   */
  fmgToken?: string;
}

/**
 * Options for {@link startHttpTransport}.
 */
export interface HttpTransportOptions {
  /**
   * Factory that returns a fresh `McpServer` instance for each MCP request.
   *
   * The transport runs in stateless mode (`sessionIdGenerator: undefined`),
   * so every request gets its own `McpServer` + `StreamableHTTPServerTransport`
   * pair. This avoids the "Server already initialized" failure that occurs
   * when a single `McpServer` is reused across multiple client `initialize`
   * handshakes, and matches the SDK's reference stateless pattern.
   *
   * Shared, expensive resources (FortiManager client, QuickJS WASM, executors)
   * should be captured in the closure passed here so they are reused across
   * requests rather than rebuilt every time.
   *
   * The optional `ctx` argument carries per-request fields derived from HTTP
   * headers — most importantly the per-MCP-client FortiManager token when
   * `MCP_TOKEN_PASSTHROUGH=true`.
   */
  serverFactory: (ctx: McpRequestContext) => McpServer;
  /** Optional HTTP server bind host. Defaults to Node's default (all interfaces). */
  host?: string;
  /**
   * If set, every `/mcp` request must include
   * `Authorization: Bearer <apiKey>`. Missing / malformed / wrong tokens are
   * rejected with `401` and a `WWW-Authenticate: Bearer realm="mcp"` header.
   * Unset = open endpoint (preserves current behavior).
   */
  apiKey?: string;
  /**
   * When `true`, the transport reads `X-FMG-Token` from each `/mcp` request
   * and exposes it on `McpRequestContext.fmgToken`. When `false` (default)
   * the header is ignored and `ctx.fmgToken` is always undefined.
   */
  tokenPassthrough?: boolean;
}

/**
 * Internal handle used by tests to inspect the underlying HTTP server and
 * trigger a clean shutdown without going through SIGINT/SIGTERM.
 */
export interface HttpTransportHandle {
  /** The underlying Node HTTP server (already listening). */
  readonly httpServer: ReturnType<typeof createServer>;
  /** The actual port the server is bound to (useful when port 0 is requested). */
  readonly port: number;
  /** Close the HTTP server and clear internal timers. */
  close: () => Promise<void>;
}

/**
 * Start the Streamable HTTP transport — spins up a Node.js HTTP server.
 *
 * Each incoming `/mcp` request gets its own `McpServer` and stateless
 * `StreamableHTTPServerTransport`, so multiple clients (or reconnects from
 * the same client) can `initialize` independently. The shared rate limiter,
 * request stats and health endpoint stay process-wide.
 */
export async function startHttpTransport(
  options: HttpTransportOptions,
  config: AppConfig,
  logger: Logger,
): Promise<HttpTransportHandle> {
  const { serverFactory, apiKey, tokenPassthrough = false } = options;

  const stats = createStats();
  const rateLimiter = new RateLimiter(60_000, 60); // 60 requests per minute per IP

  // Pre-compute the expected `Authorization` header once so the per-request
  // check is just a constant-time buffer compare.
  const expectedAuthHeader = apiKey ? `Bearer ${apiKey}` : undefined;

  // Periodic cleanup of rate limiter state (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    rateLimiter.cleanup();
  }, 300_000);
  cleanupInterval.unref(); // Don't prevent process exit

  const httpServer = createServer(
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    async (req: IncomingMessage, res: ServerResponse) => {
      const startTime = Date.now();
      const clientIp = getClientIp(req);
      stats.totalRequests++;

      try {
        const url = req.url ?? '/';

        // Health-check endpoint (not rate-limited)
        if (url === '/health' && req.method === 'GET') {
          stats.healthRequests++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              version: SERVER_VERSION,
              uptime: Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
              stats: {
                totalRequests: stats.totalRequests,
                mcpRequests: stats.mcpRequests,
                rateLimited: stats.rateLimited,
                errors: stats.errors,
              },
            }),
          );
          return;
        }

        // Rate limiting for MCP endpoint
        if (url === '/mcp' && !rateLimiter.allow(clientIp)) {
          stats.rateLimited++;
          logger.info(`Rate limited: ${clientIp} ${req.method ?? 'UNKNOWN'} ${url}`);
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          });
          res.end(JSON.stringify({ error: 'Too many requests. Limit: 60 per minute.' }));
          return;
        }

        // MCP endpoint — handle POST, GET, DELETE for Streamable HTTP
        if (url === '/mcp') {
          // Optional Bearer auth gate (only when MCP_API_KEY is configured).
          // Runs before request bookkeeping so unauthenticated requests don't
          // pollute the mcpRequests counter.
          if (expectedAuthHeader && !checkAuthHeader(req, expectedAuthHeader)) {
            stats.errors++;
            logger.info(`Unauthorized: ${clientIp} ${req.method ?? 'UNKNOWN'} ${url}`);
            res.writeHead(401, {
              'Content-Type': 'application/json',
              'WWW-Authenticate': 'Bearer realm="mcp"',
            });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32001, message: 'Unauthorized' },
                id: null,
              }),
            );
            return;
          }

          stats.mcpRequests++;
          const ctx: McpRequestContext = {};
          if (tokenPassthrough) {
            const headerToken = req.headers['x-fmg-token'];
            if (typeof headerToken === 'string' && headerToken.length > 0) {
              ctx.fmgToken = headerToken;
            }
          }
          logger.info(
            `MCP ${req.method ?? 'UNKNOWN'} from ${clientIp}${ctx.fmgToken ? ' [token=passthrough]' : ''}`,
          );
          await handleMcpRequest(req, res, () => serverFactory(ctx), logger);
          const elapsed = Date.now() - startTime;
          logger.info(`MCP ${req.method ?? 'UNKNOWN'} completed in ${String(elapsed)}ms`);
          return;
        }

        // Fallback
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (err: unknown) {
        stats.errors++;
        logger.error('HTTP handler error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    },
  );

  await new Promise<void>((resolvePromise) => {
    httpServer.listen(config.mcpHttpPort, options.host, () => {
      const address = httpServer.address();
      const boundPort =
        typeof address === 'object' && address !== null ? address.port : config.mcpHttpPort;
      logger.info(`MCP HTTP server listening on port ${String(boundPort)}`);
      logger.info(`  Health:  http://localhost:${String(boundPort)}/health`);
      logger.info(`  MCP:     http://localhost:${String(boundPort)}/mcp`);
      resolvePromise();
    });
  });

  const address = httpServer.address();
  const boundPort =
    typeof address === 'object' && address !== null ? address.port : config.mcpHttpPort;

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = (): void => {
    void close();
  };

  const close = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Detach signal handlers we installed so calling close() (e.g. in tests)
    // doesn't leak listeners on the global process.
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    logger.info('Shutting down HTTP server...');
    clearInterval(cleanupInterval);
    await new Promise<void>((resolvePromise) => {
      httpServer.close(() => {
        resolvePromise();
      });
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { httpServer, port: boundPort, close };
}

/**
 * Handle a single `/mcp` request with a fresh server + transport pair.
 *
 * The MCP TypeScript SDK's `McpServer` is single-use w.r.t. the `initialize`
 * handshake — once initialized, subsequent `initialize` requests are rejected
 * with `-32600 "Server already initialized"`. To support multiple sequential
 * (or concurrent) clients on the HTTP transport, we therefore construct a
 * fresh `McpServer` and `StreamableHTTPServerTransport` for every request,
 * matching the SDK's reference stateless pattern.
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  serverFactory: () => McpServer,
  logger: Logger,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    // Stateless mode — see {@link HttpTransportOptions.serverFactory} for rationale.
    sessionIdGenerator: undefined,
  });
  const server = serverFactory();

  // Make sure we tear down both ends when the client disconnects or the
  // response finishes, even if `handleRequest` throws.
  const cleanup = (): void => {
    void transport.close().catch((err: unknown) => {
      logger.error('Error closing transport:', err);
    });
    void server.close().catch((err: unknown) => {
      logger.error('Error closing server:', err);
    });
  };
  res.on('close', cleanup);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err: unknown) {
    cleanup();
    throw err;
  }
}
