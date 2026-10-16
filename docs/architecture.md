# Architecture Deep-Dive

## Overview

The FortiManager Code Mode MCP Server follows the **Code Mode** pattern: instead of exposing hundreds of individual API tools (one per endpoint), it provides just **2 tools** — `search` and `execute` — that accept JavaScript code as input and run it in a secure sandbox.

This approach reduces tool context from ~118K tokens (590+ tools) to ~1K tokens (2 tools), giving the AI agent more room for reasoning and conversation.

```
┌─────────────────────────────────────────────────────────┐
│                     MCP Client                          │
│              (VS Code Copilot, Claude, etc.)            │
└────────────────────────┬────────────────────────────────┘
                         │ MCP Protocol (stdio or HTTP)
┌────────────────────────▼────────────────────────────────┐
│                   MCP Server                            │
│                                                         │
│  ┌─────────────┐         ┌──────────────┐              │
│  │  search      │         │  execute     │              │
│  │  tool        │         │  tool        │              │
│  └──────┬──────┘         └──────┬───────┘              │
│         │                       │                       │
│  ┌──────▼──────┐         ┌──────▼───────┐              │
│  │  Search     │         │  Code        │              │
│  │  Executor   │         │  Executor    │              │
│  │  (QuickJS   │         │  (QuickJS    │              │
│  │   sync)     │         │   async)     │              │
│  └──────┬──────┘         └──────┬───────┘              │
│         │                       │                       │
│  ┌──────▼──────┐         ┌──────▼───────┐              │
│  │  API Spec   │         │  FMG Client  │              │
│  │  JSON       │         │  (JSON-RPC)  │              │
│  │  (in-memory)│         │              │              │
│  └─────────────┘         └──────┬───────┘              │
│                                 │                       │
└─────────────────────────────────┼───────────────────────┘
                                  │ HTTPS (JSON-RPC)
                    ┌─────────────▼──────────────┐
                    │     FortiManager           │
                    │     (JSON-RPC API)         │
                    └────────────────────────────┘
```

---

## Component Details

### 1. HTTP Edge and Transports (`src/server/http.ts`, `src/index.ts`)

Supports two transport modes:

- **Stdio**: `serveStdio()` from the MCP SDK reads JSON-RPC from stdin and writes to stdout. Used for local development and VS Code Copilot integration. Stdout is reserved for MCP protocol; all logs go to stderr.

- **Streamable HTTP**: `createHttpApp()` builds the web-standard edge and `listenHttp()` binds it to `node:http` with two endpoints:
  - `/mcp` — MCP protocol (POST/GET/DELETE for Streamable HTTP spec)
  - `/health` — Health check with uptime and request stats

Both transports serve protocol revision **2026-07-28** and still answer 2025-era clients with the plain `initialize` handshake. Nothing selects an era: the server reads it from the client's first request. On the modern era, `tools/list` and `server/discover` results carry 5-minute public cache hints.

HTTP transport includes:
- Header-first gates: `/health`, the 429 and the 401 are decided from the method, path and headers alone (`HttpApp.admit`) before any request body is read, so an unauthenticated or rate-limited caller is answered without uploading its body; an admitted `/mcp` call then goes through `HttpApp.serve` to the SDK adapter, which reads the body itself under its 4 MiB cap
- Rate limiting (60 req/min per client IP, sliding window)
- Request logging with client IP tracking
- Optional static Bearer auth (`MCP_API_KEY`) and per-request `X-FMG-Token` passthrough
- X-Forwarded-For support for reverse proxies
- Graceful shutdown on SIGINT/SIGTERM

### 2. MCP Server (`src/server/server.ts`)

Registers two tools with the MCP SDK:

**`search` tool**: Accepts JavaScript code, runs it in the `SearchExecutor` sandbox with read-only access to the API spec. Returns the final expression's value.

**`execute` tool**: Accepts JavaScript code, runs it in the `CodeExecutor` sandbox with access to `fortimanager.request()` for live API calls. Returns the final expression's value plus captured console output.

