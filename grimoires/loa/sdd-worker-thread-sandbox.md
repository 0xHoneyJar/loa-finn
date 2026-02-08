# Software Design Document: Worker Thread Sandbox

> **Version**: 1.0.0
> **Date**: 2026-02-08
> **Author**: @janitooor
> **Status**: Draft
> **PRD**: `grimoires/loa/prd-worker-thread-sandbox.md`
> **Cycle**: 005 — Worker Thread Sandbox
> **Issue**: [#28 — pi rust port](https://github.com/0xHoneyJar/loa-finn/issues/28)

---

## 1. Executive Summary

This SDD describes moving `execFileSync` tool execution from the main thread to a `node:worker_threads` pool in loa-finn. The change converts the synchronous `ToolSandbox.execute()` method into an async interface while preserving all 9 stages of the existing security pipeline.

Three new modules are introduced:

| Module | Path | Purpose |
|--------|------|---------|
| `WorkerPool` | `src/agent/worker-pool.ts` | Thread pool with priority lanes and lifecycle management |
| `sandbox-worker` | `src/agent/sandbox-worker.ts` | Worker thread entry — stateless command executor |
| `WorkerPoolStats` | (in worker-pool.ts) | Observability types for health endpoint |

Two existing modules are modified:

| Module | Path | Change |
|--------|------|--------|
| `ToolSandbox` | `src/agent/sandbox.ts` | `execute()` → `async execute()`, delegates to pool |
| `GitSync` | `src/persistence/git-sync.ts` | `git()`/`gitAt()` → async, delegates to pool |

---

## 2. Architecture

### 2.1 Current State (Blocking)

```
Main Thread
┌──────────────────────────────────────────────────┐
│ Pi Agent Session                                  │
│   → sandbox.execute(cmd)                          │
│     → tokenize → policy → jail → audit           │
│     → execFileSync(binary, args, opts)  ← BLOCKS │
│     → redact → audit                              │
│                                                    │
│ CronService.tick()       ← STARVED               │
│ WebSocket.ping()         ← STARVED               │
│ GitSync.snapshot()                                │
│   → execFileSync("git")              ← BLOCKS    │
└──────────────────────────────────────────────────┘
```

### 2.2 Target State (Non-Blocking)

```
Main Thread (Event Loop)                Worker Pool
┌──────────────────────────┐    ┌────────────────────────┐
│ sandbox.execute(cmd)      │    │ Interactive Lane        │
│  ├─ tokenize              │    │ ┌────────────────────┐ │
│  ├─ policy lookup         │    │ │ Worker #1          │ │
│  ├─ resolve binary path   │    │ │  execFile() async  │ │
│  ├─ resolve cwd realpath  │ →  │ │  AbortController   │ │
│  ├─ jail validation       │    │ │  maxBuffer: 1MB    │ │
│  ├─ sanitize env          │    │ └────────────────────┘ │
│  ├─ audit log (pre)       │    │ ┌────────────────────┐ │
│  ├─ dispatch to worker  ──┼──→ │ │ Worker #2          │ │
│  ├─ await result        ◀─┼──┤ │ └────────────────────┘ │
│  ├─ redact secrets        │    ├────────────────────────┤
│  └─ audit log (post)      │    │ System Lane (reserved) │
│                            │    │ ┌────────────────────┐ │
│ CronService.tick()   ✓    │    │ │ Emergency Worker   │ │
│ WebSocket.ping()     ✓    │ →  │ │ health, git only   │ │
│ GitSync.snapshot()   ✓    │    │ └────────────────────┘ │
└──────────────────────────┘    └────────────────────────┘
```

### 2.3 Module Dependency Graph

```
src/agent/session.ts
  └─ src/agent/sandbox.ts (modified: async execute)
       └─ src/agent/worker-pool.ts (NEW)
            └─ src/agent/sandbox-worker.ts (NEW)

src/persistence/git-sync.ts (modified: async git helpers)
  └─ src/agent/worker-pool.ts (shared pool instance)

src/index.ts
  └─ creates WorkerPool singleton, passes to sandbox + git-sync
```

---

## 3. Detailed Module Design

### 3.1 WorkerPool (`src/agent/worker-pool.ts`)

```typescript
import { Worker } from "node:worker_threads"
import { EventEmitter } from "node:events"

// ── Types ────────────────────────────────────────

export interface ExecSpec {
  /** Absolute resolved path to binary (via realpath) */
  binaryPath: string
  /** Validated args array (no shell metacharacters) */
  args: string[]
  /** Realpath-resolved cwd within jail */
  cwd: string
  /** Timeout in ms (default 30_000) */
  timeoutMs: number
  /** Sanitized env — only PATH, HOME, LANG, and allowlisted vars */
  env: Record<string, string>
  /** Max stdout+stderr bytes (default 1MB) */
  maxBuffer: number
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  /** true if output was truncated at maxBuffer */
  truncated: boolean
  /** wall-clock execution time in ms */
  durationMs: number
}

export type PoolLane = "interactive" | "system"

export interface WorkerPoolConfig {
  /** Number of interactive-lane workers (default: 2) */
  interactiveWorkers: number
  /** Path to sandbox-worker.ts (resolved at construction) */
  workerScript: string
  /** Shutdown hard deadline in ms (default: 10_000) */
  shutdownDeadlineMs: number
}

export interface WorkerPoolStats {
  interactive: { active: number; idle: number; queued: number }
  system: { active: boolean; queued: number }
  totals: { completed: number; failed: number; timedOut: number; avgExecMs: number }
}
```

**Key behaviors:**

| Behavior | Implementation |
|----------|---------------|
| Pool creation | `new WorkerPool(config)` spawns N interactive workers + 1 system worker at construction |
| Job dispatch | `pool.exec(spec, lane?)` → `Promise<ExecResult>`. Defaults to `interactive` lane |
| Priority lanes | Interactive and system queues are independent. System lane has a single reserved worker that never processes interactive jobs |
| Queue overflow | Max queue depth per lane (default: 10). Excess jobs rejected with `WORKER_UNAVAILABLE`. Per-session fairness: round-robin dispatch across sessions when queue depth > 50% capacity. Callers should implement exponential backoff (initial 100ms, max 5s) on `WORKER_UNAVAILABLE` |
| Timeout | **Main thread is authoritative for job deadlines.** Sets timer per job. On expiry: sends `{ type: "abort", jobId }` to worker. Worker kills child process group (SIGTERM via `-pid`, then SIGKILL after 5s). Worker posts `{ type: "aborted", jobId }` when child is confirmed dead. If worker doesn't post `aborted` within 10s, main thread calls `worker.terminate()` and spawns replacement. Worker does NOT set an independent timeout — only a safety ceiling (`timeoutMs * 2`) to catch bugs |
| Worker crash | `worker.on("error")` / `worker.on("exit")` → reject pending promise, spawn replacement worker |
| Graceful shutdown | `pool.shutdown()`: set accepting=false, cancel all queued jobs (reject with `POOL_SHUTTING_DOWN`), send abort to running jobs, terminate workers after `shutdownDeadlineMs` |
| Stats | `pool.stats()` returns `WorkerPoolStats` for health endpoint |

**Worker lifecycle:**

```
IDLE ──dispatch──→ BUSY ──result──→ IDLE
                     │
                     ├──timeout──→ ABORT → SIGTERM child → (5s) SIGKILL child → IDLE
                     │                                          │
                     │                                   (10s no response)
                     │                                          ↓
                     └──crash────→ worker.terminate() → spawn replacement
```

### 3.2 sandbox-worker (`src/agent/sandbox-worker.ts`)

The worker is a minimal, stateless executor. It receives an `ExecSpec` via `parentPort.on("message")` and returns an `ExecResult`. Every message includes a `jobId` for correlation.

```typescript
import { parentPort } from "node:worker_threads"
import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { relative, isAbsolute } from "node:path"
import type { ChildProcess } from "node:child_process"

// Defense-in-depth: re-check cwd is within expected jail using path.relative
async function validateCwd(cwd: string, jailRoot: string): Promise<void> {
  const cwdReal = await realpath(cwd)
  const jailReal = await realpath(jailRoot)
  const rel = relative(jailReal, cwdReal)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`cwd ${cwdReal} escapes jail ${jailReal}`)
  }
}

// Track in-flight child process for explicit kill on abort
let currentChild: ChildProcess | null = null
let currentJobId: string | null = null

parentPort!.on("message", async (msg) => {
  if (msg.type === "exec") {
    const { jobId, spec, jailRoot } = msg
    currentJobId = jobId

    await validateCwd(spec.cwd, jailRoot)

    // Safety ceiling only — main thread is authoritative for deadline
    const safetyCeiling = spec.timeoutMs * 2

    const start = performance.now()
    try {
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        currentChild = execFile(
          spec.binaryPath, spec.args, {
            cwd: spec.cwd,
            env: spec.env,
            maxBuffer: spec.maxBuffer,
            timeout: safetyCeiling,
            encoding: "utf-8",
            killSignal: "SIGKILL",
            detached: true,  // new process group for reliable -pid kill
          },
          (err, stdout, stderr) => {
            currentChild = null
            if (err) reject(Object.assign(err, { stdout, stderr }))
            else resolve({ stdout, stderr })
          }
        )
      })

      parentPort!.postMessage({
        type: "result", jobId,
        result: {
          stdout: result.stdout, stderr: result.stderr, exitCode: 0,
          truncated: false,
          durationMs: performance.now() - start,
        }
      })
    } catch (err: unknown) {
      currentChild = null
      // ... handle exitCode, truncation, timeout errors
      parentPort!.postMessage({ type: "result", jobId, result: { ... } })
    }
    currentJobId = null
  }

  if (msg.type === "abort" && msg.jobId === currentJobId) {
    // Explicit child process kill — process group for subprocess trees
    if (currentChild?.pid) {
      try { process.kill(-currentChild.pid, "SIGTERM") } catch {}
      // Escalate to SIGKILL after 5s if child hasn't exited
      const killTimer = setTimeout(() => {
        try { if (currentChild?.pid) process.kill(-currentChild.pid, "SIGKILL") } catch {}
      }, 5_000)
      // Wait for the child's execFile callback to fire (resolve or reject)
      // before posting aborted — this ensures no orphan
      currentChild.once("close", () => {
        clearTimeout(killTimer)
        currentChild = null
        currentJobId = null
        parentPort!.postMessage({ type: "aborted", jobId: msg.jobId })
      })
    } else {
      // No child in flight — acknowledge immediately
      currentJobId = null
      parentPort!.postMessage({ type: "aborted", jobId: msg.jobId })
    }
  }
})
```

**Job correlation protocol:**

| Message | Direction | Fields | Purpose |
|---------|-----------|--------|---------|
| `exec` | main → worker | `jobId`, `spec`, `jailRoot` | Dispatch command |
| `abort` | main → worker | `jobId` | Cancel specific job |
| `result` | worker → main | `jobId`, `result` | Successful completion |
| `aborted` | worker → main | `jobId` | Confirmed child killed |

**jobId generation:** Each job receives a unique `jobId` generated via `crypto.randomUUID()` (RFC 4122 v4, 128-bit, cryptographically random). Uniqueness scope is per-pool-instance (no cross-process coordination needed). The pool MUST validate that incoming `jobId` on `result`/`aborted` messages is a valid UUID and matches the expected in-flight job for that worker. Messages with unknown or mismatched `jobId` are silently discarded (stale response from pre-termination).

**What the worker does NOT have access to:**
- No policy objects or allowlists
- No audit log
- No secret redactor
- No jail reference (only receives pre-resolved paths)
- No environment secrets (sanitized env only)

**Child process lifecycle:**
- Worker retains `ChildProcess` reference via `execFile` callback API (not promisified)
- Spawned with `detached: true` to create a new process group (session leader via `setsid` on Linux)
- On abort: SIGTERM to process group (`-pid`), then SIGKILL after 5s grace
- `detached: true` ensures `process.kill(-pid, signal)` targets the child's own process group, not the worker's. Without this, `-pid` would signal the worker's process group (the entire Node.js process)

**Child process resource limits:**
- `maxBuffer: 1MB` (configurable) — prevents stdout/stderr memory exhaustion
- `timeout: safetyCeiling` — safety net for hung processes
- OS-level limits should be set at the container/systemd level (`LimitNOFILE`, `LimitAS`, `MemoryMax`) rather than per-spawn, since `child_process.execFile` does not support `rlimit` natively. The deployment guide (§8) MUST document recommended systemd/container limits:
  - `LimitNOFILE=4096` — file descriptor ceiling
  - `MemoryMax=2G` — total process memory (Node + workers + children)
  - `TasksMax=256` — process/thread count ceiling
- The health endpoint (§6.1) SHOULD expose child process count for monitoring. If child count exceeds a threshold (default: 50), log a warning

### 3.3 ToolSandbox Changes (`src/agent/sandbox.ts`)

**Current signature (line 235):**
```typescript
execute(rawCommand: string): SandboxResult
```

**New signature:**
```typescript
async execute(rawCommand: string): Promise<SandboxResult>
```

**Changes to the 9-stage pipeline:**

| Stage | Line | Current | Change |
|-------|------|---------|--------|
| 1. Gate check | 237 | Sync | No change |
| 2. Tokenize | 250 | Sync | No change |
| 3. Policy lookup | 253 | Sync | No change |
| 4. Subcommand validation | 267 | Sync | No change |
| 5. Denied flags | 294 | Sync | No change |
| 6. Jail validation | 315 | Sync | No change |
| 7. Audit log (pre) | 325 | Sync append | No change |
| 8. **Execute** | 344-386 | `execFileSync` | **→ `await pool.exec(spec, "interactive")`** |
| 9. Redact | 390-401 | Sync redact | No change (operates on result from worker) |

**New steps inserted between 6 and 8:**

| New Step | Purpose |
|----------|---------|
| 6a. Resolve binary path | `realpath(which(policy.binary))` — absolute path, not just command name |
| 6b. Resolve cwd | `realpath(this.config.jailRoot)` — ensures no symlink TOCTOU |
| 6c. Build sanitized env | `{ PATH, HOME, LANG }` + config allowlist — no secrets |
| 6d. Build ExecSpec | Immutable object with all resolved values |

**Constructor change:** accepts `WorkerPool` instance via dependency injection.

```typescript
constructor(
  config: SandboxConfig,
  auditLog: AuditLog,
  pool: WorkerPool,  // NEW
)
```

### 3.4 GitSync Changes (`src/persistence/git-sync.ts`)

**Current helpers (lines 234-248):**
```typescript
private git(...args: string[]): string {
  return execFileSync("git", args, { cwd: this.repoRoot, encoding: "utf-8", timeout: 30_000 }).trim()
}
```

**New helpers:**
```typescript
private async git(...args: string[]): Promise<string> {
  const result = await this.pool.exec({
    binaryPath: this.gitBinaryPath,  // resolved once at construction
    args,
    cwd: this.repoRoot,
    timeoutMs: 30_000,
    env: this.sanitizedEnv,
    maxBuffer: 1_048_576,
  }, "system")  // ← system lane: uses reserved emergency worker
  return result.stdout.trim()
}
```

**Constructor change:** accepts `WorkerPool` instance. Resolves `gitBinaryPath` once via `which("git")` + `realpath`.

All callers (`snapshot()`, `push()`, `restore()`) are already `async` — no interface changes needed upstream.

### 3.5 Session Integration (`src/agent/session.ts`)

**Current bash tool wrapper (lines 59-74):**
```typescript
exec: async (command, _cwd, options) => {
  const result = sandbox.execute(command)  // sync!
  options.onData(Buffer.from(result.stdout))
  return { exitCode: result.exitCode }
}
```

**New bash tool wrapper:**
```typescript
exec: async (command, _cwd, options) => {
  const result = await sandbox.execute(command)  // truly async now
  options.onData(Buffer.from(result.stdout))
  return { exitCode: result.exitCode }
}
```

The only change is adding `await`. Pi SDK's `createBashTool` already expects an async `exec` callback.

### 3.6 Entry Point (`src/index.ts`)

```typescript
import { WorkerPool } from "./agent/worker-pool.js"

// Create singleton pool at startup
const pool = new WorkerPool({
  interactiveWorkers: Math.min(2, os.cpus().length - 1),
  workerScript: new URL("./agent/sandbox-worker.js", import.meta.url).pathname,
  shutdownDeadlineMs: 10_000,
})

// Pass to sandbox and git-sync
const sandbox = new ToolSandbox(config.sandbox, auditLog, pool)
const gitSync = new GitSync(config.gitSync, pool)

// Graceful shutdown
process.on("SIGTERM", async () => {
  await pool.shutdown()
  process.exit(0)
})
```

---

## 4. Security Design

### 4.1 Threat Model & Sandbox Boundary

**Important clarification:** The sandbox is a **policy-based command allowlisting system**, not an OS-level isolation boundary. Worker threads share the same process, UID/GID, and filesystem access as the main thread. The sandbox prevents:

- Execution of non-allowlisted binaries
- Shell injection (no shell, array args only)
- Path traversal outside jail root
- Secret leakage via environment variables
- Unredacted secret leakage via output

The sandbox does **NOT** prevent:
- Network access by executed binaries (mitigated by allowlist — only `git`, `br`, `ls`, etc.)
- File reads within the jail by executed binaries
- CPU/memory abuse by executed binaries (mitigated by timeout + maxBuffer)

If OS-level isolation is needed in the future (seccomp, namespaces, firejail), that is a separate cycle — see PRD "Out of Scope".

| Threat | Mitigation |
|--------|-----------|
| Worker executes unvalidated command | All validation (policy, jail, flags) on main thread. Worker receives pre-validated ExecSpec only |
| TOCTOU: binary/cwd changed between validation and execution | Main thread resolves via `realpath`. Worker re-checks cwd within jail using `path.relative` (not string prefix) |
| Secret leakage via worker env | Sanitized env (allowlist: PATH, HOME, LANG only). No API keys cross thread boundary |
| Secret leakage via stdout/stderr | All output redacted on main thread before logging. Worker MUST NOT log or persist output |
| Large output DoS | `maxBuffer: 1MB` enforced in worker. Truncated with marker |
| Hung command starves pool | Main-thread authoritative timeout. Child spawned `detached:true` (own process group). Explicit group kill via `-pid` (SIGTERM → SIGKILL). Worker replacement on wedge |
| Child process resource exhaustion (FDs/memory) | OS-level limits via systemd/container (LimitNOFILE, MemoryMax, TasksMax). Health endpoint monitors child count. maxBuffer caps per-exec memory |
| Worker crash escalation | Worker exit detected via `"exit"` event. Replacement spawned. Main process unaffected |
| Pool exhaustion | Priority lanes. Reserved system worker. Production: typed WORKER_UNAVAILABLE error (no sync fallback) |
| Orphan child processes on shutdown | Process group kill (`-pid`) on abort. Bounded shutdown with hard terminate deadline |
| Stale/mismatched worker response | jobId correlation. Pool ignores messages with non-matching jobId |

### 4.2 Environment Sanitization

Workers receive a minimal env:

```typescript
function buildWorkerEnv(config: SandboxConfig): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: config.jailRoot,
    LANG: "en_US.UTF-8",
  }
  // Add explicitly allowlisted vars from config
  for (const key of config.envAllowlist ?? []) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  return env
}
```

**Explicitly excluded:** `ANTHROPIC_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `R2_*`, `BRIDGEBUILDER_*`.

### 4.3 Output Boundary

```
Worker scope                              Main thread scope
┌─────────────────────┐                  ┌─────────────────────────┐
│ execFile() →        │   postMessage    │                         │
│   stdout (≤1MB)     │ ──────────────→  │ redactor.redact(stdout) │
│   stderr (≤1MB)     │   (structured    │ redactor.redact(stderr) │
│   exitCode          │    clone)        │ auditLog.append(result) │
│   truncated flag    │                  │ return SandboxResult     │
│                     │                  │                         │
│ NO logging          │                  │ Logging allowed here    │
│ NO persistence      │                  │                         │
└─────────────────────┘                  └─────────────────────────┘
```

---

## 5. Failure Modes

### 5.1 Worker Failure Matrix

| Failure | Detection | Recovery | Impact |
|---------|-----------|----------|--------|
| Child process exits non-zero | `ExecResult.exitCode !== 0` | Return error to caller (normal flow) | None — expected behavior |
| Child process timeout | AbortController fires | Kill child, return timeout error | Job fails, agent retries |
| Worker thread crash (OOM) | `worker.on("exit", code)` | Reject pending promise, spawn replacement | One job fails, pool recovers |
| Worker thread wedge (no response) | Main-thread 10s deadline after abort | `worker.terminate()`, spawn replacement | One job fails, pool recovers |
| All interactive workers busy | Queue depth > 0 | Jobs wait in FIFO queue | Latency increases, event loop stays free |
| Pool exhaustion (queue + workers full) | Queue depth > configurable max (default: 10) | Reject with `WORKER_UNAVAILABLE` | Agent receives error, can retry |

### 5.2 Shutdown Sequence

```
SIGTERM received
  │
  ├─ pool.shutdown() called
  │   ├─ accepting = false (new jobs rejected)
  │   ├─ Queued jobs: reject all with POOL_SHUTTING_DOWN
  │   ├─ Running jobs: send abort to each worker
  │   ├─ Wait up to shutdownDeadlineMs (10s)
  │   │   ├─ Workers that finish: collected
  │   │   └─ Workers that don't: worker.terminate()
  │   └─ All workers terminated
  │
  ├─ CronService.stop()
  ├─ HTTP server close
  └─ process.exit(0)
```

### 5.3 Rollback & Emergency Modes

**Production rollback** does NOT use sync fallback. Three emergency modes:

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Fail closed** | `SANDBOX_MODE=disabled` | All tool calls return typed `SANDBOX_DISABLED` error. Server stays responsive (health, dashboard, WebSocket). Agent cannot execute commands but doesn't block event loop. |
| **Child process pool** | `SANDBOX_MODE=child_process` | Replace worker threads with a simple `execFile` (async, no workers). Loses thread pool benefits but maintains non-blocking execution. Single concurrent command per call. |
| **Dev-only sync** | `SANDBOX_SYNC_FALLBACK=true` | Falls back to main-thread `execFileSync`. **MUST NOT be set in production** — reintroduces event loop blocking. Gated behind explicit env var. Limited to 1 concurrent sync exec with circuit breaker (3 consecutive sync execs → 5s cooldown) to prevent cascading stall. |

**Recommended rollback sequence:**
1. First try `SANDBOX_MODE=child_process` (non-blocking, minimal risk)
2. If child_process also fails: `SANDBOX_MODE=disabled` (fail closed, investigate)
3. Only as absolute last resort: `SANDBOX_SYNC_FALLBACK=true` (dev/debugging only)

---

## 6. Observability

### 6.1 Health Endpoint Extension

`GET /health` response gains a `workerPool` field:

```json
{
  "status": "ok",
  "workerPool": {
    "interactive": { "active": 1, "idle": 1, "queued": 0 },
    "system": { "active": false, "queued": 0 },
    "totals": { "completed": 142, "failed": 3, "timedOut": 1, "avgExecMs": 1250 }
  }
}
```

### 6.2 Audit Log Extension

Audit log entries for worker-executed commands gain metadata:

```json
{
  "type": "sandbox_exec",
  "command": "git status",
  "worker": true,
  "lane": "interactive",
  "durationMs": 450,
  "truncated": false
}
```

### 6.3 Dashboard Integration

The existing dashboard at `src/gateway/dashboard.ts` includes pool stats in the status object returned to WebSocket clients.

---

## 7. Testing Strategy

### 7.1 Unit Tests

| Test | File | What It Verifies |
|------|------|-----------------|
| WorkerPool: basic exec | `tests/finn/worker-pool.test.ts` | Dispatch command, get result |
| WorkerPool: timeout | same | Command exceeding timeout returns error, worker recovers |
| WorkerPool: worker crash | same | Simulate worker exit, verify replacement + promise rejection |
| WorkerPool: queue ordering | same | FIFO within each lane |
| WorkerPool: lane isolation | same | System job runs even when interactive queue full |
| WorkerPool: shutdown | same | Queued rejected, running aborted, deadline enforced |
| WorkerPool: stats | same | Counters increment correctly |
| WorkerPool: max queue rejection | same | Excess jobs get WORKER_UNAVAILABLE |
| WorkerPool: abort kills child tree | same | Force timeout, assert: abort sent, child terminated (no orphan PID), worker posts `aborted`, worker returns to IDLE |
| WorkerPool: detached child cleanup | same | Spawn detached child, verify `process.kill(-pid)` signals the child group only, not the worker/main |

### 7.2 Integration Tests

| Test | File | What It Verifies |
|------|------|-----------------|
| Sandbox async | `tests/finn/sandbox.test.ts` | Existing sandbox tests pass with async execute |
| Event loop freedom | `tests/finn/worker-pool.test.ts` | Run 10s command, verify setTimeout fires during execution |
| Pi SDK compatibility | same | createBashTool with async exec, verify streaming + tool result |
| GitSync non-blocking | `tests/finn/git-sync-worker.test.ts` | git operations don't block main thread |
| Security: env sanitization | `tests/finn/worker-pool.test.ts` | Worker cannot see ANTHROPIC_API_KEY |
| Security: output truncation | same | 2MB output truncated at 1MB with marker |
| Security: cwd jail check | same | Worker rejects cwd outside jail |

### 7.3 Critical Integration Test: Pi SDK Async Compatibility

Per PRD FR-2, this test is **mandatory before merge**:

```typescript
test("async tool exec works correctly during streaming", async () => {
  // 1. Create agent session with async bash tool
  // 2. Send a message that triggers a 5s bash command
  // 3. Verify tokens continue streaming during execution
  // 4. Verify tool result is incorporated in agent response
  // 5. Verify no output is dropped
})
```

---

## 8. Migration Path

### 8.1 Backward Compatibility

- `SandboxResult` type unchanged — callers receive the same shape
- All existing sandbox tests convert to async (add `await`)
- All existing git-sync tests already async — no change
- Audit log format extended (new fields added, none removed)

### 8.2 Rollback

If worker threads cause unexpected issues in production (see §5.3 for full emergency mode details):

1. **First response**: Set `SANDBOX_MODE=child_process` — switches to async `execFile` without worker threads. Non-blocking, zero-downtime.
2. **If still failing**: Set `SANDBOX_MODE=disabled` — fail closed. Server stays responsive for investigation.
3. **Code rollback**: `git revert` the merge commit. Remove worker-pool.ts and sandbox-worker.ts. Restores original `execFileSync` path.

Do NOT use `SANDBOX_SYNC_FALLBACK=true` in production — it reintroduces the blocking failure mode under load.

---

## 9. File Map

### New Files

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `src/agent/worker-pool.ts` | ~250 | Thread pool with priority lanes |
| `src/agent/sandbox-worker.ts` | ~80 | Stateless worker entry point |
| `tests/finn/worker-pool.test.ts` | ~300 | Pool + integration tests |

### Modified Files

| File | Change | Lines Changed (est.) |
|------|--------|---------------------|
| `src/agent/sandbox.ts` | `execute()` → async, accept pool, build ExecSpec | ~40 |
| `src/agent/session.ts` | Add `await` to sandbox.execute call | ~2 |
| `src/persistence/git-sync.ts` | `git()`/`gitAt()` → async via pool, resolve binary at construction | ~20 |
| `src/index.ts` | Create WorkerPool singleton, pass to sandbox/git-sync, shutdown handler | ~15 |
| `src/gateway/dashboard.ts` | Include pool stats in health response | ~5 |
| `src/config.ts` | Add WorkerPool config fields | ~10 |
| `tests/finn/sandbox.test.ts` | Add `await` to execute calls | ~10 |

### Unchanged Files

| File | Why |
|------|-----|
| `src/agent/tools.ts` | Already uses async `execFileAsync` — no change needed |
| `src/persistence/r2-sync.ts` | AWS SDK already async |
| `src/persistence/wal.ts` | Sync fs operations are fine (append-only, flock-based, fast) |
| `src/cron/service.ts` | Already calls executor asynchronously — no change needed |
| `src/safety/secret-redactor.ts` | Used on main thread only — no change |
| `src/safety/tool-registry.ts` | MCP tool validation, orthogonal to bash sandbox |

---

## 10. Decision Record

| ID | Decision | Rationale |
|----|----------|-----------|
| SD-001 | Pool is a singleton, not per-session | Sessions share tool execution infrastructure. One pool serves all sessions. Thread creation is expensive. |
| SD-002 | Worker script is a separate file, not inline | `new Worker(filename)` is cleaner than `new Worker(code, { eval: true })`. Separate file allows independent testing. |
| SD-003 | ExecSpec is a plain object, not a class | Must survive structured clone across thread boundary. Classes lose prototypes during clone. |
| SD-004 | Jail root passed to worker as string, not object | Worker performs cheap stat-based re-check. No need for full FilesystemJail instance in worker. |
| SD-005 | WAL stays synchronous | WAL operations are append-only with flock, completing in <1ms. Moving to worker would add complexity with no measurable benefit. |
| SD-006 | git binary resolved once at GitSync construction | Avoids repeated `which` + `realpath` calls. Binary path doesn't change during runtime. |
| SD-007 | Queue max depth configurable (default: 10) | Prevents unbounded memory growth. Excess jobs fail fast with typed error. |
| SD-008 | jobId correlation on every worker message | Prevents promise mis-resolution when a worker crashes mid-job and the replacement returns a stale result. Pool ignores messages with unknown jobId. |
| SD-009 | Jail check uses `path.relative`, not string prefix | `startsWith` is defeated by path traversal (`/home/user/../etc`). `relative()` on realpath'd values produces `..` prefix iff escape occurs. |
| SD-010 | Main thread owns authoritative timeout; worker has safety ceiling only | Eliminates competing timeout races. Worker timeout is `timeoutMs * 2` — exists only to prevent infinite hangs if main thread fails to send abort. |
| SD-011 | Sandbox is policy-based allowlisting, not OS-level isolation | Sets correct security expectations. The worker thread provides non-blocking execution, not a security boundary. Defense-in-depth layers (tokenize, policy, jail, env sanitize) remain the trust anchors. |
| SD-012 | Three rollback modes: child_process → disabled → sync (dev-only) | Sync fallback under load is the original problem. Primary rollback is async `child_process.execFile`, secondary is fail-closed `disabled`, tertiary is dev-only sync with circuit breaker (max 3 concurrent, 5s hard ceiling). |
| SD-013 | Child processes spawned with `detached: true` | Required for `process.kill(-pid)` to work correctly. Without `detached`, `-pid` signals the worker's process group (the entire Node.js process). With `detached`, the child gets its own process group via `setsid`. |
| SD-014 | jobId is `crypto.randomUUID()` (RFC 4122 v4) | Cryptographically random, no coordination needed. Pool validates UUID format and match before accepting worker responses. |
| SD-015 | Resource limits at container/systemd level, not per-spawn | Node.js `child_process.execFile` doesn't support `rlimit`. Container-level `MemoryMax`, `LimitNOFILE`, `TasksMax` provide consistent enforcement. Documented in deployment guide. |
| SD-016 | Queue overflow: per-session fairness via round-robin at >50% capacity | Prevents single session from monopolizing the pool. Below 50% capacity, strict FIFO. Callers implement exponential backoff on `WORKER_UNAVAILABLE`. |
| SD-017 | Abort waits for child `close` event before posting `aborted` | Prevents race where pool marks worker idle while child process is still dying. Ensures no orphan processes. |
