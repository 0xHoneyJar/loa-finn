# Software Design Document: loa-finn

> **Version**: 1.0.0
> **Date**: 2026-02-06
> **Author**: @janitooor
> **Status**: Draft
> **PRD**: `grimoires/loa/prd.md` v1.0.0
> **Grounding**: `grimoires/loa/context/research-minimal-pi.md`, Pi SDK v0.52.6 API analysis

---

## 1. Executive Summary

loa-finn is a minimal persistent Loa agent runtime built on Pi's SDK layer (`@mariozechner/pi-coding-agent` v0.52.x). It provides a web-accessible Loa agent with 3-tier persistence (WAL → R2 → Git), beads-first state management, and compound learning — in ~1,400 lines of custom TypeScript.

The architecture has five layers:

```
┌─────────────────────────────────────┐
│         Gateway (Hono)              │  ← HTTP/WS, routing, webchat UI
├─────────────────────────────────────┤
│         Agent (Pi SDK)              │  ← createAgentSession(), tools, streaming
├─────────────────────────────────────┤
│         Identity (Loa)              │  ← BEAUVOIR.md → system prompt, grimoires
├─────────────────────────────────────┤
│         Persistence                 │  ← WAL, R2 sync, Git sync, recovery
├─────────────────────────────────────┤
│         Scheduler                   │  ← Cron tasks, circuit breakers, health
└─────────────────────────────────────┘
```

Each layer depends only on the layer below it. No circular dependencies. No event bus. Unidirectional data flow.

---

## 2. Technology Stack

| Component | Choice | Version | Rationale |
|-----------|--------|---------|-----------|
| Runtime | Node.js | 22+ | Pi SDK requirement, native ESM |
| Language | TypeScript | 5.7+ | Strict mode, Pi SDK types |
| Package Manager | pnpm | 9+ | Workspace-aware, disk-efficient |
| Agent SDK | `@mariozechner/pi-coding-agent` | 0.52.x | Agent loop, session mgmt, tools, compaction |
| LLM Abstraction | `@mariozechner/pi-ai` | 0.52.x | Multi-provider streaming, TypeBox tool schemas |
| Agent Core | `@mariozechner/pi-agent-core` | 0.52.x | Event-based agent loop |
| HTTP Framework | Hono | 4.x | 14KB, CF Workers native, middleware |
| Schema Validation | TypeBox | 0.34.x | Pi SDK tool parameter schemas (via pi-ai) |
| State Management | beads_rust (`br`) | 0.1.7+ | Universal state machine, labels |
| Object Storage | Cloudflare R2 | S3-compatible | Persistence tier 2 |
| Deployment | Cloudflare Workers Containers | - | Proven in loa-beauvoir |

### Dependency Graph

```
loa-finn (custom: ~1,400 lines)
├── @mariozechner/pi-coding-agent@0.52.x
│   ├── @mariozechner/pi-agent-core@0.52.x
│   │   └── @mariozechner/pi-ai@0.52.x
│   │       └── @sinclair/typebox@0.34.x
│   └── (built-in tools: read, bash, edit, write)
├── hono@4.x
├── @aws-sdk/client-s3@3.x  (R2 via S3-compatible API)
└── ulid@2.x (WAL entry IDs)
```

---

## 3. Component Design

### 3.1 Agent Layer (`src/agent/`)

**Responsibility**: Wraps Pi SDK, manages Loa identity injection, registers tools.

#### 3.1.1 `createLoaSession()`

The primary factory function. Wraps Pi's `createAgentSession()` with Loa-specific configuration.

```typescript
// src/agent/session.ts
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent"
import { getModel } from "@mariozechner/pi-ai"

interface LoaSessionOptions {
  sessionDir: string          // Where JSONL session files live
  beauvoirPath: string        // Path to BEAUVOIR.md
  model?: string              // Default: "claude-opus-4-6"
  existingSessionId?: string  // Resume existing session
}

interface LoaSession {
  session: AgentSession
  sessionId: string
}

async function createLoaSession(options: LoaSessionOptions): Promise<LoaSession>
```

**Design decisions**:
- Uses `SessionManager.create()` for file-based persistence (not in-memory)
- Injects BEAUVOIR.md content as system prompt via Pi's `resourceLoader`
- Registers Loa custom tools alongside Pi's built-in `codingTools`
- Sets `thinkingLevel: "medium"` (matches Loa effort config)

#### 3.1.2 Identity Loader (`src/agent/identity.ts`)

Reads BEAUVOIR.md and constructs the system prompt.

```typescript
interface IdentityLoader {
  load(): Promise<string>         // Read BEAUVOIR.md, return system prompt
  watch(onChange: () => void): void  // fs.watch for hot-reload (FR-6.2)
  getChecksum(): string           // SHA-256 for drift detection
}
```

**No SOUL.md transformation** (Decision D-007). BEAUVOIR.md content is injected directly into Pi's system prompt via a custom `ResourceLoader` that overrides Pi's default `AGENTS.md` discovery.

#### 3.1.3 Custom ResourceLoader

Pi's `ResourceLoader` discovers context files (AGENTS.md, .pi/ prompts, etc.). We replace it to prevent Pi from loading its own defaults and instead inject Loa's identity:

```typescript
// Prevents Pi from loading AGENTS.md / .pi/ defaults
// Instead loads BEAUVOIR.md + grimoire context
class LoaResourceLoader implements ResourceLoader {
  async loadSystemPrompt(): Promise<string>       // From BEAUVOIR.md
  async loadProjectContext(): Promise<string>      // From grimoires/loa/
  async loadExtensions(): Promise<Extension[]>     // Empty (Loa has its own)
  async loadPromptTemplates(): Promise<Map<...>>   // Empty
}
```

#### 3.1.4 Tool Registry (`src/agent/tools.ts`)

