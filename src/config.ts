/**
 * Configuration — Environment variable loading and validation
 *
 * Uses Zod for runtime validation of all environment variables.
 */

import { z } from 'zod';

// ─── Schema ─────────────────────────────────────────────────────────

const configSchema = z.object({
  /** FortiManager host URL */
  fmgHost: z.string().url('FMG_HOST must be a valid URL (e.g., https://fmg.example.com)'),

  /** FortiManager HTTPS port */
  fmgPort: z.coerce.number().int().min(1).max(65535).default(443),

  /** API token for authentication */
  fmgApiToken: z.string().min(1, 'FMG_API_TOKEN is required'),

  /** Whether to verify TLS certificates */
  fmgVerifySsl: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** API spec version to use */
  fmgApiVersion: z.enum(['7.4', '7.6']).default('7.6'),

  /** MCP transport mode */
  mcpTransport: z.enum(['http', 'stdio']).default('stdio'),

  /** HTTP server port (only for http transport) */
  mcpHttpPort: z.coerce.number().int().min(1).max(65535).default(8000),

  /**
   * Optional Bearer token required on the HTTP `/mcp` endpoint.
   *
   * When set, every MCP request must include `Authorization: Bearer <MCP_API_KEY>`
   * (case-insensitive scheme). When unset, the endpoint is open (preserving
   * current behavior). Stdio transport is unaffected — it's single-process and
   * doesn't have a network-facing surface.
   */
  mcpApiKey: z.string().min(1).optional(),

  /**
   * When true, the HTTP transport reads an `X-FMG-Token` header on each
   * `/mcp` request and uses that token (instead of `FMG_API_TOKEN`) when
   * calling FortiManager from inside the sandboxed `execute` tool. Requests
   * without the header fall back to `FMG_API_TOKEN`, so single-tenant
   * deployments keep working unchanged.
   *
   * Default `false`. Stdio transport is unaffected.
   */
  mcpTokenPassthrough: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof configSchema>;

// ─── Loader ─────────────────────────────────────────────────────────

/**
 * Load and validate configuration from environment variables.
 * Throws a descriptive error if validation fails.
 */
export function loadConfig(): AppConfig {
  const result = configSchema.safeParse({
    fmgHost: process.env['FMG_HOST'],
    fmgPort: process.env['FMG_PORT'],
    fmgApiToken: process.env['FMG_API_TOKEN'],
    fmgVerifySsl: process.env['FMG_VERIFY_SSL'],
    fmgApiVersion: process.env['FMG_API_VERSION'],
    mcpTransport: process.env['MCP_TRANSPORT'],
    mcpHttpPort: process.env['MCP_HTTP_PORT'],
    mcpApiKey: process.env['MCP_API_KEY'],
    mcpTokenPassthrough: process.env['MCP_TOKEN_PASSTHROUGH'],
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }

  return result.data;
}
