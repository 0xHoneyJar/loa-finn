# Sprint Plan: loa-finn MVP

> **Version**: 1.0.0
> **Date**: 2026-02-06
> **PRD**: `grimoires/loa/prd.md` v1.0.0
> **SDD**: `grimoires/loa/sdd.md` v1.0.0
> **Cycle**: cycle-001

---

## Overview

| Parameter | Value |
|-----------|-------|
| Team size | 1 developer (operator + Loa agent pair) |
| Sprint duration | ~1 week each |
| Total sprints | 6 |
| Target code | <2,000 lines TypeScript |
| Beads tracking | Required (beads-first) |

### Sprint Dependency Graph

```
Sprint 1 (Agent Core)
├──► Sprint 2 (Gateway)
│    └──► Sprint 5 (Deployment)
└──► Sprint 3 (Persistence)
     └──► Sprint 4 (Scheduler & Compound)
          └──► Sprint 6 (Loa Integration)
```

---

## Sprint 1: Agent Core

> **Goal**: Pi SDK boots, accepts message, returns coherent response
> **Exit Criteria**: `node dist/smoke.js "Hello"` returns coherent Claude response via Pi SDK
> **Depends on**: Nothing (foundation)
> **Global Sprint ID**: 1

### Tasks

#### T-1.1: Project Scaffolding

**Description**: Initialize TypeScript project with pnpm, configure tsconfig, add Pi SDK dependencies.

**Acceptance Criteria**:
- [ ] `pnpm init` with correct package.json metadata (name: loa-finn, type: module)
- [ ] `tsconfig.json` with strict mode, ESM output, Node22 target
- [ ] Pi SDK dependencies pinned: `@mariozechner/pi-coding-agent@~0.52.6`, `@mariozechner/pi-ai@~0.52.6`, `@mariozechner/pi-agent-core@~0.52.6`
- [ ] `hono@^4.0.0` and `ulid@^2.0.0` in dependencies
- [ ] `pnpm build` produces `dist/` with compiled JS
- [ ] `.gitignore` includes node_modules, dist, .env

**Effort**: Small (1-2h)

#### T-1.2: Configuration Module

**Description**: Create `src/config.ts` that loads runtime configuration from environment variables with sensible defaults.

**Acceptance Criteria**:
- [ ] `FinnConfig` interface matches SDD §4.4
- [ ] All secrets loaded from env vars (ANTHROPIC_API_KEY, R2_*, GIT_TOKEN)
- [ ] Defaults for port (3000), host (0.0.0.0), model (claude-opus-4-6), thinkingLevel (medium)
- [ ] `loadConfig()` throws on missing required vars (ANTHROPIC_API_KEY)
- [ ] `.env.example` documents all variables

**Effort**: Small (1h)

#### T-1.3: Identity Loader

**Description**: Create `src/agent/identity.ts` that reads BEAUVOIR.md and returns it as system prompt text.

**Acceptance Criteria**:
- [ ] `IdentityLoader.load()` reads BEAUVOIR.md from configured path
- [ ] `IdentityLoader.getChecksum()` returns SHA-256 of content
- [ ] Returns empty string + warning if BEAUVOIR.md not found (graceful degradation)
- [ ] No SOUL.md transformation (Decision D-007)

**Effort**: Small (1h)

#### T-1.4: Custom ResourceLoader

**Description**: Create `src/agent/resource-loader.ts` implementing Pi's ResourceLoader interface to inject Loa identity instead of Pi's defaults.

**Acceptance Criteria**:
- [ ] `LoaResourceLoader` implements Pi's `ResourceLoader` interface
- [ ] `loadSystemPrompt()` returns BEAUVOIR.md content
- [ ] `loadProjectContext()` returns grimoire context (NOTES.md, recent learnings)
- [ ] `loadExtensions()` returns empty array (Loa has its own)
- [ ] Prevents Pi from loading AGENTS.md / .pi/ defaults

