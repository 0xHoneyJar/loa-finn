# deploy/Dockerfile — Multi-stage build for loa-finn (SDD §7.2, T-5.1)

# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source, framework lib, and upstream bridgebuilder skill
COPY tsconfig.json ./
COPY src/ ./src/
COPY .claude/lib/ ./.claude/lib/
COPY .claude/skills/bridgebuilder-review/ ./.claude/skills/bridgebuilder-review/
RUN pnpm build

# Stage 2: Runtime
FROM node:22-slim
WORKDIR /app

# Install Python 3, sidecar deps, beads_rust CLI + gh CLI (upstream GitHubCLIAdapter requires gh)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gpg python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages httpx pyyaml \
       fastapi 'uvicorn[standard]' sse-starlette \
    && curl -sSL https://github.com/Dicklesworthstone/beads_rust/releases/latest/download/br-linux-amd64 -o /usr/local/bin/br \
    && chmod +x /usr/local/bin/br \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get purge -y curl gpg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy upstream bridgebuilder skill (runtime import resolution via package.json imports)
COPY --from=builder /app/.claude/skills/bridgebuilder-review/dist/ ./.claude/skills/bridgebuilder-review/dist/
COPY --from=builder /app/.claude/skills/bridgebuilder-review/package.json ./.claude/skills/bridgebuilder-review/package.json

# Copy static assets and state
COPY public/ ./public/
COPY grimoires/ ./grimoires/
COPY .beads/ ./.beads/

# Oracle knowledge corpus from loa-dixie (CI-fetched, no network during build)
# CI pipeline fetches loa-dixie archive at pinned DIXIE_REF before docker build
COPY deploy/build-context/oracle-knowledge/ ./grimoires/oracle-dixie/
COPY deploy/build-context/oracle-persona/ ./grimoires/oracle-persona/

# Copy Drizzle migrations (Sprint 1 T1.3)
COPY drizzle/ ./drizzle/

# Copy Hounfour adapters and schemas (T-16.8)
COPY adapters/ ./adapters/
COPY schemas/ ./schemas/

# Create data directory and non-root user
RUN mkdir -p /data/sessions /data/wal \
    && addgroup --system finn && adduser --system --ingroup finn finn \
    && chown -R finn:finn /data /app

# Provenance build args
ARG DIXIE_REF=main
ARG BUILD_TIMESTAMP=unknown
LABEL dixie.ref="${DIXIE_REF}"
LABEL dixie.commit="${DIXIE_REF}"
LABEL build.timestamp="${BUILD_TIMESTAMP}"

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000
ENV HOST=0.0.0.0
ENV PYTHONPATH=/app

EXPOSE 3000

USER finn

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>{r.statusCode===200?process.exit(0):process.exit(1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
