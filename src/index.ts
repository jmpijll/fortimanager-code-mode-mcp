#!/usr/bin/env node
/**
 * FortiManager Code Mode MCP Server — Entry Point
 *
 * Wires everything together:
 * 1. Validate configuration (env vars)
 * 2. Load the API spec JSON
 * 3. Pre-warm QuickJS WASM module
 * 4. Create FortiManager client
 * 5. Create QuickJS executors (search + code)
 * 6. Build MCP server with two tools
 * 7. Start the chosen transport (stdio or HTTP)
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { FmgClient } from './client/fmg-client.js';
import { SearchExecutor } from './executor/search-executor.js';
import { CodeExecutor } from './executor/code-executor.js';
import { getQuickJSModule } from './executor/executor.js';
import { createMcpServer } from './server/server.js';
import { startStdioTransport, startHttpTransport } from './server/transport.js';
import type { FmgApiSpec } from './types/spec-types.js';

// ─── Helpers ────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Simple structured logger that writes to stderr (stdout reserved for stdio transport) */
const logger = {
  info: (msg: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console.error(`[INFO] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console.error(`[WARN] ${msg}`, ...args);
  },
  error: (msg: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console.error(`[ERROR] ${msg}`, ...args);
  },
};

/**
 * Load the API spec JSON file for the configured version.
 */
async function loadSpec(version: string): Promise<FmgApiSpec> {
  const specPath = resolve(__dirname, `spec/fmg-api-spec-${version}.json`);
  logger.info(`Loading API spec from ${specPath}...`);

  let raw: string;
  try {
    raw = await readFile(specPath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `  API SPEC NOT FOUND\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `\n` +
        `  Could not load: fmg-api-spec-${version}.json\n` +
        `  Error: ${message}\n` +
        `\n` +
        `  The API spec files are NOT included in this package. You must generate\n` +
        `  them from FortiManager's JSON API Reference HTML documentation.\n` +
        `\n` +
        `  Steps:\n` +
        `    1. Download the FortiManager JSON API Reference from Fortinet FNDN:\n` +
        `       https://fndn.fortinet.net  (requires Fortinet account)\n` +
        `    2. Extract the HTML files into docs/api-reference/\n` +
        `    3. Run: npm run generate:spec\n` +
        `    4. Rebuild: npm run build\n` +
        `\n` +
        `  See README.md for detailed instructions.\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
    );
  }

  let spec: FmgApiSpec;
  try {
    spec = JSON.parse(raw) as FmgApiSpec;
  } catch {
    throw new Error(
      `Failed to parse API spec for version ${version}: invalid JSON. ` +
        `The spec file may be corrupted — try regenerating it.`,
    );
  }

  // Minimal shape validation
  if (
    !spec.version ||
    typeof spec.version !== 'string' ||
    !Array.isArray(spec.modules) ||
    spec.modules.length === 0
  ) {
    throw new Error(
      `Invalid API spec for version ${version}: missing or empty "version" or "modules" field. ` +
        `The spec file may be corrupted — try regenerating it.`,
    );
  }

  const totalObjects = spec.modules.reduce((sum, m) => sum + m.objects.length, 0);
  logger.info(
    `Loaded API spec v${spec.version} — ${String(spec.modules.length)} modules, ${String(totalObjects)} objects`,
  );

  return spec;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('FortiManager Code Mode MCP Server starting...');

  // 1. Load and validate configuration
  const config = loadConfig();
  logger.info(
    `Config: FMG=${config.fmgHost}:${String(config.fmgPort)}, API=${config.fmgApiVersion}, transport=${config.mcpTransport}`,
  );

  // 2. Load API spec
  const specStart = Date.now();
  const spec = await loadSpec(config.fmgApiVersion);
  logger.info(`Spec loaded in ${String(Date.now() - specStart)}ms`);

  // 3. Pre-warm QuickJS WASM module (avoids cold-start on first search call)
  const wasmStart = Date.now();
  await getQuickJSModule();
  logger.info(`QuickJS WASM initialized in ${String(Date.now() - wasmStart)}ms`);

  // 4. Create FortiManager client
  const client = new FmgClient({
    host: config.fmgHost,
    port: config.fmgPort,
    apiToken: config.fmgApiToken,
    verifySsl: config.fmgVerifySsl,
  });
  logger.info('FortiManager client created');

  // 5. Startup health check (non-fatal — search tool works without FMG)
  try {
    const health = await client.checkHealth();
    if (health.connected) {
      logger.info(
        `FortiManager connected — ${health.hostname ?? 'unknown'} v${health.version ?? 'unknown'}`,
      );
    } else {
      logger.warn(
        'FortiManager health check failed — execute tool may not work. Search tool is unaffected.',
      );
    }
  } catch {
    logger.warn('FortiManager unreachable — execute tool may not work. Search tool is unaffected.');
  }

  // 6. Create executors
  const executorStart = Date.now();
  const searchExecutor = new SearchExecutor(spec);
  const codeExecutor = new CodeExecutor(client);
  logger.info(`Executors created in ${String(Date.now() - executorStart)}ms`);

  // 7. Start transport
  //
  // The stdio transport is single-client by nature, so we build one McpServer
  // and reuse it. The HTTP transport must support multiple sequential clients
  // (each performs its own `initialize` handshake), so we pass a factory and
  // build a fresh McpServer per request — see `startHttpTransport` for details.
  if (config.mcpTransport === 'stdio') {
    if (config.mcpApiKey || config.mcpTokenPassthrough) {
      logger.warn(
        'MCP_API_KEY / MCP_TOKEN_PASSTHROUGH only apply to the HTTP transport — ignoring for stdio.',
      );
    }
    const server = createMcpServer({
      searchExecutor,
      codeExecutor,
      specVersion: config.fmgApiVersion,
      logger,
    });
    logger.info('MCP server created with search + execute tools');
    await startStdioTransport(server, logger);
  } else {
    if (config.mcpApiKey) {
      logger.info('MCP_API_KEY set — /mcp requires Authorization: Bearer <key>.');
    }
    if (config.mcpTokenPassthrough) {
      logger.info(
        'MCP_TOKEN_PASSTHROUGH=true — per-request X-FMG-Token header forwarded to FortiManager.',
      );
    }
    logger.info('MCP server factory ready (search + execute tools, per-request instance)');
    await startHttpTransport(
      {
        apiKey: config.mcpApiKey,
        tokenPassthrough: config.mcpTokenPassthrough,
        serverFactory: (ctx) =>
          createMcpServer({
            searchExecutor,
            codeExecutor,
            specVersion: config.fmgApiVersion,
            logger,
            fmgToken: ctx.fmgToken,
          }),
      },
      config,
      logger,
    );
  }
}

main().catch((err: unknown) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