**Effort**: Medium (2-3h)

#### T-1.5: createLoaSession() Factory

**Description**: Create `src/agent/session.ts` with the primary factory function wrapping Pi's `createAgentSession()`.

**Acceptance Criteria**:
- [ ] `createLoaSession(options)` creates a Pi AgentSession with Loa identity
- [ ] Uses `SessionManager.create()` for file-based session persistence
- [ ] Passes custom `LoaResourceLoader`
- [ ] Sets `thinkingLevel` from config
- [ ] Returns `{ session, sessionId }` tuple
- [ ] Supports `existingSessionId` for session resume

**Effort**: Medium (2-3h)

#### T-1.6: Tool Registry

**Description**: Create `src/agent/tools.ts` registering custom Loa tools alongside Pi builtins using TypeBox schemas.

**Acceptance Criteria**:
- [ ] Pi's built-in `codingTools` (read, bash, edit, write) included
- [ ] `beads_status` tool: queries `br list` with optional label/status filter
- [ ] `health_check` tool: returns basic system health
- [ ] All tools use TypeBox parameter schemas
- [ ] Tools registered via `customTools` option on session creation

**Effort**: Medium (2-3h)

#### T-1.7: Smoke Test

**Description**: Create `test/smoke.test.ts` and `scripts/smoke.ts` that boots the agent, sends one message, verifies response.

**Acceptance Criteria**:
- [ ] `pnpm smoke "Hello"` sends message to Pi agent and prints response
- [ ] Response is coherent Claude text (not error)
- [ ] Pi session JSONL file created in sessions directory
- [ ] Test completes in <30s
- [ ] Exit code 0 on success, 1 on failure

**Effort**: Small (1-2h)

#### T-1.8: CF Workers Platform Spike

**Description**: Validate Cloudflare Workers container capabilities: durable volumes, flock behavior, binary exec (br CLI), disk limits, WebSocket support, fs.watch.

**Acceptance Criteria**:
- [ ] Written report of container capabilities and limitations
- [ ] Verify durable volume persistence across restarts
- [ ] Test flock(2) behavior inside container
- [ ] Confirm br CLI binary execution works
- [ ] Document disk space limits and constraints
- [ ] Verify WebSocket upgrade and long-lived connection support
- [ ] Test fs.watch reliability on durable volumes
- [ ] Decision: proceed with CF Workers or pivot to Fly.io

**Effort**: Small (2-3h)

---

## Sprint 2: Gateway

> **Goal**: WebChat accessible via browser with auth and streaming responses
> **Exit Criteria**: Browser opens URL, types message, sees streaming response
> **Depends on**: Sprint 1 (Agent Core)
> **Global Sprint ID**: 2

### Tasks

#### T-2.1: Hono HTTP Server

**Description**: Create `src/gateway/server.ts` with Hono app and basic route structure.

**Acceptance Criteria**:
- [ ] Hono app created with `/health` returning `{ status: "ok" }`
- [ ] `src/index.ts` entry point boots server on configured port
- [ ] `pnpm dev` starts with tsx watch mode
- [ ] Server logs "loa-finn ready on :3000"

**Effort**: Small (1-2h)

#### T-2.2: REST API Handlers

**Description**: Create `src/gateway/handlers.ts` with session CRUD and message endpoints.

**Acceptance Criteria**:
- [ ] `POST /api/sessions` creates new session, returns sessionId + wsUrl
- [ ] `POST /api/sessions/:id/message` sends message, returns complete response
- [ ] `GET /api/sessions` lists all sessions with metadata
- [ ] `GET /api/sessions/:id` returns single session info
- [ ] Error responses follow `{ error: string, code: string }` format

**Effort**: Medium (2-3h)

#### T-2.3: Session Router

**Description**: Create `src/gateway/sessions.ts` managing session lifecycle.

