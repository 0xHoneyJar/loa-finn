# Changelog

All notable changes to **loa-finn** will be documented in this file.

**loa-finn** is a lightweight, persistent AI agent runtime. It exposes HTTP and WebSocket APIs for managing Claude-powered agent sessions, routes LLM requests across multiple providers with budget enforcement, and durably persists all state via a write-ahead log backed by [Cloudflare R2](https://developers.cloudflare.com/r2/) object storage. Built on [Pi SDK](https://github.com/nicolecomputer/pi-sdk) (a minimal agent framework) and the [Hono](https://hono.dev/) HTTP framework, it targets Node.js 22+ and deploys to Railway, Fly.io, or Docker.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Glossary

| Term | Definition |
|------|-----------|
| **Hounfour** | loa-finn's multi-model routing subsystem — routes LLM requests across providers (Claude, GPT, Qwen, Moonshot) with cost tracking and health-based fallbacks |
| **BridgeBuilder** | Autonomous GitHub PR review bot — runs on a cron schedule, reviews PRs with Claude, posts structured feedback |
| **Cheval** | Python HTTP sidecar that proxies requests to non-Anthropic LLM providers (OpenAI, vLLM) |
| **WAL** | Write-Ahead Log — append-only durability layer for crash recovery |
| **R2** | [Cloudflare R2](https://developers.cloudflare.com/r2/) — S3-compatible object storage used for WAL checkpoints and BridgeBuilder run leases |
| **Loa** | The [development framework](https://github.com/0xHoneyJar/loa) this project is built with — an AI-native SDLC framework that provides structured workflows (`/plan`, `/build`, `/review`), quality gates, and CI infrastructure for Claude Code projects |
| **BEAUVOIR.md** | Agent identity file — injected as the system prompt to define the agent's personality and capabilities |
| **beads** | [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br` CLI) — task tracking tool used during development for sprint management |
| **vLLM** | [vLLM](https://docs.vllm.ai/) — high-throughput LLM inference engine for self-hosted GPU models |

---

## [Unreleased]

## [1.29.0] — 2026-02-18

### Breaking Changes

- **Redis required for Hounfour** — Hounfour (the multi-model routing subsystem, new in this release) stores budget counters, circuit breaker state, rate limiter windows, and idempotency keys in Redis. Any deployment enabling Hounfour must provision a Redis 7+ instance. Set `REDIS_URL` in your environment. Redis is **not** required if you only use the base agent runtime without multi-model routing. (#39)
- **Budget format: float → integer micro-USD** — the cost ledger switched from floating-point USD to integer micro-USD (`Math.floor(usd * 1_000_000)`). Old JSONL ledger files use the previous format and are not read by the new code — they can be safely archived. New ledger entries start fresh. If you need to preserve historical cost data, convert manually: multiply each `cost_usd` field by `1_000_000` and truncate to integer. (#45)
- **loa-hounfour extracted to separate package** — shared contract types (schemas, validators, vocabulary) moved to [`@0xhoneyjar/loa-hounfour`](https://github.com/0xHoneyJar/loa-hounfour) as a git dependency. TypeScript import paths are unchanged; only `package.json` needs updating (`"@0xhoneyjar/loa-hounfour": "github:0xHoneyJar/loa-hounfour#v1.1.0"`). This is only breaking if you were importing from `packages/loa-hounfour/` directly. (#61)

### Added

#### Multi-Model Routing (Hounfour) (#36, #39, #45, #61)

Hounfour enables routing agent requests across LLM providers with cost controls and automatic failover.

- **Provider registry** — alias resolution, capability matching, health-aware fallback chains with circular dependency detection
- **Cost ledger** — micro-USD integer arithmetic with budget enforcement (warn at threshold, block at limit, downgrade to cheaper model)
- **Cheval HTTP sidecar** — FastAPI server with HMAC auth, replacing the original subprocess-based Python adapter
- **SSE streaming** — real-time token relay with backpressure, reconnect, and wire-contract validation
- **Redis state layer** — budget counters, circuit breaker state, rate limiter windows, idempotency cache — all with atomic Lua scripts
- **ES256 JWT auth** — JWKS rotation, request hash verification (timing-safe), JTI replay guard with TTL expiry
- **Pool registry** — canonical pool-to-provider mapping with tier-based authorization
- **EnsembleOrchestrator** — parallel multi-model dispatch with three merge strategies: `first_complete`, `best_of_n` (scoring function), `consensus` (majority vote)
- **AnthropicAdapter** — Claude Messages API adapter implementing `ModelPortBase` + `ModelPortStreaming`
- **S2S JWT signer** (ES256) for inter-service authentication
- **Usage reporter** with durable delivery, exponential backoff, and dead-letter replay
- **GPU deployment** — Dockerfile and docker-compose.gpu.yml for self-hosted vLLM inference (Qwen2.5-Coder-7B AWQ + 1.5B FP16) with health-based fallback routing
- **Active health probes** — periodic HTTP probes + Prometheus metrics scraping (GPU utilization, tokens/sec, queue depth)
- **Ledger exporter** — JSONL rotation, gzip compression, SHA-256 integrity, R2/S3 upload with index manifest
- **Data retention/redaction** — per-provider config with recursive regex redaction
- **Shared contract package** — schemas, validators, vocabulary, and 90 test vectors extracted to [`@0xhoneyjar/loa-hounfour`](https://github.com/0xHoneyJar/loa-hounfour)

#### Autonomous Agent Jobs (#25)

Cron-driven GitHub automation with a 14-layer safety stack.

- **Job templates**: PR Review, Issue Triage, PR Draft, Stale Cleanup
- **Workflow engine**: YAML-defined workflows with step I/O schemas, gate semantics (approve/reject/skip), persistence
- **Safety stack**: default-deny tool registry, GitHub API firewall, per-template action policies, rate limiting, circuit breakers, kill switch (4 methods), concurrency manager, HMAC audit trail, secret redaction
- **Observability dashboard**: server-rendered HTML with WebSocket auto-refresh, auth (RBAC), CSRF protection, kill switch UI

#### BridgeBuilder PR Review Bot (#30, #34, #38, #59)

Autonomous GitHub PR reviewer deployed on Railway cron.

- Hexagonal ports-and-adapters architecture — 7 ports, 5 core modules, core has zero `node:*` imports for portability
- Dual idempotency: R2 two-phase claims + GitHub HTML markers
- Output sanitization: 7 secret patterns scanned before posting
- Rate limit tracking with budget exhaustion guard, exponential backoff
- Dashboard activity feed: GitHub PR/issue activity across repos with dark-theme UI
- Six-layer provenance system for review quality tracking (parsing, validation, measurement, intelligence, memory, governance)

#### Worker Thread Sandbox (#33)

Moved synchronous tool execution to `node:worker_threads`, unblocking the event loop. Zero new dependencies, all existing sandbox security preserved.

- Thread pool with priority lanes (interactive + reserved system worker), per-session fairness
- Workers receive immutable `ExecSpec` — no secrets or policy objects cross the thread boundary
- Event loop p99 delay: 10.17ms (threshold: 50ms)
- WebSocket ping/pong survival: 100%

#### Persistence Hardening (#18, #21, #23)

Adopted the Loa framework's persistence library and hardened the full stack.

- Replaced custom WAL and circuit breaker with upstream framework implementations
- Recovery timeouts: per-source timeouts (5s availability, 30s restore), 120s overall boot deadline
- Fsync-on-flush for WAL/checkpoint durability
- Rotation recovery for corrupted WAL segments
- Tool execution sandbox: 7-stage pipeline (gate, tokenize, policy, jail, audit, execute, redact) with filesystem jail, TOCTOU-safe symlink walk, command allowlist, secret redaction

### Changed

- **BridgeBuilder refactored** to consume the upstream Loa `bridgebuilder-review` skill — thin adapter layer replaces 17 duplicated source files, net -1,700 lines (#38)
- **Git sync** uses `execFileSync` instead of `execSync` — eliminates command injection from config values (#21)
- **Tool execution** is now async via worker threads — `sandbox.execute()` returns a Promise (#33)
- Loa framework updated to v1.33.1 (#7, #35)

### Security

- **JTI replay protection** with Redis-backed TTL store (#45, #54)
- **Active budget circuit breaker** — transient tolerance with sliding window enforcement (#54)
- **Async ensemble scorer** with backward-compatible sync fallback (#54)
- **Pool registry provider validation** — prevents misconfigured routing (#54)
- **Shell pipeline hardening** — dual-hash staleness detection, JSON escaping fixes (#54)
- **Shell injection fix** in git-sync — `execFileSync` replacing `execSync` (#21)
- **Shutdown drain** — `wal.compact()` before shutdown prevents data loss (#21)
- Internal security audit (Loa `/audit-sprint` workflow): 0 CRITICAL, 0 HIGH findings across all sprints

### Fixed

- **Docker build** — include `.claude/lib` in build context for upstream persistence imports (#32)
- **BridgeBuilder streaming** — Cloudflare 60s TTFB timeout resolved via SSE streaming
- **BridgeBuilder self-review** — 422 on `REQUEST_CHANGES` to own PR falls back to `COMMENT`
- **Stream bridge abort** — LRU idempotency cache replaces unbounded Map

---

## [0.1.0] - 2026-02-06

Initial release of loa-finn. Built as a lightweight alternative to [loa-beauvoir](https://github.com/0xHoneyJar/loa-beauvoir) (a full agent runtime based on [OpenClaw](https://github.com/nicolecomputer/openclaw), the open-source Pi SDK agent orchestration layer). loa-finn provides the same core agent capabilities with a fraction of the dependency footprint (~15MB vs 200MB+ node_modules) by using Pi SDK directly instead of the full OpenClaw stack.

### Added

#### Agent Core

- [Pi SDK](https://github.com/nicolecomputer/pi-sdk) integration with custom `LoaResourceLoader`
- BEAUVOIR.md identity injection — agent personality loaded as the system prompt
- Custom tools: `beads_status`, `health_check`, `grimoire_read`, `beads_update`
- Session creation with `createAgentSession()` + `SessionManager`

#### HTTP + WebSocket Gateway

- [Hono](https://hono.dev/) HTTP server with REST endpoints (sessions CRUD, `/health`)
- WebSocket streaming bridging `AgentSessionEvent` to browser clients
- Bearer token auth with timing-safe comparison
- Token bucket rate limiting per IP, CORS middleware
- Single-file WebChat UI (dark theme, streaming, auto-reconnect)

#### Persistence

- Write-Ahead Log (WAL) with monotonic ULIDs, 10MB rotation, checksum verification
- [Cloudflare R2](https://developers.cloudflare.com/r2/) checkpoint sync with two-phase protocol
- Git archival to dedicated `finn/archive` branch (fast-forward only)
- Recovery cascade: R2 (warm) → Git (cold) → Template (clean)
- WAL pruning after confirmed checkpoints

#### Scheduler & Compound Learning

- Task scheduler with configurable intervals and jitter
- Three-state circuit breaker (CLOSED → OPEN → HALF-OPEN)
- Health aggregator (agent, WAL, R2, git, beads, scheduler)
- Compound learning: trajectory logging → pattern extraction → quality gates → NOTES.md

#### Deployment

- Multi-stage Dockerfile (node:22-slim)
- Docker Compose for local development
- Cloudflare Workers + Fly.io deployment configs
- Graceful shutdown (SIGTERM → drain → sync → exit, 30s max)

### Research

- Architectural research mapping loa-beauvoir → loa-finn (PR #4)
- Analysis of 20 loa-beauvoir PRs to extract architectural lessons
- 10 recorded architectural decisions with rationale

[Unreleased]: https://github.com/0xHoneyJar/loa-finn/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/0xHoneyJar/loa-finn/releases/tag/v0.1.0
