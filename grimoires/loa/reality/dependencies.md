# External Dependencies

> Source: `package.json`, `src/persistence/r2-storage.ts`, `src/hounfour/router.ts`, `src/index.ts`

## LLM Providers (via Hounfour)

| Provider | SDK | Config | Purpose |
|----------|-----|--------|---------|
| Claude (Anthropic) | `@mariozechner/pi-ai` ~0.52.6 | `ANTHROPIC_API_KEY` | Primary native runtime |
| OpenAI-Compatible | Cheval sidecar | `CHEVAL_MODE`, `FINN_POOLS_CONFIG` | Remote model pools (Phase 5) |

## Cloud Storage

| Service | SDK | Config | Implementation |
|---------|-----|--------|----------------|
| Cloudflare R2 | `@aws-sdk/client-s3` ^3.984.0 | `R2_*` env vars | `src/persistence/r2-storage.ts` → `ICheckpointStorage` |
| Local Filesystem | Node.js `fs/promises` | `DATA_DIR` | Fallback: WAL segments, session cache |
| Git | Node.js `child_process` | `GIT_*` env vars | Archive snapshots to `GIT_ARCHIVE_BRANCH` |

### R2 Operations

Via `@aws-sdk/client-s3`: `GetObjectCommand`, `PutObjectCommand`, `DeleteObjectCommand`, `ListObjectsV2Command`, `HeadObjectCommand`

Custom interface: `get(path)`, `put(path, buffer)`, `delete(path)`, `listFiles(prefix)`, `verifyChecksum(path, expected)`, `stat(path)`

## In-Process State

| Service | SDK | Config | Purpose |
|---------|-----|--------|---------|
| Redis | `ioredis` (injected) | `REDIS_URL` | Optional state backend: circuit breaker recovery, budget snapshots, rate limiter, idempotency dedup |

### Redis Commands

- KV: `GET`, `SET` (with EX), `DEL`, `INCRBY`, `INCRBYFLOAT`, `EXPIRE`
- Hash: `HGETALL`, `HINCRBY` (budget tracking)
- Sorted set: `ZADD`, `ZPOPMIN`, `ZREMRANGEBYSCORE`, `ZCARD` (rate limiter)
- Scripting: `EVAL` (Lua for atomic operations)
- Pub/Sub: `PUBLISH`, `SUBSCRIBE`
- **Failure mode**: Fail-open for circuit/rate components, fail-closed for budget

## External APIs

| Service | SDK | Config | Purpose |
|---------|-----|--------|---------|
| GitHub | Fetch + GraphQL | `GITHUB_TOKEN`, `BRIDGEBUILDER_REPOS` | Activity feed for dashboard |

HTTP Client: `src/shared/http-client.ts` → `ResilientHttpClient` (exponential backoff, rate limit tracking, redaction)

## NPM Dependencies

### Production

| Package | Version | Purpose |
|---------|---------|---------|
| `hono` | ^4.0.0 | HTTP framework |
| `@hono/node-server` | ^1.19.9 | Node.js HTTP adapter |
| `ws` | ^8.19.0 | WebSocket implementation |
| `@mariozechner/pi-ai` | ~0.52.6 | Claude API + Pi SDK |
| `@mariozechner/pi-coding-agent` | ~0.52.6 | Agent frame, tools, streaming |
| `@mariozechner/pi-agent-core` | ~0.52.6 | Base agent protocol |
| `@aws-sdk/client-s3` | ^3.984.0 | R2 (S3-compatible) storage |
| `jose` | ^6.1.3 | JWT/JWS (ES256 signing, JWKS) |
| `croner` | ^10.0.1 | Cron expression evaluation |
| `ulid` | ^2.0.0 | Run ID generation |
| `@sinclair/typebox` | ^0.34.48 | JSON schema runtime validation |

### Development

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.7.0 | TypeScript compiler |
| `tsx` | ^4.0.0 | TS/Node runner for CLI + tests |
| `vitest` | ^4.0.18 | Test framework (selective use) |

## Deployment Targets

| Target | Config File | Notes |
|--------|-------------|-------|
| Local | `npm run dev` (tsx watch) | Development |
| Docker | `docker-compose.yml` | Single-container with volumes |
| Docker+GPU | `docker-compose.gpu.yml` | vLLM (Qwen-7B/1.5B) + Redis + loa-finn |
| Railway | `railway.toml` | BridgeBuilder cron (30min interval) |
| Kubernetes | Docker image + env config | Via Docker image |
