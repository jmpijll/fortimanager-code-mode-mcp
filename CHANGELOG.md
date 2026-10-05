# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Enforce consistent formatting and contributor/Dependabot conventions; include linked documentation and artwork in package contents.

- Derive Node MCP version metadata from package.json across the family; use package metadata in Worker scaffolds to prevent release drift.
- Align README presentation with Vapour and Slightshot, retaining detailed setup and historical verification in the usage guide.
- Align Node 22.19+ requirements, contributor checks, install policy, LF text handling, CI and Docker build exclusions across the code-mode server family.


## [1.1.0] — 2026-05-27

### Added

- **Optional Bearer auth on the HTTP `/mcp` endpoint** — set `MCP_API_KEY=<key>` and every request must include `Authorization: Bearer <key>` (timing-safe compare). Missing/wrong tokens get `401` with a `WWW-Authenticate: Bearer realm="mcp"` header. `/health` stays open for health-checkers. Unset = open endpoint (preserves current behavior). HTTP transport only — stdio is single-process and unaffected. ([#11](https://github.com/jmpijll/fortimanager-code-mode-mcp/issues/11)) — thanks [@kb1isz](https://github.com/kb1isz) for the request.
- **Per-client FortiManager token passthrough** — set `MCP_TOKEN_PASSTHROUGH=true` and each MCP client can supply its own FortiManager admin token via the `X-FMG-Token` header. That token is used (instead of `FMG_API_TOKEN`) for live API calls made by the `execute` tool *for that request only*, so FortiManager's own admin-profile RBAC enforces per-user permissions. Requests without the header fall back to `FMG_API_TOKEN`, so existing single-tenant deployments keep working unchanged. HTTP transport only. ([#11](https://github.com/jmpijll/fortimanager-code-mode-mcp/issues/11))
- **`FmgClient.rawRequest(method, params, opts?: { tokenOverride })`** — new optional per-call token override threaded through `CodeExecutor.execute(code, opts?: { fmgToken })`. The shared `FmgClient` (and its undici dispatcher) is reused across requests; only the `Authorization` header is swapped per call.
- **18 new tests** across config / client / code-executor / HTTP transport covering the auth gate, passthrough, fallback, and combined modes (total 90).

### Changed

- HTTP transport's `serverFactory` now receives an `McpRequestContext` (currently exposing `fmgToken`) instead of being called with no arguments. The stdio path is unchanged.
- `startHttpTransport` now removes its installed `SIGINT` / `SIGTERM` listeners when `close()` is called, so repeated test runs no longer leak signal handlers on the host process.

## [1.0.2] — 2026-05-27

### Fixed

- **HTTP transport accepts multiple clients / reconnects** — `startHttpTransport` now builds a fresh `McpServer` and stateless `StreamableHTTPServerTransport` per `/mcp` request. Previously a single module-scope server was reused for every request, so any client after the first was rejected with `-32600 "Invalid Request: Server already initialized"`, breaking reconnects and multi-client deployments. Verified end-to-end against a live FortiManager 7.6.6 with multiple sequential `opencode` (deepseek) sessions. ([#13](https://github.com/jmpijll/fortimanager-code-mode-mcp/issues/13), [#14](https://github.com/jmpijll/fortimanager-code-mode-mcp/pull/14)) — thanks [@AndreADV77](https://github.com/AndreADV77) for the report and fix proposal.

## [1.0.1] — 2026-03-21

### Fixed

- **Spec generator auto-detection** — `generate-spec.ts` now auto-detects the latest FortiManager patch version in `docs/api-reference/` instead of requiring a hardcoded directory name. Supports any 7.4.x or 7.6.x release. ([#12](https://github.com/jmpijll/fortimanager-code-mode-mcp/pull/12)) — thanks [@kb1isz](https://github.com/kb1isz)

## [1.0.0] — 2026-03-02

### Added

- **Binary entry point** — `fortimanager-mcp` CLI command via `bin` field in package.json (source installs only)

### Changed

- **Stable release** — promoted from Beta to v1.0.0 public release
- **API spec files removed from repository** — spec files are now generated locally from Fortinet's HTML docs (not redistributable). Users must download the FortiManager JSON API Reference from [FNDN](https://fndn.fortinet.net) and run `npm run generate:spec` before first use.
- **Git LFS removed** — no longer needed since spec files are git-ignored
- **Clear startup error** — server now shows detailed instructions when spec files are missing
- Documentation updated with spec generation prerequisites across README, usage-guide, and CONTRIBUTING
- Dockerfile updated to require locally-generated spec files before building
- CI workflows no longer require Git LFS checkout
- Repository visibility changed to public

## [0.2.0] — 2026-03-02

### Added

- **VS Code Copilot integration** — `.vscode/mcp.json.example` template and setup docs
- **HTTP transport rate limiting** — sliding-window limiter (60 req/min per client IP) with X-Forwarded-For support
- **Request logging and audit trail** — tool call logging with code size, duration, and result status
- **Enhanced `/health` endpoint** — now returns uptime and request stats (total, MCP, rate-limited, errors)
- **10 end-to-end scenario tests** (`scripts/e2e-test.ts`) covering real agent workflows against live FortiManager
- **Architecture deep-dive** (`docs/architecture.md`) — component details, data flow, security model
- **Usage guide** (`docs/usage-guide.md`) — search/execute workflows, error handling, best practices
- **Troubleshooting guide** (`docs/troubleshooting.md`) — common issues, error codes, permission matrix

### Fixed

- **Build script** now copies spec JSON files to `dist/spec/` (was failing with ENOENT)
- **Sandbox `await` issue** — removed `await` from execute tool examples; `fortimanager.request()` is synchronous in QuickJS sandbox
- **Tool descriptions** refined with accurate method names (`get-obj`/`get-table`), module filtering examples, and `function()` syntax

### Changed

- Tool description for `search` — documents `module` field, method names, and module filtering
- Tool description for `execute` — documents `status.code` semantics and error handling patterns
- README status upgraded from Alpha to Beta
- Expanded Security documentation with 15 hardening measures

## [0.1.0] — 2026-03-02

### Added

- **MCP Server** with 2 tools (`search` + `execute`) using the Code Mode pattern
- **FortiManager JSON-RPC client** with token-based authentication and SSL bypass support
- **QuickJS WASM sandbox** for secure agent code execution (memory/CPU limited)
- **API spec generator** parsing FortiManager HTML docs into structured JSON
- **Dual API version support** — FortiManager 7.4.9 (72 modules, 17,426 objects) and 7.6.5 (82 modules, 22,060 objects)
- **Dual transport** — Stdio (local dev / Claude Desktop) and Streamable HTTP (Docker / production)
- **Docker** multi-stage Alpine build with health checks and non-root user
- **Docker Compose** configuration with env_file support
- **CI/CD pipelines** — GitHub Actions for lint, typecheck, test, build, Docker push, and releases
- **66 unit tests** across 5 suites (client, search executor, code executor, server, config)
- **86 integration tests** across 8 groups: spec globals, edge cases, cross-reference validation, system ops, CRUD lifecycle, error handling, advanced operations, and stability stress tests
- **API coverage report** (`scripts/spec-coverage.ts`) — offline spec analysis, cross-version comparison (v7.4 vs v7.6), and live URL validation with stratified sampling (96% validation rate on 100-URL sample)
- **Performance tuning** — pre-computed JSON caches, WASM pre-warming, API call limits (50/execution), response truncation (100 KB)
- Community files: CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, issue/PR templates
- Git LFS tracking for large API spec JSON files

### Security

- **Sandboxed execution** — all agent code runs in QuickJS WASM with memory/CPU limits, no `eval` in host
- **HTTP request timeout** (30s) prevents indefinite hang on slow/unreachable FortiManager
- **JSON-RPC response shape validation** prevents crashes from non-JSON-RPC responses
- **Sandbox method validation** ensures only allowed FMG methods (`get`, `set`, `add`, etc.) are forwarded
- **Sandbox params validation** verifies params is an array with required `url` field before forwarding
- **Log accumulation cap** (1 MB / 1,000 entries) prevents host OOM from runaway console.log
- **Code input size limit** (100 KB) prevents oversized code payloads
- **SSL fallback hardened** — throws error instead of silently downgrading when undici unavailable
- **Input validation** with Zod for all environment variables
- **Graceful shutdown** for both stdio and HTTP transports with signal deduplication
- **Startup health check** validates FortiManager connectivity at boot

[Unreleased]: https://github.com/jmpijll/fortimanager-code-mode-mcp/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/jmpijll/fortimanager-code-mode-mcp/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/jmpijll/fortimanager-code-mode-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jmpijll/fortimanager-code-mode-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jmpijll/fortimanager-code-mode-mcp/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/jmpijll/fortimanager-code-mode-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jmpijll/fortimanager-code-mode-mcp/releases/tag/v0.1.0
