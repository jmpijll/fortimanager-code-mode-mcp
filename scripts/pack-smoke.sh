#!/usr/bin/env bash
#
# Usage: scripts/pack-smoke.sh
#
# Packs the current checkout with `npm pack`, installs the tarball into a fresh
# temp project, copies the shared minimal spec fixture into the installed
# package's dist/spec/ (specs never ship in the tarball), and drives the stdio
# transport through an MCP `initialize` + `tools/list` exchange with both the
# documented `npx fortimanager-code-mode-mcp` entry point and the installed
# `fortimanager-mcp` bin. A final isolated check runs
# `npx --yes --package=<tarball> fortimanager-mcp` from an empty directory with
# a throwaway npm cache and expects the `API SPEC NOT FOUND` failure, proving
# the published bin resolves from the tarball alone. Exits nonzero on any
# failure.
#
# Environment overrides:
#   SMOKE_API_VERSION  Spec version / FMG_API_VERSION to use (default: 7.6)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
FIXTURE="${SCRIPT_DIR}/fixtures/minimal-spec.json"
API_VERSION="${SMOKE_API_VERSION:-7.6}"
export SMOKE_API_VERSION="$API_VERSION"

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

[ -f "$FIXTURE" ] || fail "spec fixture not found at ${FIXTURE}"

echo "Building ${REPO_ROOT}..."
if ! (cd "$REPO_ROOT" && npm run build) >"$WORK_DIR/build.log" 2>&1; then
  cat "$WORK_DIR/build.log" >&2
  fail "npm run build failed"
fi

echo "Packing the checkout..."
TARBALL_NAME="$(cd "$REPO_ROOT" && npm pack --pack-destination "$WORK_DIR" --silent | tail -n 1)" \
  || fail "npm pack failed"
TARBALL="$WORK_DIR/$TARBALL_NAME"

echo "Installing ${TARBALL_NAME} into a fresh project..."
PROJECT="$WORK_DIR/project"
mkdir -p "$PROJECT"
cd "$PROJECT"
npm init -y >/dev/null
if ! npm install "$TARBALL" --no-audit --no-fund >"$WORK_DIR/install.log" 2>&1; then
  cat "$WORK_DIR/install.log" >&2
  fail "npm install of the tarball failed"
fi

PKG_DIR="$PROJECT/node_modules/fortimanager-code-mode-mcp"
mkdir -p "$PKG_DIR/dist/spec"
cp "$FIXTURE" "$PKG_DIR/dist/spec/fmg-api-spec-${API_VERSION}.json"

PACKAGE_VERSION="$(node -p "require('${PKG_DIR}/package.json').version")"

cat > "$WORK_DIR/mcp-stdio-check.mjs" <<'MCP_CHECK'
// One stdio exchange: initialize, then tools/list. Exits nonzero unless the
// initialize response reports the expected version and tools/list returns
// both `search` and `execute`.
import { spawn } from 'node:child_process';

const [expectedVersion, ...command] = process.argv.slice(2);

const child = spawn(command[0], command.slice(1), {
  env: {
    ...process.env,
    FMG_HOST: 'https://127.0.0.1',
    FMG_API_TOKEN: 'dummy',
    FMG_API_VERSION: process.env.SMOKE_API_VERSION ?? '7.6',
    MCP_TRANSPORT: 'stdio',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const messages = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pack-smoke', version: '0.0.0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];
for (const message of messages) {
  child.stdin.write(JSON.stringify(message) + '\n');
}

let buffer = '';
let initialize;
let tools;
let done = false;

const timer = setTimeout(() => finish(new Error('timed out waiting for tools/list')), 120000);

function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  child.kill('SIGKILL');
  if (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const names = tools.map((tool) => tool.name).sort();
  if (!names.includes('search') || !names.includes('execute')) {
    console.error(`FAIL: tools/list returned [${names.join(', ')}], expected search + execute`);
    process.exitCode = 1;
    return;
  }
  if (initialize.version !== expectedVersion) {
    console.error(
      `FAIL: initialize reports version ${initialize.version}, expected ${expectedVersion}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`initialize OK (fortimanager-code-mode ${initialize.version}), tools: ${names.join(', ')}`);
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === 1) initialize = message.result?.serverInfo;
    if (message.id === 2) tools = message.result?.tools;
    if (initialize && tools) finish();
  }
});

child.on('exit', (code, signal) => {
  if (!done) finish(new Error(`server exited early (code ${code ?? signal})`));
});
MCP_CHECK

check_entry_point() {
  local label="$1"
  shift
  echo "Checking ${label}..."
  (cd "$PROJECT" && node "$WORK_DIR/mcp-stdio-check.mjs" "$PACKAGE_VERSION" "$@") \
    || fail "${label} did not complete the MCP handshake"
}

check_entry_point "npx fortimanager-code-mode-mcp" npx fortimanager-code-mode-mcp
check_entry_point "installed fortimanager-mcp bin" ./node_modules/.bin/fortimanager-mcp

# Isolated `npx --package` resolution: the package must contain everything the
# bin needs, from an empty directory and a throwaway cache. Without a spec the
# server is expected to fail with `API SPEC NOT FOUND`; that output is only
# reachable when npx resolved the bin from the tarball alone.
cat > "$WORK_DIR/npx-resolution-check.mjs" <<'NPX_CHECK'
import { spawn } from 'node:child_process';

const [timeoutMsRaw, tarball] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsRaw);

const child = spawn('npx', ['--yes', `--package=${tarball}`, 'fortimanager-mcp'], {
  env: {
    ...process.env,
    FMG_HOST: 'https://127.0.0.1',
    FMG_API_TOKEN: 'dummy',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => (output += chunk.toString()));
child.stderr.on('data', (chunk) => (output += chunk.toString()));

const timer = setTimeout(() => {
  child.kill('SIGKILL');
  console.error(`FAIL: npx --package=<tarball> fortimanager-mcp did not finish within ${timeoutMs / 1000}s`);
  console.error(output);
  process.exit(1);
}, timeoutMs);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (code === 0) {
    console.error('FAIL: npx --package=<tarball> fortimanager-mcp exited 0; expected the missing-spec failure');
    console.error(output);
    process.exit(1);
  }
  if (!output.includes('API SPEC NOT FOUND')) {
    console.error(`FAIL: expected "API SPEC NOT FOUND" in the output (exit ${code ?? signal})`);
    console.error(output);
    process.exit(1);
  }
  console.log(`isolated npx --package resolution OK (exit ${code ?? signal}, "API SPEC NOT FOUND" as expected)`);
});
NPX_CHECK

echo "Checking isolated npx --package resolution..."
ISOLATED_DIR="$WORK_DIR/isolated"
mkdir -p "$ISOLATED_DIR" "$WORK_DIR/npm-cache"
(cd "$ISOLATED_DIR" && npm_config_cache="$WORK_DIR/npm-cache" node "$WORK_DIR/npx-resolution-check.mjs" 120000 "$TARBALL") \
  || fail "isolated npx --package resolution check failed"

echo "PASS: packed tarball serves search + execute over stdio (v${PACKAGE_VERSION}) and the bin resolves from the tarball alone"
