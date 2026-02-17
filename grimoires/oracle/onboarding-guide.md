---
id: onboarding-guide
type: knowledge-source
format: markdown
tags: [technical]
priority: 16
provenance:
  source_repo: 0xHoneyJar/loa-finn
  generated_date: "2026-02-17"
  description: "Developer onboarding guide for the ecosystem"
max_age_days: 60
---

# Developer Onboarding Guide

## Quick Start

### Prerequisites

- Node.js 22+ (LTS)
- pnpm 9+
- Redis 7+ (local or Docker)
- TypeScript 5.4+

### Local Development Setup

```bash
# Clone and install
git clone https://github.com/0xHoneyJar/loa-finn.git
cd loa-finn
pnpm install

# Set environment variables
cp deploy/production.env.example .env.local
# Edit .env.local with your API keys

# Run development server
pnpm dev

# Run tests
pnpm test
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key for model access |
| `REDIS_URL` | No | — | Redis connection URL (enables rate limiting, DLQ) |
| `FINN_AUTH_TOKEN` | No | — | Bearer token for direct API access |
| `FINN_S2S_PRIVATE_KEY` | No | — | ES256 private key (PEM) for S2S JWT signing |
| `FINN_ORACLE_ENABLED` | No | `false` | Enable Oracle knowledge subsystem |
| `PORT` | No | `3000` | HTTP server port |

### Key API Endpoints

```bash
# Health check
curl http://localhost:3000/health

# Model invocation (requires auth)
curl -X POST http://localhost:3000/api/v1/invoke \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent": "default", "prompt": "Hello"}'

# Oracle query (public)
curl -X POST http://localhost:3000/api/v1/oracle \
  -H "Content-Type: application/json" \
  -d '{"question": "What is Hounfour?"}'
```

## Repository Structure

```
loa-finn/
├── src/
│   ├── gateway/       # HTTP server, routes, middleware
│   ├── hounfour/      # Model router, adapters, knowledge engine
│   ├── scheduler/     # Health checks, background tasks
│   ├── tracing/       # OpenTelemetry instrumentation
│   └── config.ts      # Configuration loader
├── tests/
│   └── finn/          # Test files (vitest)
├── deploy/
│   ├── Dockerfile     # Multi-stage production build
│   └── terraform/     # Infrastructure as code
├── grimoires/
│   └── oracle/        # Knowledge sources for Oracle
└── adapters/          # Hounfour adapter configs
```

## Testing

```bash
# Run all tests
pnpm test

# Run specific test file
npx vitest run tests/finn/oracle-api.test.ts

# Run tests matching pattern
npx vitest run --grep "rate limit"

# Watch mode
npx vitest --watch
```

## Common Tasks

### Adding a New Knowledge Source

1. Create Markdown file in `grimoires/oracle/`
2. Add YAML frontmatter with id, tags, priority
3. Register in `grimoires/oracle/sources.json`
4. Run gold-set tests to verify source selection

### Adding a New API Endpoint

1. Create route handler in `src/gateway/routes/`
2. Register in `src/gateway/server.ts`
3. Add tests in `tests/finn/`
4. Update health endpoint if needed