Registers tools using Pi's `ToolDefinition` interface with TypeBox schemas.

**Built-in tools from Pi** (included by default via `codingTools`):
- `read` — read file contents
- `bash` — execute shell commands
- `edit` — string replacement in files
- `write` — write file contents

**Custom Loa tools** (registered via `customTools`):
- `beads_status` — query beads state via `br list`
- `beads_update` — update bead labels
- `grimoire_read` — read from grimoires/ with context awareness
- `health_check` — query system health

**Tool Permission Model** (production):

| Control | Default | Description |
|---------|---------|-------------|
| `bash` execution | **Denied** | `bash` tool is disabled in production by default. Enabled only via `FINN_ALLOW_BASH=true` env var. |
| Command allowlist | `br`, `git log`, `git status`, `ls`, `cat`, `wc` | When bash is enabled, only allowlisted commands are permitted. Enforced by intercepting `execute` and parsing the command prefix. Unlisted commands return `ToolPermissionError`. |
| Filesystem scoping | `/data` workspace jail | All file tools (`read`, `write`, `edit`) are scoped to the `dataDir` directory tree. Paths are canonicalized via `realpath` to prevent symlink escape. Access outside the jail returns `ToolPermissionError`. |
| Env var redaction | Active | All tool outputs are scanned for patterns matching known secret env vars (`ANTHROPIC_API_KEY`, `R2_SECRET_ACCESS_KEY`, etc.) and redacted to `[REDACTED]` before being returned to the agent or streamed to clients. |

Tool definitions use TypeBox for parameter schemas:

```typescript
import { Type } from "@sinclair/typebox"

const beadsStatusTool: ToolDefinition = {
  name: "beads_status",
  label: "Beads Status",
  description: "Query beads state machine for current task status",
  parameters: Type.Object({
    label: Type.Optional(Type.String({ description: "Filter by label" })),
    status: Type.Optional(Type.String({ description: "Filter by status" })),
  }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // Executes: br list --label <label> --status <status> --json
    // Returns parsed bead state
  },
}
```

### 3.2 Gateway Layer (`src/gateway/`)

**Responsibility**: HTTP/WS server, session routing, webchat UI.

#### 3.2.1 HTTP Server (`src/gateway/server.ts`)

Built on Hono for Cloudflare Workers compatibility:

```typescript
import { Hono } from "hono"

const app = new Hono()

// Health endpoint (FR-5.3)
app.get("/health", healthHandler)

// REST API (FR-2.5)
app.post("/api/sessions", createSessionHandler)
app.post("/api/sessions/:id/message", messageHandler)
app.get("/api/sessions", listSessionsHandler)
app.get("/api/sessions/:id", getSessionHandler)

// Static webchat UI (FR-2.4)
app.get("/*", serveStatic({ root: "./public" }))

export { app }
```

#### 3.2.2 WebSocket Handler (`src/gateway/ws.ts`)

Upgrades HTTP connections to WebSocket for streaming (FR-2.2):

```typescript
interface WSMessage {
  type: "prompt" | "steer" | "abort" | "ping"
  sessionId?: string
  text?: string
}

interface WSEvent {
  type: "text_delta" | "tool_start" | "tool_end" | "turn_end" |
        "error" | "compaction" | "pong"
  data: unknown
}
```

**Event bridging**: Subscribes to Pi's `AgentSession` events and translates them to WSEvent messages:

| Pi Event | WS Event | Data |
|----------|----------|------|
| `message_update` (text_delta) | `text_delta` | `{ delta: string }` |
| `tool_execution_start` | `tool_start` | `{ toolName, args }` |
| `tool_execution_end` | `tool_end` | `{ toolName, result, isError }` |
| `turn_end` | `turn_end` | `{ messageCount }` |
| `auto_compaction_start` | `compaction` | `{ reason }` |

**WebSocket Security**:

| Control | Value | Behavior |
|---------|-------|----------|
| Origin check | Whitelist via `FINN_CORS_ORIGINS` | Reject upgrade if `Origin` header not in whitelist |
| Payload size limit | 1 MB max | Close connection with 1009 (Message Too Big) if exceeded |
| Connection cap | 5 per IP | Reject upgrade with 429 if IP exceeds cap |
| Idle timeout | 5 minutes | Close with 1000 (Normal Closure) after 5 min of no client messages; `ping`/`pong` frames reset the timer |
| Reconnect behavior | Client-driven | Server sends `{ "type": "error", "data": { "reconnect": true } }` before graceful close; client should reconnect with exponential backoff (1s, 2s, 4s, max 30s) and resume via `sessionId` |

#### 3.2.3 Session Router (`src/gateway/sessions.ts`)

Maps HTTP/WS requests to Pi AgentSession instances:

```typescript
interface SessionRouter {
  create(): Promise<{ sessionId: string }>
  get(sessionId: string): AgentSession | undefined
  resume(sessionId: string): Promise<AgentSession>
  list(): SessionInfo[]
}
```

**Lifecycle**:
1. `create()` — calls `createLoaSession()`, stores in Map, creates bead with `session:active` label
2. `get()` — returns cached session or undefined
3. `resume()` — loads session from JSONL via `SessionManager.open()`, re-subscribes events
4. `list()` — returns all session metadata (id, created, lastActivity)

**Single-tenant v1**: No auth, no user isolation. All sessions belong to one operator.

#### 3.2.4 Authentication Middleware (`src/gateway/auth.ts`)

App-layer auth for all API and WebSocket routes, enforced via Hono middleware:

```typescript
interface AuthConfig {
  bearerTokenHash: string          // SHA-256 of expected token (from env FINN_AUTH_TOKEN)
  corsOrigins: string[]            // Allowed origins (e.g., ["https://finn.example.com"])
  csrfEnabled: boolean             // Default: true for browser UI routes
  rateLimiting: {
    windowMs: number               // Default: 60_000 (1 min)
    maxRequestsPerWindow: number   // Default: 60
  }
}
```