**Acceptance Criteria**:
- [ ] `SessionRouter.create()` calls `createLoaSession()`, stores in memory Map
- [ ] `SessionRouter.get(id)` returns cached session or undefined
- [ ] `SessionRouter.resume(id)` loads from JSONL via `SessionManager.open()`
- [ ] `SessionRouter.list()` returns session metadata (id, created, lastActivity)
- [ ] Sessions survive page reload (resume from JSONL)

**Effort**: Medium (2-3h)

#### T-2.4: WebSocket Handler

**Description**: Create `src/gateway/ws.ts` with WebSocket upgrade and Pi event bridging.

**Acceptance Criteria**:
- [ ] `ws://host:port/ws/:sessionId` upgrade handler
- [ ] Client→Server: `prompt`, `steer`, `abort`, `ping` message types
- [ ] Server→Client: `text_delta`, `tool_start`, `tool_end`, `turn_end`, `compaction`, `error`, `pong`
- [ ] Pi `AgentSession` events bridged to WS events per SDD §3.2.2
- [ ] Connection cleanup on close/error

**Effort**: Medium (3-4h)

#### T-2.5: WebChat UI

**Description**: Create `public/index.html` with minimal but functional chat interface.

**Acceptance Criteria**:
- [ ] Single HTML file with embedded CSS/JS (no build step)
- [ ] WebSocket connection to server
- [ ] Message input with send button
- [ ] Streaming response display (text_delta renders incrementally)
- [ ] Tool execution indicators (tool_start/tool_end visible)
- [ ] Session creation on page load, resume on reload
- [ ] Works in Chrome, Firefox, Safari

**Effort**: Medium (3-4h)

#### T-2.6: Gateway Integration Test

**Description**: End-to-end test: boot server → create session → send message → verify streaming response.

**Acceptance Criteria**:
- [ ] Test creates session via REST API
- [ ] Sends message via WebSocket
- [ ] Receives streaming text_delta events
- [ ] Receives turn_end event
- [ ] Completes in <60s

**Effort**: Small (1-2h)

#### T-2.7: Authentication Middleware

**Description**: Bearer token auth on all API endpoints, WS auth, CORS origin checks, CSRF protection.

**Acceptance Criteria**:
- [ ] All REST API endpoints require valid Bearer token in Authorization header
- [ ] WebSocket upgrade requests validated with token (query param or first message)
- [ ] CORS origin whitelist configured via environment variable
- [ ] CSRF protection on state-mutating endpoints
- [ ] Unauthorized requests return 401 with `{ error: "Unauthorized", code: "AUTH_REQUIRED" }`
- [ ] Token validation is constant-time (timing-safe comparison)

**Effort**: Medium (3-4h)

#### T-2.8: Rate Limiting

**Description**: Per-IP and per-session rate limits on all endpoints. Global concurrency cap.

**Acceptance Criteria**:
- [ ] Per-IP rate limit on all endpoints (configurable, default 60 req/min)
- [ ] Per-session rate limit on message endpoints (configurable, default 20 msg/min)
- [ ] Global concurrency cap on active agent sessions (configurable, default 5)
- [ ] Exceeding limits returns 429 with `Retry-After` header
- [ ] Rate limit thresholds configurable via environment variables
- [ ] In-memory token bucket with no external dependencies

**Effort**: Small (1-2h)

#### T-2.9: WebSocket Hardening

**Description**: Origin validation, payload size limits, connection caps, idle timeout.

**Acceptance Criteria**:
- [ ] WebSocket origin validated against CORS whitelist
- [ ] Payload size limit: 1MB per message, oversized messages rejected with close code 1009
- [ ] Connection cap: max 5 WebSocket connections per IP
- [ ] Idle timeout: connections with no activity for 5 minutes are closed with close code 1000
- [ ] Malformed messages (invalid JSON, missing fields) rejected with error frame
- [ ] All limits configurable via environment variables

