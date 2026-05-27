# FortiManager Code Mode MCP Server

> **Status**: Stable (v1.0.0) — validated against live FortiManager v7.6.6 with 152 tests.

[![CI](https://github.com/jmpijll/fortimanager-code-mode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jmpijll/fortimanager-code-mode-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for [Fortinet FortiManager](https://www.fortinet.com/products/management/fortimanager) that uses the **Code Mode** pattern — just 2 tools instead of 590+.

Instead of wrapping each API endpoint as a separate tool (which consumes ~118K tokens of context), this server exposes only `search` and `execute`. The AI agent writes JavaScript code that runs inside a secure [QuickJS WASM sandbox](https://github.com/nicolo-ribaudo/jit-less-quickjs) to query the API spec or execute live FortiManager JSON-RPC calls.

## Why Code Mode?

| Approach                              | Tools | Context Tokens | API Coverage |
| ------------------------------------- | ----- | -------------- | ------------ |
| Traditional MCP (1 tool per endpoint) | 590+  | ~118,000       | Full         |
| **Code Mode (this project)**          | **2** | **~1,000**     | **Full**     |

> **~99% reduction** in context tokens while maintaining full API coverage.

The Code Mode pattern was pioneered by [Cloudflare's MCP server](https://github.com/cloudflare/mcp-server-cloudflare) and adapted here for the FortiManager JSON-RPC API.

## Features

- **`search`** — Query the FortiManager API spec (URLs, objects, attributes, methods, error codes) via sandboxed JavaScript
- **`execute`** — Run live FortiManager JSON-RPC API calls via sandboxed JavaScript with `fortimanager.request()` proxy
- **Dual API version support** — Spec generator supports FortiManager 7.4.x and 7.6.x
- **QuickJS WASM sandbox** — Memory/CPU-limited code execution with no host access
- **Dual transport** — Stdio (for Claude Desktop / local dev) and Streamable HTTP (for Docker / production)
- **Docker-ready** — Multi-stage Alpine build with health checks
- **Tested against live FortiManager** — 152 tests (66 unit + 86 integration) passing against FMG v7.6.6
- **Security hardened** — HTTP timeout, response validation, sandbox method/params validation, log caps, code size limits

## Important: API Spec Required

> **This server will NOT work without generating the API spec files first.**

The API spec files are derived from Fortinet's FortiManager JSON API Reference documentation, which is proprietary and cannot be redistributed. You must download the HTML docs yourself and generate the spec locally.

### Step 1: Download the API Reference

1. Go to the **Fortinet Developer Network (FNDN)**: [https://fndn.fortinet.net](https://fndn.fortinet.net)
   - You need a Fortinet account (available to partners, customers, and NFR holders)
2. Navigate to **FortiManager** → **JSON API Reference**
3. Download the HTML reference archive for your FortiManager version (7.4.x or 7.6.x)

### Step 2: Extract the HTML Files

Extract the downloaded archive and place the HTML files in the `docs/api-reference/` directory:

```
docs/api-reference/
├── FortiManager-7.4.9-JSON-API-Reference/
│   └── html/
│       ├── adomobj-errors.htm
│       ├── adomobj-methods.htm
│       └── ... (all .htm files)
└── FortiManager-7.6.5-JSON-API-Reference/
    └── html/
        ├── adomobj-errors.htm
        ├── adomobj-methods.htm
        └── ... (all .htm files)
```

> You only need the version(s) you plan to use. The folder names must match the pattern above.

### Step 3: Generate the Spec

```bash
npm run generate:spec
```

This parses the HTML docs and produces:
- `src/spec/fmg-api-spec-7.4.json` (~99 MB)
- `src/spec/fmg-api-spec-7.6.json` (~127 MB)

### Step 4: Build

```bash
npm run build
```

The build step copies the generated spec files to `dist/spec/`. The server is now ready to use.

## Quick Start

### Prerequisites

- **Node.js** 20+ (LTS recommended)
- **npm** 9+
- A FortiManager instance with an [API token](https://docs.fortinet.com/document/fortimanager/7.6.0/administration-guide/924562)
- **API spec files** generated from FortiManager HTML docs (see [API Spec Required](#important-api-spec-required) above)

### From Source (Recommended)

```bash
# Clone the repository
git clone https://github.com/jmpijll/fortimanager-code-mode-mcp.git
cd fortimanager-code-mode-mcp

# Install dependencies
npm install

# Generate API spec (requires HTML docs in docs/api-reference/ — see above)
npm run generate:spec

# Build
npm run build

# Configure environment
cp .env.example .env
# Edit .env with your FortiManager details

# Start (stdio mode)
FMG_HOST=https://fmg.example.com FMG_API_TOKEN=your-token npm start

# Or development mode with hot reload
FMG_HOST=https://fmg.example.com FMG_API_TOKEN=your-token npm run dev
```

### Docker (Recommended for HTTP)

> **Note**: You must generate the spec files before building the Docker image. The Dockerfile copies them from `src/spec/` at build time.

```bash
# Clone and install
git clone https://github.com/jmpijll/fortimanager-code-mode-mcp.git
cd fortimanager-code-mode-mcp
npm install

# Generate API spec (requires HTML docs — see above)
npm run generate:spec

# Configure environment
cp .env.example .env
# Edit .env with your FortiManager details

# Run with Docker Compose
docker compose up -d --build

# Verify
curl http://localhost:8000/health
# → {"status":"ok","version":"1.0.0"}
```

### VS Code Copilot

> **Prerequisite**: You must have built the server from source with spec files generated first. Use `"command": "node"` with the path to your local build.

Create `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "fortimanager": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/fortimanager-code-mode-mcp/dist/index.js"],
      "env": {
        "FMG_HOST": "https://fortimanager.example.com",
        "FMG_PORT": "443",
        "FMG_API_TOKEN": "your-api-token-here",
        "FMG_VERIFY_SSL": "true",
        "FMG_API_VERSION": "7.6",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

### Claude Desktop (stdio)

> **Prerequisite**: You must have built the server from source with spec files generated first.

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "fortimanager": {
      "command": "node",
      "args": ["/path/to/fortimanager-code-mode-mcp/dist/index.js"],
      "env": {
        "FMG_HOST": "https://fortimanager.example.com",
        "FMG_API_TOKEN": "your-api-token",
        "FMG_API_VERSION": "7.6",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       AI Agent / LLM                         │
│                                                              │
│   "Find all firewall address objects and list their URLs"    │
└────────────────────────┬─────────────────────────────────────┘
                         │ MCP Protocol (stdio or HTTP)
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                    MCP Server (Node.js)                       │
│                                                              │
│  ┌─────────────────────┐  ┌────────────────────────────────┐ │
│  │   search tool        │  │   execute tool                 │ │
│  │                      │  │                                │ │
│  │  JS code → QuickJS   │  │  JS code → QuickJS (async)    │ │
│  │  sandbox             │  │  sandbox                      │ │
│  │                      │  │                                │ │
│  │  Globals:            │  │  Globals:                      │ │
│  │  • specIndex         │  │  • fortimanager.request()      │ │
│  │  • getObject()       │  │  • console.log()               │ │
│  │  • moduleList        │  │                                │ │
│  │  • errorCodes        │  │  Proxies to ──┐               │ │
│  │  • specVersion       │  │               │               │ │
│  └─────────────────────┘  └───────────────┼───────────────┘ │
│                                            │                 │
│                              ┌─────────────▼──────────────┐  │
│                              │  FortiManager JSON-RPC      │  │
│                              │  Client (fetch + auth)      │  │
│                              └─────────────┬──────────────┘  │
└────────────────────────────────────────────┼─────────────────┘
                                             │ HTTPS JSON-RPC
                                             ▼
                                  ┌────────────────────┐
                                  │   FortiManager      │
                                  │   (7.4.x / 7.6.x)  │
                                  └────────────────────┘
```

## Tool Usage Examples

### `search` — Query the API Spec

```javascript
// Find all firewall-related objects
specIndex.filter(function(o) {
  return o.name.includes('firewall');
}).map(function(o) {
  return { name: o.name, urls: o.urls, type: o.type };
})
```

```javascript
// Get full details of a specific object (all attributes, URLs, methods)
getObject('firewall/address')
```

```javascript
// Search by attribute name
specIndex.filter(function(o) { return o.attributeNames.includes('srcaddr'); }).map(function(o) { return o.name; })
```

```javascript
// Find objects by URL pattern
specIndex.filter(function(o) {
  return o.urls.some(function(u) { return u.includes('/dvmdb/'); });
}).map(function(o) { return { name: o.name, urls: o.urls }; })
```

### `execute` — Call the FortiManager API

```javascript
// List all ADOMs
var resp = fortimanager.request('get', [{ url: '/dvmdb/adom' }]);
resp.result[0].data;
```

```javascript
// Get system status
var resp = fortimanager.request('get', [{ url: '/sys/status' }]);
resp.result[0].data;
```

```javascript
// Create a firewall address object
var resp = fortimanager.request('add', [
  {
    url: '/pm/config/adom/root/obj/firewall/address',
    data: {
      name: 'web-server',
      subnet: ['10.0.1.100', '255.255.255.255'],
    },
  },
]);
resp.result[0].status;
```

```javascript
// Device proxy — get interfaces from a managed FortiGate
var resp = fortimanager.request('exec', [
  {
    url: '/sys/proxy/json',
    data: {
      target: ['/adom/root/device/my-fortigate'],
      action: 'get',
      resource: '/api/v2/monitor/system/interface',
    },
  },
]);
resp.result[0].data;
```

## Configuration

| Variable          | Required | Default | Description                                                                                                                       |
| ----------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `FMG_HOST`        | Yes      | —       | FortiManager URL (e.g., `https://fmg.example.com`)                                                                                |
| `FMG_PORT`        | No       | `443`   | HTTPS port                                                                                                                        |
| `FMG_API_TOKEN`   | Yes      | —       | API token for authentication ([how to create](https://docs.fortinet.com/document/fortimanager/7.6.0/administration-guide/924562)) |
| `FMG_VERIFY_SSL`  | No       | `true`  | Verify TLS certificates (`false` for self-signed certs)                                                                           |
| `FMG_API_VERSION` | No       | `7.6`   | API spec version (`7.4` or `7.6`)                                                                                                 |
| `MCP_TRANSPORT`   | No       | `stdio` | Transport mode (`http` or `stdio`)                                                                                                |
| `MCP_HTTP_PORT`   | No       | `8000`  | HTTP server port (only used with `http` transport)                                                                                |
| `MCP_API_KEY`     | No       | —       | If set, `/mcp` requires `Authorization: Bearer <key>`. HTTP transport only.                                                       |
| `MCP_TOKEN_PASSTHROUGH` | No | `false` | If `true`, read `X-FMG-Token` per request and forward to FortiManager. Missing header → fall back to `FMG_API_TOKEN`. HTTP only.   |

### Optional auth for the HTTP transport

The HTTP transport supports two independent auth dimensions, both off by default. The stdio transport is single-process and unaffected.

**Gate access to the MCP server itself.** Set `MCP_API_KEY=<long-random-string>` and every `/mcp` request must include `Authorization: Bearer <MCP_API_KEY>`. Missing or wrong tokens get `401`. `/health` stays open for health-checkers.

**Per-client FortiManager identity.** Set `MCP_TOKEN_PASSTHROUGH=true` and each MCP client can supply its own FortiManager admin token via the `X-FMG-Token` header. That token is used (instead of `FMG_API_TOKEN`) for live API calls made by the `execute` tool *for that request only*, so FortiManager's own admin-profile RBAC enforces per-user permissions. Requests without `X-FMG-Token` fall back to `FMG_API_TOKEN`, so existing single-tenant deployments keep working.

Both can be combined: `Authorization` gates the server, `X-FMG-Token` carries the per-client FMG token.

```json
{
  "mcpServers": {
    "fortimanager": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://fmg-mcp.example.com/mcp",
        "--header", "Authorization:Bearer ${MCP_API_KEY}",
        "--header", "X-FMG-Token:${MY_FMG_TOKEN}"
      ]
    }
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Run unit tests (66 tests across 5 suites)
npm test

# Run integration tests against a live FortiManager (requires .env)
npx tsx scripts/live-test.ts

# Lint
npm run lint

# Type check
npm run typecheck

# Format code
npm run format

# Build
npm run build

# Re-generate API specs from HTML docs
npm run generate:spec
```

### Project Structure

```
src/
├── client/           # FortiManager JSON-RPC client
│   ├── types.ts      # Request/response types, error codes
│   ├── auth.ts       # Token & session auth providers
│   └── fmg-client.ts # HTTP client (get/set/add/update/delete/exec/clone/move)
├── executor/         # QuickJS WASM sandbox executors
│   ├── types.ts      # ExecuteResult, LogEntry, ExecutorOptions
│   ├── executor.ts   # Base executor (lifecycle, console capture, limits)
│   ├── search-executor.ts  # Spec index + getObject() injection
│   └── code-executor.ts    # fortimanager.request() proxy (async)
├── server/           # MCP server and transport
│   ├── server.ts     # McpServer with search + execute tools
│   └── transport.ts  # Stdio + Streamable HTTP transports
├── spec/             # Generated API spec JSON files (git-ignored, generated locally)
│   ├── fmg-api-spec-7.4.json  # 72 modules, 17,426 objects, 38,586 URLs
│   └── fmg-api-spec-7.6.json  # 82 modules, 22,060 objects, 49,285 URLs
├── types/            # Shared type definitions
├── config.ts         # Zod-validated environment config
├── __tests__/        # Unit tests (66 tests across 5 suites)
│   └── fixtures/     # Sample spec, response builders
└── index.ts          # Entry point
scripts/
├── generate-spec.ts  # HTML docs → JSON spec generator
├── e2e-test.ts       # End-to-end scenario tests (live FMG)
├── live-test.ts      # Integration test suite (86 tests against live FMG)
└── spec-coverage.ts  # API spec coverage report & live URL validation
```

## Security

- **Sandboxed execution** — All agent-generated code runs in a QuickJS WASM sandbox with enforced memory (64 MB) and CPU (30s timeout) limits. No access to `process`, `require`, `fs`, or any Node.js APIs.
- **No eval in host** — The host Node.js process never calls `eval()` or `new Function()`. Only the WASM sandbox executes untrusted code.
- **HTTP request timeout** — 30-second timeout on all FortiManager API calls prevents indefinite hangs.
- **Response shape validation** — JSON-RPC response bodies are validated before processing, preventing crashes from malformed responses.
- **Sandbox method validation** — Only allowed FMG methods (`get`, `set`, `add`, `update`, `delete`, `exec`, `clone`, `move`, `replace`) are forwarded from sandbox code.
- **Sandbox params validation** — Parameters from sandbox code are validated as arrays with required `url` fields before forwarding.
- **Log accumulation cap** — Console output is capped at 1 MB / 1,000 entries to prevent host memory exhaustion.
- **Code input size limit** — Code inputs exceeding 100 KB are rejected before execution.
- **TLS verification** — Enabled by default (`FMG_VERIFY_SSL=true`). Disable only for development with self-signed certificates.
- **Token-based auth** — Uses FortiManager API tokens via `Authorization: Bearer` header. No passwords stored.
- **Fresh context per execution** — Each tool invocation gets a new sandbox context. No state leaks between executions.
- **API call limits** — Max 50 API calls per sandbox execution to prevent runaway loops.
- **Response truncation** — Results exceeding 100 KB are truncated with guidance on narrowing the query.
- **Startup health check** — FortiManager connectivity is validated at boot (non-fatal).
- **Graceful shutdown** — Both stdio and HTTP transports handle SIGINT/SIGTERM for clean shutdown.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Documentation

- [Usage Guide](docs/usage-guide.md) — tool examples, workflows, and best practices
- [Architecture](docs/architecture.md) — system design and component overview
- [Troubleshooting](docs/troubleshooting.md) — common issues and solutions
- [Contributing](CONTRIBUTING.md) — development setup, testing, and PR process

## Acknowledgments

This project was co-developed by [Jamie van der Pijll](https://github.com/jmpijll) and [GitHub Copilot](https://github.com/features/copilot) (Claude).

Inspired by:

- **[Cloudflare MCP Server](https://github.com/cloudflare/mcp-server-cloudflare)** — Pioneered the Code Mode pattern for MCP servers (2 tools instead of hundreds)
- **[fortimanager-mcp](https://github.com/jmpijll/fortimanager-mcp)** — Our earlier traditional MCP server for FortiManager (one tool per endpoint, now archived), which demonstrated the need for a more token-efficient approach

## License

[MIT](LICENSE) © 2026 [Jamie van der Pijll](https://github.com/jmpijll)