**Bearer Token Validation**: All `/api/*` routes require `Authorization: Bearer <token>` header. Token is compared against `FINN_AUTH_TOKEN` env var via constant-time comparison. Unauthenticated requests receive `401 Unauthorized`.

**WebSocket Authentication**: WS connections authenticate via one of:
1. Token in query string: `ws://host:port/ws/:sessionId?token=<token>`
2. Token in first message: `{ "type": "auth", "token": "<token>" }` — connection is held in a pending state until auth message arrives (5s timeout, then close with 4001).

**CORS Origin Whitelist**: Configured via `FINN_CORS_ORIGINS` env var (comma-separated). Requests from unlisted origins are rejected with `403 Forbidden`. In local development, `localhost:*` is allowed by default.

**CSRF Protection**: All state-mutating requests from browser UI require `X-CSRF-Token` header. Token is issued via `GET /api/csrf-token` and validated server-side. Applied only to routes served with `text/html` content negotiation.

**Per-IP Rate Limiting**: Hono middleware tracks request counts per IP within a sliding window. Exceeding the limit returns `429 Too Many Requests` with `Retry-After` header. Rate limit state is in-memory (acceptable for single-instance v1).

### 3.3 Persistence Layer (`src/persistence/`)

**Responsibility**: WAL, object store sync, git sync, crash recovery.

#### 3.3.1 Write-Ahead Log (`src/persistence/wal.ts`)

Every state mutation is logged before application:

```typescript
interface WALEntry {
  id: string           // ULID (monotonic, sortable)
  timestamp: number    // Unix milliseconds
  type: WALEntryType   // "session" | "bead" | "memory" | "config"
  operation: string    // "create" | "update" | "delete"
  path: string         // File path affected
  data: unknown        // Serialized payload
  checksum: string     // SHA-256 of JSON.stringify(data)
}

type WALEntryType = "session" | "bead" | "memory" | "config"

interface WAL {
  append(entry: Omit<WALEntry, "id" | "timestamp" | "checksum">): Promise<WALEntry>
  replay(since?: string): AsyncIterable<WALEntry>
  rotate(): Promise<void>     // Rotate when segment exceeds 10MB
  getSegments(): string[]     // List segment files
}
```

**Implementation details**:
- Append-only within segment files (`wal-{ulid}.jsonl`)
- `flock(fd, LOCK_EX)` for exclusive writes (no TOCTOU)
- Segment rotation at 10MB boundaries
- ULID-based ordering ensures global sort across segments

**Retention & Pruning**: After a successful R2 sync cycle followed by a confirmed git commit, WAL segments whose last entry predates the checkpoint are eligible for pruning. Pruning is deferred — eligible segments are renamed to `wal-{ulid}.prunable` and removed on the next scheduler tick (prevents race with in-flight reads). The current active segment is never pruned.

**Disk-Pressure Behavior**: The WAL monitors available disk space at each append via `statfs`. When free space drops below 100 MB:
1. **Degraded mode**: WAL switches to read-only. New `append()` calls return a `DiskPressureError`. The agent can still serve cached responses and read existing sessions but cannot accept new prompts.
2. **Health signal**: `wal.status` changes to `"disk_pressure"` in the health aggregator, triggering an alert.
3. **Recovery**: When free space rises above 150 MB (50 MB hysteresis), normal append operations resume automatically.

#### 3.3.2 Object Store Sync (`src/persistence/r2-sync.ts`)

Syncs local state to R2 every 30 seconds (FR-3.3):

```typescript
interface ObjectStoreSync {
  sync(): Promise<SyncResult>      // Push WAL + sessions + grimoires to R2
  restore(): Promise<RestoreResult> // Pull latest state from R2
  getLastSync(): Date | null
}

interface SyncResult {
  filesUploaded: number
  bytesUploaded: number
  duration: number
}
```

Uses `@aws-sdk/client-s3` with R2 endpoint configuration:

```typescript
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
})
```

**Sync strategy**: Incremental. Tracks last-synced WAL entry ID. Only uploads entries since last sync.

**Manifest Protocol**: Each sync cycle follows a two-phase commit to prevent partial uploads from corrupting remote state:

1. **Phase 1 — Upload objects**: Upload all new WAL segments and changed files to R2. Each object is keyed by content hash (content-addressable). Failed uploads abort the cycle without advancing the checkpoint.
2. **Phase 2 — Upload checkpoint**: After all objects are verified uploaded, write a `checkpoint.json` to R2 containing:

```typescript
interface R2Checkpoint {
  checkpointId: string        // ULID of this checkpoint
  timestamp: number           // Unix milliseconds
  walSegments: string[]       // Complete list of WAL segment keys in R2
  walHeadEntryId: string      // Last WAL entry ID included in this checkpoint
  objects: Array<{
    key: string               // R2 object key
    sha256: string            // Content hash
    size: number              // Bytes
  }>
  bootEpoch: string           // ULID of the instance that created this checkpoint
}
```

The checkpoint is only written after verifying all referenced objects exist in R2 (via `HeadObject` calls). On restore, the recovery cascade reads `checkpoint.json` first and only downloads objects listed in it — any orphaned objects from failed prior syncs are ignored.

#### 3.3.3 Git Sync (`src/persistence/git-sync.ts`)

Git is a **read-only archival tier** — it stores immutable snapshots, not live JSONL. Pushes are fast-forward-only on a dedicated branch to prevent merge conflicts.