**Effort**: Small (1-2h)

---

## Sprint 3: Persistence

> **Goal**: State survives process restart
> **Exit Criteria**: Kill process → restart → resume conversation where left off
> **Depends on**: Sprint 1 (Agent Core)
> **Global Sprint ID**: 3

### Tasks

#### T-3.1: Write-Ahead Log

**Description**: Create `src/persistence/wal.ts` implementing append-only WAL with flock-based writes.

**Acceptance Criteria**:
- [ ] `WAL.append(entry)` writes JSONL entry with ULID id, timestamp, checksum
- [ ] `flock(fd, LOCK_EX)` ensures exclusive writes (no TOCTOU)
- [ ] `WAL.replay(since?)` returns AsyncIterable of entries since given ULID
- [ ] `WAL.rotate()` creates new segment file when current exceeds 10MB
- [ ] WAL entry types: "session", "bead", "memory", "config"
- [ ] ULID ordering ensures global sort across segments

**Effort**: Medium (3-4h)

#### T-3.2: R2 Object Store Sync

**Description**: Create `src/persistence/r2-sync.ts` for incremental sync to Cloudflare R2.

**Acceptance Criteria**:
- [ ] `ObjectStoreSync.sync()` uploads new WAL entries + sessions + grimoires to R2
- [ ] Uses `@aws-sdk/client-s3` with R2 endpoint configuration
- [ ] Incremental: tracks last-synced WAL entry ID, only uploads delta
- [ ] `ObjectStoreSync.restore()` pulls latest state from R2
- [ ] Returns `SyncResult` with filesUploaded, bytesUploaded, duration
- [ ] Graceful failure when R2 unavailable (logs warning, continues)

**Effort**: Medium (3-4h)

#### T-3.3: Git Sync

**Description**: Create `src/persistence/git-sync.ts` for periodic git commits.

**Acceptance Criteria**:
- [ ] `GitSync.commit()` stages grimoires/loa/, .beads/, session JSONL files
- [ ] `GitSync.push()` pushes to configured remote/branch
- [ ] `GitSync.pull()` pulls latest (for recovery)
- [ ] Does NOT commit .claude/ (System Zone)
- [ ] Uses conventional commit format: `chore(sync): auto-sync state`

**Effort**: Small (2h)

#### T-3.4: Recovery Cascade

**Description**: Create `src/persistence/recovery.ts` implementing boot-time recovery.

**Acceptance Criteria**:
- [ ] Recovery tries: R2 (warm, <5s) → Git (cold, <30s) → Template (clean start)
- [ ] Template fallback creates valid empty state (BEAUVOIR.md + empty grimoires)
- [ ] Recovery ALWAYS succeeds — never waits for human intervention
- [ ] Returns `RecoveryResult` with source, filesRestored, walEntriesReplayed, duration
- [ ] WAL entries replayed in ULID order on recovery

**Effort**: Medium (3-4h)

#### T-3.5: WAL Unit Tests

**Description**: Test WAL append, replay, rotation, and flock behavior.

**Acceptance Criteria**:
- [ ] Test append creates valid JSONL with ULID and checksum
- [ ] Test replay returns entries in order, respects `since` filter
- [ ] Test rotation creates new segment at 10MB boundary
- [ ] Test concurrent appends don't corrupt (flock verification)
- [ ] All tests use temp directories, clean up after

**Effort**: Small (1-2h)

#### T-3.6: Persistence Integration Test

**Description**: End-to-end: send messages → kill process → restart → verify state restored.

**Acceptance Criteria**:
- [ ] Create session, send 3 messages
- [ ] Simulate process restart (re-run boot sequence)
- [ ] Session resumes with conversation history intact
- [ ] WAL entries replayed correctly
- [ ] Test completes in <30s

**Effort**: Small (2h)

#### T-3.7: WAL Pruning & Retention

