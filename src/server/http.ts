/**
 * HTTP edge — health, rate limiting, static Bearer auth and MCP serving.
 *
 * Everything above node:http is web-standard: routes are pure
 * request-to-response functions, testable via `app.fetch(request, peer)`.
 * `listenHttp` is the only part that touches the socket.
 */

import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { SERVER_VERSION } from '../version.js';
import { buildServer, type CallerScope, type ToolDeps } from './server.js';

/** Logger matching the shape used in index.ts */
export interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

/** The caller's network identity — a web-standard Request has no socket. */
export interface Peer {
  ip: string;
}

export interface HttpAppOptions {
  deps: ToolDeps;
  apiKey?: string;
  tokenPassthrough: boolean;
  logger: Logger;
  /** Override the sliding window (tests); production keeps 60 req/min per IP. */
  rateLimit?: { windowMs: number; max: number };
}

export interface HttpApp {
  fetch: (request: Request, peer: Peer) => Promise<Response>;
  close: () => Promise<void>;
}

export interface HttpListener {
  /** The actual port the server is bound to (useful when port 0 is requested). */
  readonly port: number;
  close: () => Promise<void>;
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

// ─── Header / Caller Helpers ────────────────────────────────────────

/** Extract client IP from the node request (supports X-Forwarded-For) */
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
function bearerMatches(request: Request, expected: string): boolean {
  const provided = request.headers.get('authorization');
  if (provided === null) return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Full caller scope for a request. Deliberately `{}` on stdio and when the
 * header is absent or empty, so the executor falls back to `FMG_API_TOKEN`.
 */
function callerFrom(request: Request | undefined, passthrough: boolean): CallerScope {
  if (!passthrough || !request) return {};
  const fmgToken = request.headers.get('x-fmg-token');
  return fmgToken ? { fmgToken } : {};
}

// ─── HTTP App ───────────────────────────────────────────────────────

/**
 * Build the HTTP edge: `/health`, the per-IP rate limit, the static Bearer
 * gate and the MCP handler, in that order of precedence.
 */
export function createHttpApp(opts: HttpAppOptions): HttpApp {
  const stats = createStats();
  const rateLimiter = new RateLimiter(
    opts.rateLimit?.windowMs ?? 60_000,
    opts.rateLimit?.max ?? 60, // 60 requests per minute per IP
  );

  // Pre-compute the expected `Authorization` header once so the per-request
  // check is just a constant-time buffer compare.
  const expectedAuthHeader = opts.apiKey ? `Bearer ${opts.apiKey}` : undefined;

  const mcp = createMcpHandler(
    (ctx) => buildServer(opts.deps, callerFrom(ctx.requestInfo, opts.tokenPassthrough)),
    { onerror: (error) => opts.logger.error('MCP handler error:', error) },
  );

  // Periodic cleanup of rate limiter state (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    rateLimiter.cleanup();
  }, 300_000);
  cleanupInterval.unref(); // Don't prevent process exit

  const json = (status: number, body: unknown, headers?: Record<string, string>): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

  let closed = false;

  const fetch = async (request: Request, peer: Peer): Promise<Response> => {
    const startTime = Date.now();
    stats.totalRequests++;

    try {
      const path = new URL(request.url).pathname;
      const method = request.method;

      // Health-check endpoint (not rate-limited, no auth)
      if (path === '/health' && method === 'GET') {
        stats.healthRequests++;
        return json(200, {
          status: 'ok',
          version: SERVER_VERSION,
          uptime: Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
          stats: {
            totalRequests: stats.totalRequests,
            mcpRequests: stats.mcpRequests,
            rateLimited: stats.rateLimited,
            errors: stats.errors,
          },
        });
      }

      if (path === '/mcp') {
        // Rate limiting before anything else on the MCP endpoint
        if (!rateLimiter.allow(peer.ip)) {
          stats.rateLimited++;
          opts.logger.info(`Rate limited: ${peer.ip} ${method} ${path}`);
          return json(
            429,
            { error: 'Too many requests. Limit: 60 per minute.' },
            { 'Retry-After': '60' },
          );
        }

        // Optional Bearer auth gate (only when MCP_API_KEY is configured).
        // Runs before request bookkeeping so unauthenticated requests don't
        // pollute the mcpRequests counter.
        if (expectedAuthHeader && !bearerMatches(request, expectedAuthHeader)) {
          stats.errors++;
          opts.logger.info(`Unauthorized: ${peer.ip} ${method} ${path}`);
          return json(
            401,
            {
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Unauthorized' },
              id: null,
            },
            { 'WWW-Authenticate': 'Bearer realm="mcp"' },
          );
        }

        stats.mcpRequests++;
        const passthroughToken = opts.tokenPassthrough ? request.headers.get('x-fmg-token') : null;
        opts.logger.info(
          `MCP ${method} from ${peer.ip}${passthroughToken ? ' [token=passthrough]' : ''}`,
        );
        const response = await mcp.fetch(request);
        opts.logger.info(`MCP ${method} completed in ${String(Date.now() - startTime)}ms`);
        return response;
      }

      return json(404, { error: 'Not found' });
    } catch (err: unknown) {
      stats.errors++;
      opts.logger.error('HTTP handler error:', err);
      return json(500, { error: 'Internal server error' });
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(cleanupInterval);
    await mcp.close();
  };

  return { fetch, close };
}

// ─── Node Listener ──────────────────────────────────────────────────

/**
 * Bind the app to a node:http server. The adapter closure is rebuilt per
 * request so each one sees its own socket address; it is cheap and keeps SSE
 * backpressure intact.
 */
export function listenHttp(
  app: HttpApp,
  at: { port: number; host?: string },
): Promise<HttpListener> {
  const httpServer = createServer((req, res) => {
    const handle = toNodeHandler({
      fetch: (request) => app.fetch(request, { ip: getClientIp(req) }),
    });
    void handle(req, res);
  });

  return new Promise<HttpListener>((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise);
    httpServer.listen(at.port, at.host, () => {
      const address = httpServer.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : at.port;

      resolvePromise({
        port: boundPort,
        close: async (): Promise<void> => {
          await new Promise<void>((resolveClose) => {
            httpServer.close(() => {
              resolveClose();
            });
          });
          await app.close();
        },
      });
    });
  });
}