```typescript
interface GitSync {
  snapshot(): Promise<SnapshotResult>  // Create immutable snapshot + commit
  push(): Promise<void>                // Fast-forward-only push to dedicated branch
  restore(): Promise<RestoreResult>    // Pull latest snapshot (for recovery)
}

interface SnapshotResult {
  commitHash: string
  snapshotId: string          // ULID of this snapshot
  filesIncluded: string[]
  walCheckpoint: string       // WAL entry ID at snapshot time
}
```

**Dedicated branch**: Git sync operates on `finn/archive` branch (configurable via `git.archiveBranch`). Never pushes to `main`. This branch contains only immutable snapshots — no live session files.

**Fast-forward-only**: `push()` uses `--ff-only`. If the push fails (remote has diverged), the sync enters a **hard fail** state: logs the conflict at `error` level, sets `gitSync.status = "conflict"` in health, and halts all future git sync until the operator resolves the divergence manually. No automatic merge or rebase.

**Snapshot contents**: `grimoires/loa/`, `.beads/`, and a `snapshot-manifest.json` containing the WAL checkpoint ID, timestamp, and file checksums. Session JSONL files are NOT included (they live in R2 only). Does NOT commit `.claude/` (System Zone).

**Conflict detection**: Before each push, compares local `HEAD` against `refs/remotes/origin/finn/archive`. If they diverge, the conflict is recorded and the operator must intervene.

#### 3.3.4 Recovery Cascade (`src/persistence/recovery.ts`)

Boot-time recovery following the priority chain (FR-3.5):

```typescript
interface RecoveryCascade {
  recover(mode: RecoveryMode): Promise<RecoveryResult>
}

type RecoveryMode = "strict" | "degraded" | "clean"

interface RecoveryResult {
  source: "r2" | "git" | "template"
  mode: RecoveryMode
  filesRestored: number
  walEntriesReplayed: number
  duration: number
  conflicts?: ConflictInfo[]
}

interface ConflictInfo {
  walHeadId: string          // Last WAL entry ID from local state
  remoteHeadId: string       // Last WAL entry ID from R2/git
  bootEpoch: string          // ULID of this boot cycle
  resolution: "operator" | "readonly" | "template"
}

// Recovery order:
// 1. R2 (warm, <5s) — most recent state
// 2. Git (cold, <30s) — last committed state
// 3. Template (clean start) — BEAUVOIR.md + empty grimoires
```

**Recovery Modes**:

| Mode | Behavior | When Used |
|------|----------|-----------|
| **Strict** | Fail fast on corruption or conflict detection. Log error, set health to `unhealthy`, and refuse to start until operator intervenes. | Production default. Data integrity is paramount. |
| **Degraded** | Enter read-only operation. Serve cached responses and existing sessions. No new WAL writes, no sync. Set health to `degraded`. | When R2 and git both fail but local state is intact. |
| **Clean** | Template fallback (BEAUVOIR.md + empty grimoires). All prior state is abandoned. Logged prominently at `error` level with full context of what was lost. | Last resort. Operator is notified via health endpoint. |

**Conflict Detection**: On recovery, the cascade compares the local WAL head ID against the remote WAL head ID (from R2 checkpoint or git). If they diverge (indicating concurrent writes from a previous instance), a `ConflictInfo` record is created. Each boot generates a unique boot epoch (ULID) to distinguish instances. In strict mode, conflicts halt recovery. In degraded mode, the local state is used read-only until the operator resolves the divergence.

### 3.4 Scheduler Layer (`src/scheduler/`)

**Responsibility**: Periodic tasks with circuit breakers.

#### 3.4.1 Task Scheduler (`src/scheduler/scheduler.ts`)

```typescript
interface ScheduledTask {
  id: string
  name: string
  intervalMs: number
  jitterMs: number          // Randomized offset to prevent thundering herd
  handler: () => Promise<void>
  circuitBreaker: CircuitBreaker
}

interface Scheduler {
  register(task: ScheduledTask): void
  start(): void
  stop(): void
  getStatus(): SchedulerStatus
}
```

**Registered tasks**:

| Task ID | Name | Interval | Jitter | Handler |
|---------|------|----------|--------|---------|
| `r2_sync` | R2 Sync | 30s | ±5s | `objectStoreSync.sync()` |
| `git_sync` | Git Sync | 1h | ±5m | `gitSync.commit() + push()` |
| `health` | Health Check | 5m | ±30s | `healthAggregator.check()` |
| `stale_beads` | Stale Bead Detection | 24h | ±30m | `br list --stale` |
| `identity_reload` | Identity Reload | 60s | ±5s | `identityLoader.checkAndReload()` |

#### 3.4.2 Circuit Breaker (`src/scheduler/circuit-breaker.ts`)

Implements the three-state circuit breaker pattern:

```typescript
type CircuitState = "closed" | "open" | "half-open"

interface CircuitBreaker {
  state: CircuitState
  execute<T>(fn: () => Promise<T>): Promise<T>
  getStats(): CircuitBreakerStats
}

interface CircuitBreakerConfig {
  failureThreshold: number   // Default: 3 failures to trip
  cooldownMs: number         // Default: 300_000 (5 min)
  halfOpenMaxAttempts: number // Default: 1
}
```

**State transitions**:
```
CLOSED (normal) → 3 failures → OPEN (blocking)
OPEN → 5min cooldown → HALF-OPEN (probe)
HALF-OPEN → success → CLOSED
HALF-OPEN → failure → OPEN (restart cooldown)
```

All circuit breaker state changes logged to WAL and reflected in beads labels (`circuit-breaker:{task_id}`).

#### 3.4.3 Health Aggregator (`src/scheduler/health.ts`)

Aggregates health from all subsystems for the `/health` endpoint:

```typescript
interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy"
  uptime: number
  checks: {
    agent: { status: string; model: string; lastPrompt?: Date }
    wal: { status: string; segmentCount: number; totalEntries: number }
    r2Sync: { status: string; lastSync?: Date; behindBy: number }
    gitSync: { status: string; lastCommit?: Date }
    beads: { status: string; open: number; inProgress: number }
    scheduler: { status: string; tasks: TaskStatus[] }
  }
}
```

### 3.5 Beads Bridge (`src/beads/`)

**Responsibility**: Interface between loa-finn runtime and beads_rust (`br` CLI).

```typescript
interface BeadsBridge {
  createBead(title: string, labels: string[]): Promise<string>  // Returns bead ID
  updateBead(id: string, updates: BeadUpdate): Promise<void>
  listBeads(filter?: BeadFilter): Promise<Bead[]>
  getHealth(): Promise<BeadsHealth>
}

interface BeadUpdate {
  status?: "open" | "in_progress" | "closed"
  addLabels?: string[]
  removeLabels?: string[]
  comment?: string
}

interface BeadFilter {
  status?: string
  label?: string
}
```

**Implementation**: Shells out to `br` CLI via `child_process.execFile`. This is intentional — `br` handles its own WAL and sync, and we don't want to reimplement its state machine.

**Bridge Contracts**:

| Contract | Specification |
|----------|---------------|
| Timeout | 30 seconds per `br` invocation; `execFile` `timeout` option. Timeout triggers `SIGTERM` → 5s grace → `SIGKILL`. |
| Exit code handling | `0` = success, parse stdout as JSON. Non-zero = error, capture stderr as error message, propagate as `BeadsBridgeError`. |
| Stderr capture | Always captured. On success, logged at `debug` level (br may emit warnings). On failure, included in error payload. |
| Missing binary detection | At boot, run `br --version`. If `ENOENT`, log `"beads_rust (br) not found — beads features disabled"`, set `beads.available = false` in health, and no-op all bridge methods (return empty arrays / void). |
| Version compatibility | Parse `br --version` output. Require `>=0.1.7`. If incompatible, log warning and set `beads.status = "version_mismatch"` in health. |

**Labels convention**:

| Label | Meaning |
|-------|---------|
| `session:active` | Session is currently in use |
| `session:idle` | Session exists but no recent activity |
| `health:ok` | System healthy |
| `health:degraded` | Some subsystems degraded |
| `sync:pending` | R2 sync has pending entries |
| `sync:complete` | R2 sync up to date |
| `circuit-breaker:{id}` | Circuit breaker tripped for task |
| `compound:pending` | Compound review needed |
| `compound:complete` | Compound review done for this cycle |

### 3.6 Compound Learning (`src/learning/`)

**Responsibility**: Extract reusable patterns from agent trajectory data and feed them back into future sessions.

**Triggers**:
- **End-of-session**: When a session transitions to `session:idle` (no activity for 30 minutes), the compound learning pipeline runs automatically.
- **Scheduled**: The scheduler runs compound learning every 24 hours (`stale_beads` cadence) to catch sessions that were abandoned without clean idle transition.

**Artifacts & Pipeline**:

```
Agent Trajectory JSONL            ← Raw session + tool call data
        ↓
Pattern Extraction                ← Identify recurring tool sequences, error → fix pairs,
        ↓                            and successful resolution strategies
Candidate Learnings               ← Structured { trigger, context, resolution, confidence }
        ↓
Quality Gates (3+ of 4 pass)     ← Depth, Reusability, Trigger Clarity, Verification
        ↓
NOTES.md Update                  ← Append to grimoires/loa/NOTES.md ## Learnings
        ↓
WAL Entry                        ← type: "memory", operation: "create"
```

**Feedback Loop**: At session creation, `createLoaSession()` loads the most recent learnings from `grimoires/loa/NOTES.md ## Learnings` (last 20 entries, ~2K tokens) and appends them to the system prompt as a `## Recent Learnings` section. This gives each new session access to patterns discovered in prior sessions without manual operator intervention.

```typescript
interface CompoundLearning {
  extract(sessionId: string): Promise<CandidateLearning[]>
  evaluate(candidates: CandidateLearning[]): Promise<QualifiedLearning[]>
  persist(learnings: QualifiedLearning[]): Promise<void>
  loadForContext(limit?: number): Promise<string>  // Formatted for system prompt
}

interface CandidateLearning {
  trigger: string          // What situation activates this learning
  context: string          // Environment / preconditions
  resolution: string       // What to do
  confidence: number       // 0-1 extraction confidence
  sourceSessionId: string
  sourceEntryIds: string[] // WAL entry IDs that produced this
}
```

---

## 4. Data Architecture

### 4.1 File System Layout

```
/data/                          # Persistent volume (R2-synced)
├── sessions/                   # Pi JSONL session files
│   ├── {session-id}/
│   │   └── context.jsonl       # Pi's native session format
│   └── ...
├── wal/                        # Write-ahead log segments
│   ├── wal-{ulid}.jsonl
│   └── ...
├── grimoires/loa/              # Loa state (synced)
│   ├── BEAUVOIR.md
│   ├── NOTES.md
│   ├── prd.md
│   ├── sdd.md
│   ├── a2a/trajectory/         # Agent trajectory logs
│   └── memory/
├── .beads/                     # Beads state
│   ├── config.yaml
│   ├── issues.jsonl
│   └── metadata.json
└── config.json                 # Runtime configuration
```

### 4.2 Session Data (Pi-native)

Pi's JSONL session format is used as-is (Constraint #1 from PRD). Each session is a tree of entries:

```
Session Header → Message Entry → Message Entry → Compaction Entry → Message Entry → ...
                     ↑ parentId chain ↑                                    ↑
```

No custom session format. Pi handles serialization, branching, and compaction natively.

### 4.3 WAL Data