**Description**: Prune WAL segments after successful R2 sync + git commit checkpoint. Disk pressure detection triggers read-only/degraded mode.

**Acceptance Criteria**:
- [ ] Old WAL segments pruned after both R2 sync and git commit confirm checkpoint
- [ ] Pruning preserves the current active segment (never prune in-use file)
- [ ] Disk pressure detection: monitor available disk space on data volume
- [ ] System enters degraded/read-only mode when disk falls below 100MB
- [ ] Degraded mode: no new WAL writes, existing sessions read-only, /health reports "degraded"
- [ ] Recovery: system exits degraded mode automatically when disk space freed

**Effort**: Small (1-2h)

---

## Sprint 4: Scheduler & Compound

> **Goal**: Self-monitoring with circuit breakers + compound learning cycle
> **Exit Criteria**: `/health` returns status. Circuit breakers trigger on failure. Compound review runs.
> **Depends on**: Sprint 3 (Persistence)
> **Global Sprint ID**: 4

### Tasks

#### T-4.1: Task Scheduler

**Description**: Create `src/scheduler/scheduler.ts` with configurable periodic task execution.

**Acceptance Criteria**:
- [ ] `Scheduler.register(task)` adds a task with id, interval, jitter, handler
- [ ] `Scheduler.start()` begins all registered tasks with randomized jitter
- [ ] `Scheduler.stop()` cleanly stops all tasks
- [ ] `Scheduler.getStatus()` returns status of all tasks
- [ ] Jitter prevents thundering herd (±N% of interval)

**Effort**: Medium (2-3h)

#### T-4.2: Circuit Breaker

**Description**: Create `src/scheduler/circuit-breaker.ts` implementing three-state circuit breaker.

**Acceptance Criteria**:
- [ ] States: CLOSED → OPEN (3 failures) → HALF-OPEN (5min cooldown) → CLOSED (1 success)
- [ ] `execute(fn)` wraps handler with circuit breaker logic
- [ ] OPEN state rejects immediately (no execution)
- [ ] HALF-OPEN allows 1 probe attempt
- [ ] State changes logged to WAL
- [ ] State reflected in beads labels (`circuit-breaker:{task_id}`)

**Effort**: Medium (2-3h)

#### T-4.3: Health Aggregator

**Description**: Create `src/scheduler/health.ts` that aggregates subsystem health for `/health`.

**Acceptance Criteria**:
- [ ] Checks: agent, wal, r2Sync, gitSync, beads, scheduler
- [ ] Overall status: "healthy" (all ok), "degraded" (some issues), "unhealthy" (critical failure)
- [ ] `/health` endpoint returns full `HealthStatus` JSON per SDD §3.4.3
- [ ] Includes uptime counter
- [ ] Each check has independent status + metadata

**Effort**: Medium (2-3h)

#### T-4.4: Register Scheduled Tasks

**Description**: Wire up the 5 scheduled tasks defined in SDD §3.4.1.

**Acceptance Criteria**:
- [ ] `r2_sync` task: 30s interval, ±5s jitter, calls `objectStoreSync.sync()`
- [ ] `git_sync` task: 1h interval, ±5m jitter, calls `gitSync.commit() + push()`
- [ ] `health` task: 5m interval, ±30s jitter, calls `healthAggregator.check()`
- [ ] `stale_beads` task: 24h interval, ±30m jitter, runs stale detection
- [ ] `identity_reload` task: 60s interval, ±5s jitter, checks BEAUVOIR.md for changes
- [ ] All tasks wrapped with individual circuit breakers

**Effort**: Small (1-2h)

#### T-4.5: Identity Hot-Reload

**Description**: Add `fs.watch` to identity loader for BEAUVOIR.md changes.

**Acceptance Criteria**:
- [ ] `IdentityLoader.watch(onChange)` watches BEAUVOIR.md for modifications
- [ ] On change: re-read, update checksum, invoke callback
- [ ] Debounce: ignore changes within 1s window (editor save events)
- [ ] New sessions use updated identity immediately
- [ ] Existing sessions get updated on next compaction

