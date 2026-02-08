# deploy/Dockerfile — Multi-stage build for loa-finn (SDD §7.2, T-5.1)

# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and framework lib (persistence types needed by src/)
COPY tsconfig.json ./
COPY src/ ./src/
COPY .claude/lib/ ./.claude/lib/
RUN pnpm build

# Stage 2: Runtime
FROM node:22-slim
WORKDIR /app

# Install beads_rust CLI
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -sSL https://github.com/Dicklesworthstone/beads_rust/releases/latest/download/br-linux-amd64 -o /usr/local/bin/br \
    && chmod +x /usr/local/bin/br \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy static assets and state
COPY public/ ./public/
COPY grimoires/ ./grimoires/
COPY .beads/ ./.beads/

# Create data directory
RUN mkdir -p /data/sessions /data/wal

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