```jsonl
{"id":"01HX...","timestamp":1707177600000,"type":"session","operation":"create","path":"sessions/abc/context.jsonl","data":{"sessionId":"abc"},"checksum":"sha256:..."}
{"id":"01HX...","timestamp":1707177630000,"type":"bead","operation":"update","path":".beads/issues.jsonl","data":{"id":"35","addLabels":["session:active"]},"checksum":"sha256:..."}
```

### 4.4 Configuration

```typescript
interface FinnConfig {
  // Agent
  model: string                    // Default: "claude-opus-4-6"
  thinkingLevel: string            // Default: "medium"
  beauvoirPath: string             // Default: "grimoires/loa/BEAUVOIR.md"

  // Gateway
  port: number                     // Default: 3000
  host: string                     // Default: "0.0.0.0"

  // Persistence
  dataDir: string                  // Default: "/data"
  r2: {
    endpoint: string
    bucket: string
    accessKeyId: string            // From env: R2_ACCESS_KEY_ID
    secretAccessKey: string        // From env: R2_SECRET_ACCESS_KEY
  }
  git: {
    remote: string                 // Default: "origin"
    branch: string                 // Default: "main"
  }

  // Scheduler
  syncIntervalMs: number           // Default: 30_000
  gitSyncIntervalMs: number        // Default: 3_600_000
  healthIntervalMs: number         // Default: 300_000

  // Authentication (Section 3.2.4)
  auth: {
    bearerTokenHash: string        // SHA-256 of FINN_AUTH_TOKEN env var
    corsOrigins: string[]          // From env: FINN_CORS_ORIGINS (comma-separated)
    csrfEnabled: boolean           // Default: true
    rateLimiting: {
      windowMs: number             // Default: 60_000
      maxRequestsPerWindow: number // Default: 60
    }
  }
}
```

All secrets via environment variables. Never in code, never in git.

---

## 5. API Design

### 5.1 REST API

#### `GET /health`

```json
{
  "status": "healthy",
  "uptime": 3600,
  "checks": {
    "agent": { "status": "ok", "model": "claude-opus-4-6" },
    "wal": { "status": "ok", "segments": 2, "entries": 147 },
    "r2Sync": { "status": "ok", "lastSync": "2026-02-06T02:00:00Z" },
    "beads": { "status": "ok", "open": 1, "inProgress": 0 }
  }
}
```

#### `POST /api/sessions`

Creates a new agent session.

**Request**: `{}` (no body required for single-tenant v1)

**Response** (201):
```json
{
  "sessionId": "abc123",
  "created": "2026-02-06T02:00:00Z",
  "wsUrl": "ws://localhost:3000/ws/abc123"
}
```

#### `POST /api/sessions/:id/message`

Send a message and receive complete response (non-streaming).

**Request**:
```json
{ "text": "What files are in the current directory?" }
```

**Response** (200):
```json
{
  "response": "I can see the following files...",
  "toolCalls": [
    { "name": "bash", "args": { "command": "ls -la" }, "result": "..." }
  ],
  "usage": { "inputTokens": 1200, "outputTokens": 450 }
}
```

#### `GET /api/sessions`

List all sessions.

**Response** (200):
```json
{
  "sessions": [
    { "id": "abc123", "created": "2026-02-06T02:00:00Z", "lastActivity": "2026-02-06T02:15:00Z", "messageCount": 12 }
  ]
}
```

### 5.2 WebSocket API

Connect: `ws://host:port/ws/:sessionId`

#### Client → Server

```typescript
// Send a prompt
{ "type": "prompt", "text": "Hello" }

// Steer mid-execution (interrupts current tool)
{ "type": "steer", "text": "Actually, use Python instead" }

// Abort current execution
{ "type": "abort" }

// Keepalive
{ "type": "ping" }
```

#### Server → Client

```typescript
// Streaming text
{ "type": "text_delta", "data": { "delta": "I can " } }

// Tool execution lifecycle
{ "type": "tool_start", "data": { "toolName": "bash", "args": { "command": "ls" } } }
{ "type": "tool_end", "data": { "toolName": "bash", "result": "file1.ts\nfile2.ts", "isError": false } }

// Turn complete
{ "type": "turn_end", "data": { "messageCount": 5, "usage": { "input": 1200, "output": 450 } } }

// Agent loop complete
{ "type": "agent_end", "data": {} }

// Auto-compaction notification
{ "type": "compaction", "data": { "reason": "threshold" } }

// Error
{ "type": "error", "data": { "message": "Context window exceeded", "recoverable": true } }

// Keepalive response
{ "type": "pong" }
```

---

## 6. Security Architecture

### 6.1 Threat Model (Single-Tenant v1)

| Threat | Severity | Mitigation |
|--------|----------|------------|
| Unauthorized access to web UI | Medium | Network-level (Cloudflare Access / Tailscale) + app-layer bearer token auth (Section 3.2.4) |
| Unauthorized API access | High | Bearer token required on all `/api/*` routes; WS auth via token in query string or first message (Section 3.2.4) |
| API key exposure | High | Env vars only, never logged, never in git; tool output redaction (Section 3.1.4) |
| Prompt injection via web UI | Medium | Pi's built-in tool confirmation + Loa's BEAUVOIR.md trust boundaries |
| R2 bucket exposure | Medium | IAM scoped to single bucket, no public access |
| Tool execution escape | High | Bash denied by default in production; command allowlist; filesystem jail to `/data` (Section 3.1.4) |
| Brute-force / abuse | Medium | Per-IP rate limiting (60 req/min default); WS connection cap (5 per IP) (Sections 3.2.2, 3.2.4) |
| CSRF attacks on browser UI | Medium | CSRF token required for state-mutating requests from browser (Section 3.2.4) |
| Cross-origin attacks | Medium | CORS origin whitelist; WS origin check on upgrade (Sections 3.2.2, 3.2.4) |

