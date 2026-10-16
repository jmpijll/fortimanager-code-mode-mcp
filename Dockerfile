# ─── Stage 1: Build ──────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/

# API specs are never in the image (not redistributable); mount them at
# /app/dist/spec at runtime: -v /path/to/spec:/app/dist/spec:ro (see README)

RUN npm run build

# ─── Stage 2: Production ────────────────────────────────────────────
FROM node:22-alpine AS production

LABEL org.opencontainers.image.source="https://github.com/jmpijll/fortimanager-code-mode-mcp"
LABEL org.opencontainers.image.description="FortiManager Code Mode MCP Server — 2 tools (search + execute) with QuickJS WASM sandbox"
LABEL org.opencontainers.image.licenses="MIT"

# Security: non-root user
RUN addgroup -S mcp && adduser -S mcp -G mcp

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist/ ./dist/

# API specs are never in the image (not redistributable); mount them at
# /app/dist/spec at runtime: -v /path/to/spec:/app/dist/spec:ro (see README)

# Switch to non-root user
USER mcp

# Environment defaults
ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8000
ENV FMG_PORT=443
ENV FMG_VERIFY_SSL=true
ENV FMG_API_VERSION=7.6

# Expose HTTP port (only used when MCP_TRANSPORT=http)
EXPOSE 8000

# Health check (only works with HTTP transport)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8000/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