**Effort**: Small (1-2h)

#### T-4.6: Compound Learning Integration

**Description**: Wire compound learning cycle: trajectory logging + compound review trigger.

**Acceptance Criteria**:
- [ ] Agent actions logged to `grimoires/loa/a2a/trajectory/{date}.jsonl`
- [ ] Trajectory entries include: timestamp, action type, tool name, result summary
- [ ] Compound review trigger available (via tool or scheduled)
- [ ] Learnings from review written to NOTES.md
- [ ] Beads label `compound:pending` / `compound:complete` tracks cycle state

**Effort**: Medium (3-4h)

#### T-4.7: Beads Work Queue

**Description**: Implement bounded 30-minute work sessions via beads.

**Acceptance Criteria**:
- [ ] Tasks decomposed into beads with estimated duration
- [ ] Session bounded: agent works for ~30min, then pauses for compound review
- [ ] Beads labels track work queue state: `session:active`, `session:idle`
- [ ] Work queue status queryable via `beads_status` tool

**Effort**: Medium (2-3h)

#### T-4.8: Circuit Breaker Tests

**Description**: Unit tests for circuit breaker state transitions.

**Acceptance Criteria**:
- [ ] Test CLOSED → OPEN after 3 failures
- [ ] Test OPEN rejects immediately
- [ ] Test OPEN → HALF-OPEN after cooldown
- [ ] Test HALF-OPEN → CLOSED on success
- [ ] Test HALF-OPEN → OPEN on failure
- [ ] Test concurrent access is safe

**Effort**: Small (1-2h)

---

## Sprint 5: Deployment

> **Goal**: Running on the internet, accessible via URL
> **Exit Criteria**: Push to main → deployed → accessible via URL → survives rollback
> **Depends on**: Sprint 2 (Gateway), Sprint 3 (Persistence)
> **Global Sprint ID**: 5

### Tasks

#### T-5.1: Dockerfile

**Description**: Create `deploy/Dockerfile` with multi-stage build producing <500MB image.

**Acceptance Criteria**:
- [ ] Multi-stage: builder (install + compile) → runtime (slim)
- [ ] Base: `node:22-slim`
- [ ] Installs `br` CLI from beads_rust releases
- [ ] Copies dist, node_modules, public, grimoires, .claude, .beads
- [ ] Final image <500MB
- [ ] `docker build` succeeds
- [ ] `docker run` boots loa-finn successfully

**Effort**: Medium (2-3h)

#### T-5.2: Docker Compose (Local)

**Description**: Create `docker-compose.yml` for local development with production parity.

**Acceptance Criteria**:
- [ ] Single service: loa-finn
- [ ] Volume mount for /data (persistence)
- [ ] Environment variables from .env
- [ ] Port mapping 3000:3000
- [ ] `docker compose up` boots successfully

**Effort**: Small (1h)

#### T-5.3: Cloudflare Workers Configuration

**Description**: Create `deploy/wrangler.jsonc` for CF Workers container deployment.

**Acceptance Criteria**:
- [ ] Container config: standard-4 instance, max_instances: 1
- [ ] R2 bucket binding: FINN_DATA → loa-finn-data
- [ ] Cron triggers for sync tasks
- [ ] Compatibility date set
- [ ] `wrangler deploy` would succeed (dry-run validated)

**Effort**: Small (1-2h)

#### T-5.4: Fly.io Fallback Configuration

**Description**: Create `deploy/fly.toml` as alternative deployment target.

**Acceptance Criteria**:
- [ ] HTTP service on internal port 3000 with force HTTPS
- [ ] Volume mount for /data persistence
- [ ] Health check on /health endpoint
- [ ] `fly deploy` would succeed (config validated)