### 6.2 Credential Management

| Secret | Source | Never In |
|--------|--------|----------|
| `ANTHROPIC_API_KEY` | Env var | Code, git, logs, tool output |
| `R2_ACCESS_KEY_ID` | CF Workers secret | Code, git, logs, tool output |
| `R2_SECRET_ACCESS_KEY` | CF Workers secret | Code, git, logs, tool output |
| `GIT_TOKEN` | Env var | Code, git, logs, tool output |
| `FINN_AUTH_TOKEN` | Env var | Code, git, logs, tool output |

All credential values are registered with the env var redaction system (Section 3.1.4). Any tool output containing a credential pattern is scrubbed before being returned to the agent context or streamed to WebSocket clients.

### 6.3 Network Security

- Gateway binds to `0.0.0.0:3000` inside container
- External access via Cloudflare Workers proxy (HTTPS only)
- App-layer authentication via bearer token on all API/WS routes (Section 3.2.4)
- Network-level access control (CF Access, Tailscale, or VPN) provides defense-in-depth
- Multi-tenant v1.1 will add session-level auth with JWT

### 6.4 Rate Limiting

| Scope | Limit | Window | Response |
|-------|-------|--------|----------|
| REST API (per IP) | 60 requests | 1 minute | `429 Too Many Requests` + `Retry-After` header |
| WebSocket connections (per IP) | 5 concurrent | — | Reject upgrade with 429 |
| WebSocket messages (per connection) | 30 messages | 1 minute | Close with 4029 (custom code) |
| Session creation | 10 sessions | 1 hour | `429` + log at `warn` level |

Rate limit configuration is part of `AuthConfig` (Section 3.2.4). All limits are tunable via environment variables (`FINN_RATE_LIMIT_*`).

---

## 7. Deployment Architecture

### 7.1 Cloudflare Workers Container

```
GitHub (push to main)
    ↓
GitHub Actions (build + test)
    ↓
wrangler deploy (container image)
    ↓
Cloudflare Workers Container (single instance)
    ↓
R2 bucket (persistence tier 2)
```

#### `wrangler.jsonc`

```jsonc
{
  "name": "loa-finn",
  "main": "dist/index.js",
  "compatibility_date": "2026-02-06",
  "containers": {
    "instance_type": "standard-4",
    "max_instances": 1
  },
  "r2_buckets": [
    { "binding": "FINN_DATA", "bucket_name": "loa-finn-data" }
  ],
  "triggers": {
    "crons": ["*/5 * * * *"]
  }
}
```

### 7.2 Docker Image

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY public/ ./public/
COPY grimoires/ ./grimoires/
COPY .claude/ ./.claude/
COPY .beads/ ./.beads/

# Install beads_rust
RUN curl -sSL https://github.com/Dicklesworthstone/beads_rust/releases/latest/download/br-linux-amd64 -o /usr/local/bin/br && chmod +x /usr/local/bin/br

EXPOSE 3000
CMD ["node", "dist/index.js"]
```

**Target**: <500MB image size.

### 7.3 Fly.io Fallback

Same Dockerfile, deployed via `fly deploy`. Configuration in `fly.toml`:

```toml
[build]

[http_service]
  internal_port = 3000
  force_https = true

[mounts]
  source = "finn_data"
  destination = "/data"