Both tools enforce a 100 KB code input limit and include audit logging (code size, result status, execution duration). Server construction takes a `CallerScope`, which carries the per-request `X-FMG-Token` on HTTP and is empty on stdio.

### 3. Search Executor (`src/executor/search-executor.ts`)

Uses a **synchronous** QuickJS context (no async needed — everything is in-memory).

**Injected globals**:
- `specIndex` — Lightweight array of all API objects. Each entry has `name`, `type`, `module`, `description`, `urls`, `methods`, `attributeNames`. Pre-computed as JSON string for fast injection.
- `getObject(nameOrUrl)` — Host function that looks up full object details by name or URL path. Returns the complete object with all attributes, or null.
- `moduleList` — Array of all modules with name, title, object/method counts.
- `errorCodes` — Array of all error codes with code and message.
- `specVersion` — Version string (e.g., "7.6").
- `console.log/warn/error` — Captured to a log buffer.

**Performance optimizations**:
- Pre-computed JSON strings for `specIndex`, `moduleList`, `errorCodes` (avoids re-serialization per call)
- Pre-built object lookup tables (by name and URL)
- Pre-warmed QuickJS WASM module at startup

### 4. Code Executor (`src/executor/code-executor.ts`)

Uses an **async** QuickJS context (`newAsyncContext()`) to support asynchronous host function calls.

**Injected globals**:
- `fortimanager.request(method, params)` — Asyncified host function that sends JSON-RPC calls to FortiManager via the `FmgClient`. Despite being async on the host side, it appears **synchronous** in the sandbox (QuickJS WASM execution suspends and resumes transparently).
- `console.log/warn/error` — Captured to a log buffer.

**Security measures**:
- Method allowlist: only `get`, `set`, `add`, `update`, `delete`, `exec`, `clone`, `move`, `replace`
- Params validation: must be array with `url` field
- API call limit: 50 calls per execution
- Log accumulation cap: 1 MB / 1,000 entries
- New context per execution (complete isolation)

### 5. Base Executor (`src/executor/executor.ts`)

Abstract base class for both executors. Provides:
- QuickJS WASM module lifecycle (create context, dispose)
- Console capture (`console.log/warn/error` → log buffer)
- Memory limits (via QuickJS runtime configuration)
- CPU limits (interrupt handler with call counter)
- Log accumulation cap (1 MB / 1,000 entries)
- Result serialization (QuickJS handle → JavaScript value)

### 6. FortiManager Client (`src/client/fmg-client.ts`)

Stateless HTTP client for FortiManager's JSON-RPC API:
- Token-based authentication (Bearer header)
- SSL bypass for self-signed certificates (via undici Agent with `rejectUnauthorized: false`)
- HTTP request timeout (30 seconds via `AbortSignal.timeout()`)
- JSON-RPC response shape validation
- Request ID auto-increment with wrapping (mod 1,000,000,000)
- Methods: `get`, `set`, `add`, `update`, `delete`, `exec`, `clone`, `move`, `replace`
- Batch requests (multiple param objects in single JSON-RPC call)
- Health check method (`checkHealth()` → hostname, version, serial)

### 7. API Spec (`src/spec/`)

Pre-generated JSON files containing the complete FortiManager API specification:
- `fmg-api-spec-7.4.json` — 72 modules, 17,426 objects, 98 MB
- `fmg-api-spec-7.6.json` — 82 modules, 22,060 objects, 127 MB