**Effort**: Small (1h)

#### T-5.5: GitHub Actions CI/CD

**Description**: Create `.github/workflows/ci.yml` and `.github/workflows/deploy.yml`.

**Acceptance Criteria**:
- [ ] CI: runs on PR, executes `pnpm lint`, `pnpm test`, `pnpm build`
- [ ] Deploy: runs on push to main, builds Docker image, deploys
- [ ] Smoke test after deploy: curl /health, verify 200
- [ ] Automatic rollback on smoke test failure
- [ ] Secrets: ANTHROPIC_API_KEY, R2 credentials, CF/Fly tokens

**Effort**: Medium (3-4h)

#### T-5.6: Environment & Secrets Setup

**Description**: Document and configure secrets management for deployment.

**Acceptance Criteria**:
- [ ] All secrets documented in `.env.example`
- [ ] Cloudflare Workers secrets configured via `wrangler secret put`
- [ ] No secrets in code, git, or logs
- [ ] README section on deployment configuration

**Effort**: Small (1h)

#### T-5.7: Deployment Smoke Test

**Description**: End-to-end verification that deployed instance works.

**Acceptance Criteria**:
- [ ] `/health` returns 200 with all checks passing
- [ ] Create session via API
- [ ] Send message, receive response
- [ ] WebChat UI loads and functions
- [ ] Test script exits 0 on success, 1 on failure

**Effort**: Small (1-2h)

#### T-5.8: Graceful Shutdown

**Description**: SIGTERM handler that drains active WS connections, flushes WAL, finalizes pending R2 sync, logs shutdown event.

**Acceptance Criteria**:
- [ ] SIGTERM handler registered on process startup
- [ ] On SIGTERM: stop accepting new connections immediately
- [ ] Drain active WebSocket connections with close code 1001 (Going Away)
- [ ] Flush all pending WAL entries to disk
- [ ] Finalize any in-progress R2 sync operation
- [ ] Log structured shutdown event with duration and stats (connections drained, WAL entries flushed)
- [ ] `kill -TERM <pid>` waits for in-flight operations (max 30s timeout)
- [ ] No data loss on clean shutdown

**Effort**: Small (1-2h)

---

## Sprint 6: Loa Integration

> **Goal**: Full Loa agent accessible via web, runs autonomously, state persists, compound learning operational
> **Exit Criteria**: Loa agent accessible via web, runs autonomously, state persists, compound learning operational
> **Depends on**: Sprint 4 (Scheduler & Compound), Sprint 5 (Deployment)
> **Global Sprint ID**: 6

### Tasks

#### T-6.1: BEAUVOIR.md Tailoring

**Description**: Create/adapt BEAUVOIR.md identity file specifically for loa-finn runtime context.

**Acceptance Criteria**:
- [ ] BEAUVOIR.md defines Loa personality and directives for web-accessible agent
- [ ] Includes trust boundaries for web interactions
- [ ] References grimoire paths and compound learning conventions
- [ ] Identity loaded on boot, hot-reloaded on change

**Effort**: Small (1-2h)

#### T-6.2: Grimoire Tool (`grimoire_read`)

**Description**: Implement the `grimoire_read` custom tool for agent-accessible grimoire queries.

**Acceptance Criteria**:
- [ ] Tool reads from `grimoires/loa/` with path validation
- [ ] Supports NOTES.md, learnings, context files
- [ ] TypeBox schema for parameters (path, query)
- [ ] Returns file content or search results
- [ ] Prevents reading outside grimoire directory (path traversal protection)

**Effort**: Small (1-2h)

#### T-6.3: Beads Update Tool

**Description**: Implement `beads_update` custom tool for agent self-management of bead state.

**Acceptance Criteria**:
- [ ] Tool updates bead status, labels, comments via `br` CLI
- [ ] TypeBox schema for parameters (id, status, addLabels, removeLabels, comment)
- [ ] Agent can mark tasks in_progress, closed
- [ ] Agent can add/remove labels for state tracking
- [ ] Changes logged to WAL

