# deploy/Dockerfile.lean — lean runtime for the cost-of-play playtest
# (cycle-041 S5 / sprint-169, T5.5 — derived from deploy/Dockerfile)
#
# The lean profile is part of the EXPERIMENT: infra cost realism requires a
# right-sized image (arch doc §2 "Topology + lean profile"). Target
# ≈1.2–1.35GB vs the full image's ~1.8–2.2GB.
#
# KEEP (operator-ratified):
#   - node22-slim runtime, dist + node_modules
#   - python3 + httpx ONLY (the cheval seam — Class B routes through the real
#     HMAC subprocess so its overhead is measured, not hidden)
#   - /data setup, healthcheck, non-root user
# CUT (vs deploy/Dockerfile):
#   - fastapi / uvicorn / sse-starlette (sidecar-server deps, not cheval deps)
#   - beads CLI (~50MB) · gh CLI (~100MB)
#   - oracle corpus (50–200MB) · bridgebuilder skill · codex-data ·
#     personality config · grimoires/.beads state

# Stage 1: Build (identical to the full image — build artifacts must match)
FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable \
    && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
COPY scripts/build-hounfour-dist.sh ./scripts/
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
COPY .claude/lib/ ./.claude/lib/
# --noCheck: emit JS without type-checking (hounfour viem type drift causes
# pre-existing TS errors that don't affect runtime). Type-check runs in CI.
RUN pnpm exec tsc --noCheck

# Stage 2: Lean runtime
FROM node:22-slim
WORKDIR /app

# python3 + httpx ONLY — the cheval subprocess seam (seam 2, kept).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages httpx pyyaml \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Static assets (WebChat shell; small)
COPY public/ ./public/

# Drizzle migrations (startup runs them when Postgres is enabled; inert when
# FINN_POSTGRES_ENABLED=false as in the playtest env)
COPY drizzle/ ./drizzle/

# Identity contract — IdentityLoader hard-requires the soul file at boot
# (deploy-discovered gap in the lean cut list: grimoires/ was cut wholesale,
# but BEAUVOIR.md is boot-blocking and only a few KB)
COPY grimoires/loa/BEAUVOIR.md ./grimoires/loa/BEAUVOIR.md

# Hounfour adapters (cheval.py lives here) and schemas
COPY adapters/ ./adapters/
COPY schemas/ ./schemas/

# Data directory and non-root user
RUN mkdir -p /data/sessions /data/wal /data/cost \
    && addgroup --system finn && adduser --system --ingroup finn finn \
    && chown -R finn:finn /data /app

ARG BUILD_TIMESTAMP=unknown
LABEL build.timestamp="${BUILD_TIMESTAMP}"
LABEL cop.profile="lean"

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000
ENV HOST=0.0.0.0
ENV PYTHONPATH=/app

EXPOSE 3000

USER finn

HEALTHCHECK --interval=10s --timeout=2s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>{r.statusCode===200?process.exit(0):process.exit(1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