```

### 7.4 Local Development

```bash
pnpm dev                    # Runs with tsx --watch
# Opens http://localhost:3000
```

No Docker required for local dev. Docker for production parity:

```bash
docker compose up           # Mirrors production environment
```

---

## 8. Integration Points

### 8.1 Pi SDK Integration

| Integration | Method | Notes |
|-------------|--------|-------|
| Session creation | `createAgentSession()` | Custom ResourceLoader for Loa identity |
| Streaming events | `session.subscribe()` | Callback-based, bridged to WebSocket |
| Tool registration | `customTools` option | TypeBox schemas, Pi validates via AJV |
| Session persistence | `SessionManager.create()` | File-based JSONL, Pi-native format |
| Auto-compaction | Built-in | Triggered by Pi when context approaches limit |
| Model selection | `getModel("anthropic", modelId)` | From `pi-ai` |

### 8.2 Beads Integration

| Integration | Method | Notes |
|-------------|--------|-------|
| State tracking | `br` CLI via `child_process.execFile` | Labels for all runtime state |
| Health checks | `br doctor` | Via scheduler task |
| State sync | `br sync --flush-only` | Via scheduler task |

### 8.3 Cloudflare Integration

| Integration | Method | Notes |
|-------------|--------|-------|
| R2 storage | `@aws-sdk/client-s3` with R2 endpoint | Persistence tier 2 |
| Cron triggers | `wrangler.jsonc` triggers | Backup sync trigger |
| Workers secrets | `wrangler secret put` | API keys and credentials |

---

## 9. Scalability & Performance

### 9.1 Single-Instance Design

loa-finn v1 is explicitly single-instance (PRD non-goal: no horizontal scaling). This simplifies:
- No distributed WAL / consensus
- No session affinity / routing
- No R2 conflict resolution
- flock-based locking works (single process)

### 9.2 Performance Targets

| Metric | Target | How |
|--------|--------|-----|
| Boot time | <15s | Minimal deps, no deferred loading |
| First response | <2s | Pi SDK streams immediately |
| WAL append | <1ms | flock + append-only file I/O |
| R2 sync | <5s per cycle | Incremental upload (only new WAL entries) |
| Memory | <512MB | Single agent session, bounded by Pi's context window |

### 9.3 Future Scaling Path (v1.1+)

When multi-tenant is needed:
1. Session router becomes tenant-aware (auth → tenant → session)
2. WAL becomes per-tenant (separate segment files)
3. R2 paths become tenant-prefixed (`/tenants/{id}/...`)
4. Multiple container instances with sticky sessions

---

## 10. Development Workflow

### 10.1 Project Structure

```
loa-finn/
├── src/
│   ├── index.ts                 # Entry point: boot → recover → start gateway
│   ├── config.ts                # Configuration loading from env
│   ├── agent/
│   │   ├── session.ts           # createLoaSession() wrapper
│   │   ├── identity.ts          # BEAUVOIR.md → system prompt
│   │   ├── resource-loader.ts   # Custom Pi ResourceLoader
│   │   └── tools.ts             # Custom Loa tool definitions
│   ├── gateway/
│   │   ├── server.ts            # Hono app setup
│   │   ├── ws.ts                # WebSocket handler + event bridge
│   │   ├── sessions.ts          # Session router
│   │   └── handlers.ts          # REST API handlers
│   ├── persistence/
│   │   ├── wal.ts               # Write-ahead log
│   │   ├── r2-sync.ts           # R2 object store sync
│   │   ├── git-sync.ts          # Git commit sync
│   │   └── recovery.ts          # Boot recovery cascade
│   ├── scheduler/
│   │   ├── scheduler.ts         # Task scheduler
│   │   ├── circuit-breaker.ts   # Circuit breaker pattern
│   │   └── health.ts            # Health aggregator
│   └── beads/
│       └── bridge.ts            # br CLI integration
├── public/
│   └── index.html               # WebChat UI (minimal)
├── deploy/
│   ├── Dockerfile
│   ├── wrangler.jsonc
│   └── fly.toml
├── test/
│   ├── smoke.test.ts
│   ├── wal.test.ts
│   └── circuit-breaker.test.ts
├── grimoires/loa/               # Loa state zone
├── .claude/                     # Loa system zone
├── .beads/                      # Beads state
├── package.json
├── tsconfig.json
└── pnpm-lock.yaml
```

### 10.2 Boot Sequence

```
1. Load config from environment
2. Run recovery cascade (R2 → Git → Template)
3. Initialize WAL
4. Initialize beads bridge
5. Create Hono app + WebSocket handler
6. Start scheduler (R2 sync, git sync, health, stale beads, identity reload)
7. Start HTTP server on configured port
8. Log "loa-finn ready" with health status
```

### 10.3 Git Strategy

- `main` — production, auto-deploys
- `feature/*` — development branches, PR required
- Commits follow conventional commits (`feat:`, `fix:`, `chore:`)
- Beads track all sprint work

### 10.4 Testing Strategy

| Layer | Test Type | Tool |
|-------|-----------|------|
| Agent | Integration | Pi's `SessionManager.inMemory()` + mock model |
| Gateway | HTTP | Hono's built-in test client |
| WAL | Unit | Temp directories, verify append + rotation |
| Circuit Breaker | Unit | Simulated failures |
| E2E | Smoke | Boot → send message → verify response |

---

## 11. Technical Risks & Mitigation

| Risk | Mitigation | Owner |
|------|-----------|-------|
| Pi SDK v0.52.x breaking changes | Pin in package.json, run `pnpm audit` weekly | Operator |
| Pi's `ResourceLoader` API changes | Adapter pattern wraps all Pi imports in `src/agent/` | Sprint 1 |
| R2 unavailable during sync | Circuit breaker, WAL retains all data locally | Sprint 4 |
| Context window exhaustion | Pi handles auto-compaction natively | Built-in |
| Session file corruption | WAL enables replay from last known good state | Sprint 3 |
| Container restart during tool execution | Recovery cascade + Pi session resume | Sprint 3 |

---

## 12. Future Considerations

### v1.1: Multi-Tenant

- Add JWT-based auth middleware to Hono
- Tenant isolation at session, WAL, and R2 levels
- Per-tenant rate limiting

### v1.1: Messaging Channels

- Channel plugins as separate Hono middleware
- Discord: `discord.js` webhook handler
- Slack: Bolt framework handler
- Channel-agnostic session router (message → session → agent)

### v1.2: Monitoring

- Prometheus metrics endpoint (`/metrics`)
- Grafana dashboard for: uptime, response latency, token usage, sync status
- Alerting via Cloudflare notifications or webhook

---

## Appendix A: Pi SDK Version Pinning

```json
{
  "dependencies": {
    "@mariozechner/pi-coding-agent": "~0.52.6",
    "@mariozechner/pi-ai": "~0.52.6",
    "@mariozechner/pi-agent-core": "~0.52.6"
  }
}
```

Tilde (`~`) allows patch updates only. Major/minor changes require manual review.

## Appendix B: Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `R2_ACCESS_KEY_ID` | Yes (prod) | — | R2 credentials |
| `R2_SECRET_ACCESS_KEY` | Yes (prod) | — | R2 credentials |
| `R2_ENDPOINT` | Yes (prod) | — | R2 endpoint URL |
| `R2_BUCKET` | No | `loa-finn-data` | R2 bucket name |
| `GIT_TOKEN` | No | — | Git push credentials |
| `PORT` | No | `3000` | Server port |
| `HOST` | No | `0.0.0.0` | Server bind address |
| `MODEL` | No | `claude-opus-4-6` | Default model |
| `THINKING_LEVEL` | No | `medium` | Default thinking level |
| `DATA_DIR` | No | `/data` | Persistent data directory |
| `FINN_AUTH_TOKEN` | Yes (prod) | — | Bearer auth token for API/WS |
| `FINN_CORS_ORIGINS` | No | `localhost:*` | Comma-separated allowed CORS origins |
| `FINN_ALLOW_BASH` | No | `false` | Enable bash tool in production |
| `FINN_RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit sliding window |
| `FINN_RATE_LIMIT_MAX` | No | `60` | Max requests per window per IP |
