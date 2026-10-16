#!/usr/bin/env bash
#
# Usage: scripts/docker-smoke.sh [image-tag]
#
#   image-tag   Image to run (default: fmg-mcp:smoke)
#
# Environment overrides:
#   SMOKE_PORT         Host port to publish container port 8000 on (default: 8000)
#   SMOKE_API_VERSION  Spec version / FMG_API_VERSION to use (default: 7.6)
#
# The minimal spec fixture (scripts/fixtures/minimal-spec.json) is copied into
# a temp dir because the image ships without specs (they are not
# redistributable) and is mounted read-only at /app/dist/spec.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="${SCRIPT_DIR}/fixtures/minimal-spec.json"

IMAGE="${1:-fmg-mcp:smoke}"
CONTAINER="fmg-mcp-smoke-$$"
HOST_PORT="${SMOKE_PORT:-8000}"
API_VERSION="${SMOKE_API_VERSION:-7.6}"
SPEC_DIR="$(mktemp -d)"
SPEC_FILE="${SPEC_DIR}/fmg-api-spec-${API_VERSION}.json"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$SPEC_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  echo "--- docker logs (${CONTAINER}) ---" >&2
  docker logs "$CONTAINER" >&2 2>&1 || true
  exit 1
}

cp "$FIXTURE" "$SPEC_FILE"

# `mktemp -d` creates a 0700 dir; on Linux bind mounts keep those modes, and the
# container runs as the non-root `mcp` user, which then cannot read the fixture.
chmod 755 "$SPEC_DIR"
chmod 644 "$SPEC_FILE"

echo "Starting ${IMAGE} as ${CONTAINER} (spec ${SPEC_FILE}, host port ${HOST_PORT})..."
docker run -d --name "$CONTAINER" \
  -e FMG_HOST=https://127.0.0.1 \
  -e FMG_API_TOKEN=dummy \
  -e FMG_API_VERSION="$API_VERSION" \
  -v "$SPEC_DIR":/app/dist/spec:ro \
  -p "$HOST_PORT":8000 \
  "$IMAGE" >/dev/null

health_url="http://127.0.0.1:${HOST_PORT}/health"
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS "$health_url" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
  if [ "$running" != "true" ]; then
    fail "container exited before /health responded"
  fi
  sleep 1
done
if [ "$healthy" != "1" ]; then
  fail "GET /health did not return 200 within 60s"
fi
echo "GET /health OK"

response="$(curl -fsS -X POST "http://127.0.0.1:${HOST_PORT}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"docker-smoke","version":"0.0.0"}}}')" \
  || fail "POST /mcp initialize request failed"

if ! printf '%s' "$response" | grep -q '"serverInfo"'; then
  echo "Response body: $response" >&2
  fail "initialize response did not contain serverInfo"
fi
echo "POST /mcp initialize OK (serverInfo present)"

# Modern-era check: a 2026-07-28 `server/discover` request must be answered
# with the advertised supported versions while the server keeps serving the
# 2025-era handshake above.
discover="$(curl -fsS -X POST "http://127.0.0.1:${HOST_PORT}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Method: server/discover' \
  -H 'Mcp-Protocol-Version: 2026-07-28' \
  -d '{"jsonrpc":"2.0","id":"docker-smoke-discover","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"docker-smoke","version":"0.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}')" \
  || fail "POST /mcp server/discover request failed"

if ! printf '%s' "$discover" | grep -q '"supportedVersions":\["2026-07-28"\]'; then
  echo "Response body: $discover" >&2
  fail "server/discover response did not advertise the 2026-07-28 revision"
fi
echo "POST /mcp server/discover OK (2026-07-28 revision advertised)"

echo "PASS: ${IMAGE}"