Generated offline by `scripts/generate-spec.ts` from FortiManager HTML documentation (cheerio parsing). Generated locally and git-ignored — not included in the repository (see [README](../README.md#important-api-spec-required) for setup).

Spec structure:
```
{
  version: "7.6",
  build: "3645",
  modules: [
    {
      name: "dvmdb",
      title: "Device Manager Database",
      methods: [...],
      objects: [
        {
          name: "device",
          type: "table",
          urls: [{ path: "/dvmdb/device", ... }],
          methods: ["get-table", "add", ...],
          attributes: [{ name: "ip", type: "string", ... }, ...]
        }
      ]
    }
  ],
  errors: [{ code: 0, message: "OK" }, ...]
}
```

---

## Security Model

### Sandbox Isolation

All agent-generated code runs inside a QuickJS WASM sandbox:

1. **No host access**: Sandbox code cannot access Node.js APIs, file system, network, or environment variables
2. **Controlled globals**: Only explicitly injected functions are available
3. **Method allowlist**: `fortimanager.request()` only forwards whitelisted methods
4. **Params validation**: Request parameters are validated before forwarding
5. **New context per call**: Each execution creates a fresh QuickJS context, preventing state leakage

### Resource Limits

- Code input: 100 KB max
- API calls: 50 per execution
- Console logs: 1,000 entries / 1 MB per execution
- HTTP timeout: 30 seconds per FortiManager request
- HTTP rate limit: 60 requests per minute per client IP (HTTP transport)
- Response truncation: 100 KB max result size

### Network Security

- TLS verification enabled by default (`FMG_VERIFY_SSL=true`)
- SSL bypass explicitly opt-in (`FMG_VERIFY_SSL=false`)
- Cached undici Agent for SSL connections (reuse, not re-created per request)
- No outbound network access from sandbox (only via `fortimanager.request()` proxy)

---

## Data Flow

### Search Request

```
Agent → "search" tool → SearchExecutor
    1. Validate code size (≤ 100 KB)
    2. Create QuickJS sync context
    3. Inject specIndex, getObject, moduleList, errorCodes, specVersion, console
    4. Evaluate code in sandbox
    5. Serialize result (QuickJS handle → JS value)
    6. Dispose QuickJS context
    7. Return { ok, data, logs, durationMs }
```

### Execute Request

```
Agent → "execute" tool → CodeExecutor
    1. Validate code size (≤ 100 KB)
    2. Create QuickJS async context
    3. Inject console, fortimanager.request() proxy
    4. Evaluate code in sandbox (async)
       ├─ On fortimanager.request() call:
       │   a. Validate method (allowlist)
       │   b. Validate params (array, url field)
       │   c. Check call counter (≤ 50)
       │   d. Send JSON-RPC to FMG via FmgClient
       │   e. Return response to sandbox
       └─ On console.log/warn/error:
           a. Check log limits (1,000 entries / 1 MB)
           b. Capture to log buffer
    5. Serialize result
    6. Dispose QuickJS context
    7. Return { ok, data, logs, durationMs }
```

---

## Configuration

All configuration is validated at startup using Zod schemas:

| Variable         | Required | Default | Description                        |
| ---------------- | -------- | ------- | ---------------------------------- |
| `FMG_HOST`       | Yes      | —       | FortiManager URL (with `https://`) |
| `FMG_PORT`       | No       | `443`   | HTTPS port                         |
| `FMG_API_TOKEN`  | Yes      | —       | API token for authentication       |
| `FMG_VERIFY_SSL` | No       | `true`  | Verify TLS certificates            |
| `FMG_API_VERSION` | No      | `7.6`   | API spec version (`7.4` or `7.6`)  |
| `MCP_TRANSPORT`  | No       | `stdio` | Transport mode (`http` or `stdio`) |
| `MCP_HTTP_PORT`  | No       | `8000`  | HTTP server port                   |

---

## Performance Characteristics

Measured against FortiManager v7.6.6:

| Operation                   | Typical Latency |
| --------------------------- | --------------- |
| Search tool (simple query)  | 5–15 ms         |
| Search tool (complex filter)| 20–50 ms        |
| Execute tool (single API call) | 200–500 ms  |
| Execute tool (batch queries) | 300–900 ms     |
| Spec load at startup        | 300–700 ms      |
| QuickJS WASM init           | 5–15 ms         |
| FMG health check            | 100–300 ms      |