**Effort**: Small (1-2h)

#### T-6.4: Full Boot Sequence

**Description**: Wire `src/index.ts` with complete boot sequence per SDD §10.2.

**Acceptance Criteria**:
- [ ] Boot order: config → recovery → WAL → beads → Hono → scheduler → serve
- [ ] Each step logged with timing
- [ ] Failure at any step provides clear error message
- [ ] Total boot time <15s
- [ ] "loa-finn ready" log with health status

**Effort**: Medium (2-3h)

#### T-6.5: End-to-End Compound Cycle

**Description**: Verify complete compound learning loop: work → log → review → apply.

**Acceptance Criteria**:
- [ ] Agent performs work (responds to messages, uses tools)
- [ ] Actions logged to trajectory JSONL
- [ ] Compound review extracts learnings from trajectory
- [ ] Learnings written to NOTES.md / learnings storage
- [ ] Next session loads learnings into context
- [ ] Beads labels track: `compound:pending` → `compound:complete`

**Effort**: Medium (3-4h)

#### T-6.6: Production Readiness Checklist

**Description**: Final validation of all systems working together.

**Acceptance Criteria**:
- [ ] Web UI loads, streaming works, sessions persist
- [ ] Kill → restart: state recovered, conversation resumed
- [ ] Circuit breakers trigger on simulated failure
- [ ] /health shows all subsystems healthy
- [ ] R2 sync running (30s cycle)
- [ ] Git sync running (1h cycle)
- [ ] Compound learning cycle completes end-to-end
- [ ] Docker image <500MB
- [ ] Custom code <2,000 lines
- [ ] All acceptance criteria from PRD §2 met

**Effort**: Medium (2-3h)

---

## Summary

| Sprint | Tasks | Estimated Total Effort |
|--------|-------|----------------------|
| 1: Agent Core | 8 tasks (T-1.1 to T-1.8) | ~14-19h |
| 2: Gateway | 9 tasks (T-2.1 to T-2.9) | ~18-26h |
| 3: Persistence | 7 tasks (T-3.1 to T-3.7) | ~15-20h |
| 4: Scheduler & Compound | 8 tasks (T-4.1 to T-4.8) | ~16-22h |
| 5: Deployment | 8 tasks (T-5.1 to T-5.8) | ~11-16h |
| 6: Loa Integration | 6 tasks (T-6.1 to T-6.6) | ~12-16h |
| **Total** | **46 tasks** | **~86-119h** |

### Risk Register

| Risk | Sprint | Mitigation |
|------|--------|-----------|
| Pi SDK ResourceLoader API mismatch | 1 | Adapter pattern wraps all Pi imports in src/agent/ |
| WebSocket event bridging complexity | 2 | Start with REST-only, add WS incrementally |
| flock unavailable on some platforms | 3 | Fallback to lockfile-based mutex |
| R2 unavailable during dev | 3, 5 | Local filesystem mock for R2 in dev mode |
| CF Workers container limits | 5 | Fly.io fallback ready |
| Context window exhaustion during compound | 6 | Pi's built-in auto-compaction handles this |

### MVP Definition

**Minimum Viable Product = Sprint 1 + Sprint 2 + Sprint 3**

After Sprint 3, the system:
- Accepts messages via web browser with authentication (Sprint 2)
- Returns coherent streaming responses (Sprint 1)
- Enforces rate limiting and WebSocket hardening (Sprint 2)
- Survives restart without data loss (Sprint 3)

Auth, rate limiting, and WebSocket hardening are included in Sprint 2 (not deferred). This is the earliest point at which loa-finn provides value over a local Pi session.

**Full Product = All 6 Sprints**

After Sprint 6, the system is a complete persistent Loa agent with self-healing, compound learning, and cloud deployment.
