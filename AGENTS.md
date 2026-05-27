# AGENTS.md — FortiManager Code Mode MCP Server

> Guidelines for AI agents and human contributors working on this codebase.

---

## Project Overview

This is an MCP (Model Context Protocol) server for FortiManager that uses the **Code Mode** pattern: just 2 tools (`search` + `execute`) instead of hundreds of individual API tools. Agent-generated JavaScript runs inside a QuickJS WASM sandbox to search the API spec or execute live FortiManager JSON-RPC calls.

---

## Git Workflow

### Branching Strategy

- **`main`** — Protected. Always deployable. Requires PR with passing CI.
- **`feat/<name>`** — New features. Branch from `main`, merge via PR.
- **`fix/<name>`** — Bug fixes. Branch from `main`, merge via PR.
- **`chore/<name>`** — Maintenance (deps, CI, docs). Branch from `main`, merge via PR.

### Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]
[optional footer]
```

**Types**: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`

**Scopes**: `client`, `spec`, `executor`, `server`, `docker`, `ci`, `docs`

**Examples**:
```
feat(client): add JSON-RPC request multiplexing
fix(executor): increase QuickJS memory limit to 32MB
chore(deps): update @modelcontextprotocol/sdk to 1.2.0
docs: add architecture diagram to README
```

### PR Process

1. Create feature branch from `main`
2. Make changes, commit with conventional commits
3. Push branch, open PR against `main`
4. PR must pass: lint, typecheck, tests
5. Squash merge into `main`

---

## Versioning

- Follow [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`)
- Breaking changes increment MAJOR, features increment MINOR, fixes increment PATCH
- Release via git tags: `v1.0.0`, `v1.1.0`, etc.

---

## Code Standards

### TypeScript

- **Strict mode** enabled in `tsconfig.json`
- ESM modules (`"type": "module"` in package.json)
- Explicit return types on exported functions
- No `any` — use `unknown` and narrow with type guards
- Prefer `interface` for object shapes, `type` for unions/intersections
- Use `zod` for runtime validation of external inputs (env, API responses)

### File Organization

```
src/
├── client/         # FortiManager JSON-RPC client
│   ├── types.ts
│   ├── auth.ts
│   └── fmg-client.ts
├── spec/           # Generated API spec JSON files (git-ignored, generated locally)
│   ├── fmg-api-spec-7.4.json  # Generated from FNDN HTML docs
│   └── fmg-api-spec-7.6.json  # Generated from FNDN HTML docs
├── executor/       # QuickJS sandbox executors
│   ├── types.ts
│   ├── executor.ts
│   ├── search-executor.ts
│   └── code-executor.ts
├── server/         # MCP server and transport
│   ├── server.ts
│   └── transport.ts
├── types/          # Shared type definitions
│   ├── fmg-request-types.ts
│   └── spec-types.ts
├── __tests__/      # Test files
│   └── fixtures/
└── index.ts        # Entry point
scripts/
├── generate-spec.ts    # HTML docs → JSON spec generator
├── e2e-test.ts         # End-to-end test suite (live FMG)
├── live-test.ts        # Integration test suite (live FMG)
└── spec-coverage.ts    # API spec coverage report
```

### Naming Conventions

- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Types/interfaces: `PascalCase`

### Error Handling

- Use custom error classes extending `Error`
- Always include context in error messages (URL, method, status code)
- Log errors with structured data (JSON format)
- Never swallow errors silently

---

## Testing

- **Framework**: Vitest
- **Pattern**: `src/**/*.test.ts` co-located with source, or `src/__tests__/` for integration tests
- **Fixtures**: `src/__tests__/fixtures/` for sample data
- **Coverage target**: 80%+ for core modules (client, executor, server)
- Mock external HTTP calls — never hit real FortiManager in unit tests

---

## CI/CD

### CI Pipeline (on every PR)

1. `npm run lint` — ESLint
2. `npm run format:check` — Prettier
3. `npm run typecheck` — TypeScript
4. `npm run test` — Vitest

### Docker Build (on merge to main)

1. Multi-stage build → Node.js Alpine
2. Push to `ghcr.io/jmpijll/fortimanager-code-mode-mcp`
3. Tag with version + `latest`

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FMG_HOST` | Yes | — | FortiManager URL (e.g., `https://fmg.example.com`) |
| `FMG_PORT` | No | `443` | HTTPS port |
| `FMG_API_TOKEN` | Yes | — | API token for authentication |
| `FMG_VERIFY_SSL` | No | `true` | Verify TLS certificates |
| `FMG_API_VERSION` | No | `7.6` | API spec version (`7.4` or `7.6`) |
| `MCP_TRANSPORT` | No | `stdio` | Transport mode (`http` or `stdio`) |
| `MCP_HTTP_PORT` | No | `8000` | HTTP server port |
| `MCP_API_KEY` | No | — | If set, `/mcp` requires `Authorization: Bearer <key>` (HTTP transport only). |
| `MCP_TOKEN_PASSTHROUGH` | No | `false` | If `true`, read `X-FMG-Token` per request and forward it to FortiManager (HTTP transport only). Missing header → fall back to `FMG_API_TOKEN`. |

---

## Bug Registration

- Report bugs as GitHub Issues with the `bug` label
- Include: reproduction steps, expected vs actual behavior, FMG version, logs
- Reference the relevant code area in the issue title: `[client] Connection timeout on large responses`

---

## Memory Bank

The `.memory/` directory is **git-ignored** and stores local agent context:

- `.memory/roadmap.md` — Project roadmap and phase tracking
- `.memory/decisions.md` — Architecture decision records
- `.memory/sessions/` — Session logs (one per date, `YYYY-MM-DD.md`)

Agents should read `.memory/roadmap.md` at session start to understand current project state and priorities.

---

## Security

- **Never commit secrets** — use `.env` (git-ignored) or environment variables
- **Sandbox all agent code** — QuickJS WASM with memory/CPU limits
- **Validate all inputs** — zod schemas for env vars, API responses, tool inputs
- **No eval/Function** in host Node.js — only in QuickJS sandbox
- **TLS verification** on by default (`FMG_VERIFY_SSL=true`)
