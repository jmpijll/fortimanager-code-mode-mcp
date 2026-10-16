#!/usr/bin/env bash
#
# Smoke test for the FortiManager Code Mode MCP Docker image.
#
# Starts the image with a minimal API spec mounted at /app/dist/spec, waits for
# GET /health to return 200, then sends an MCP `initialize` request to POST /mcp
# and checks that the response contains serverInfo. The container is always
# removed, also on failure (its logs are printed first).
#
# The image ships without API specs (they are not redistributable), so the
# fixture below is written by this script and mounted read-only. It satisfies
# the startup validation in src/index.ts (non-empty `version` string and
# non-empty `modules` array) and nothing else.
#
# Usage:
#   scripts/docker-smoke.sh [image-tag]
#
#   image-tag   Image to run (default: fmg-mcp:smoke)
#
# Environment overrides:
#   SMOKE_PORT         Host port to publish container port 8000 on (default: 8000)
#   SMOKE_API_VERSION  Spec version / FMG_API_VERSION to use (default: 7.6)

set -euo pipefail

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

cat > "$SPEC_FILE" <<'JSON'
{
  "version": "0.0.0-smoke",
  "build": "0",
  "generatedAt": "1970-01-01T00:00:00.000Z",
  "modules": [
    {
      "name": "sys",
      "title": "System",
      "methods": [],
      "objects": []
    }
  ],
  "errors": []
}
JSON

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

echo "PASS: ${IMAGE}"
