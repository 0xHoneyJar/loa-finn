# Sprint Plan: Worker Thread Sandbox

> **Cycle**: 005 — Worker Thread Sandbox
> **PRD**: `grimoires/loa/prd-worker-thread-sandbox.md`
> **SDD**: `grimoires/loa/sdd-worker-thread-sandbox.md`
> **Issue**: [#28 — pi rust port](https://github.com/0xHoneyJar/loa-finn/issues/28)
> **Developer**: @janitooor (solo)

---

## Sprint Overview

| Sprint | Label | Goal | Tasks |
|--------|-------|------|-------|
| sprint-1 | Worker Pool Foundation | Build WorkerPool, sandbox-worker, convert sandbox.execute() to async, rollback modes | 10 |
| sprint-2 | System Integration | Convert GitSync, wire entry point, add observability, validate Pi SDK, perf harness | 8 |

**Total tasks**: 18
**Branch**: `feature/worker-thread-sandbox`

---

## Sprint 1: Worker Pool Foundation

**Goal**: Create the WorkerPool and sandbox-worker modules, convert `ToolSandbox.execute()` from sync to async, and verify the event loop is unblocked during tool execution.

**Depends on**: Nothing (greenfield modules)

### Task 1.1: Define ExecSpec/ExecResult types and WorkerPoolConfig

**Description**: Create `src/agent/worker-pool.ts` with the type definitions from SDD §3.1. Export `ExecSpec`, `ExecResult`, `PoolLane`, `WorkerPoolConfig`, `WorkerPoolStats`. No runtime code yet — types only.

**Acceptance Criteria**:
- [ ] Types match SDD §3.1 exactly
- [ ] `ExecSpec` includes: binaryPath, args, cwd, timeoutMs, env, maxBuffer, sessionId (for fairness scheduling per SD-016)
- [ ] `ExecResult` includes: stdout, stderr, exitCode, truncated, durationMs
- [ ] Error code enum: `WORKER_UNAVAILABLE`, `POOL_SHUTTING_DOWN`, `SANDBOX_DISABLED`, `EXEC_TIMEOUT`, `WORKER_CRASHED` — each with retry semantics documented
- [ ] File compiles with zero errors

**File**: `src/agent/worker-pool.ts` (new)

---

### Task 1.2: Implement sandbox-worker.ts

**Description**: Create `src/agent/sandbox-worker.ts` per SDD §3.2. Stateless worker that listens on `parentPort` for `exec`/`abort` messages, spawns child processes with `detached: true`, implements `validateCwd()` using `path.relative`, and posts `result`/`aborted` with jobId correlation.

**Acceptance Criteria**:
- [ ] Worker listens for `exec` and `abort` message types
- [ ] Every message includes `jobId` for correlation
- [ ] `validateCwd()` uses `realpath()` + `path.relative()` to detect jail escapes
- [ ] Child process spawned with `detached: true` for correct process group kill
- [ ] On abort: SIGTERM to `-pid`, SIGKILL after 5s, waits for `close` event before posting `aborted`
- [ ] Platform note: `detached:true` uses `setsid` on Linux/macOS. On Windows (not a deployment target), `detached` creates a new console. Document this in code comments and skip `-pid` kill on Windows (use `child.kill()` instead)
- [ ] Safety ceiling timeout set to `timeoutMs * 2`
- [ ] Worker does NOT log or persist command output
- [ ] Output truncation enforced: if stdout+stderr exceeds `maxBuffer`, truncate with `[TRUNCATED at 1MB]` marker and set `truncated: true` in ExecResult
- [ ] Worker never posts payloads exceeding `maxBuffer` cap via `postMessage`

**File**: `src/agent/sandbox-worker.ts` (new)
**Depends on**: Task 1.1 (types)

---

### Task 1.3: Implement WorkerPool core — spawn, dispatch, lifecycle

**Description**: Implement the `WorkerPool` class in `src/agent/worker-pool.ts`. Constructor spawns N interactive workers + 1 system worker. `exec(spec, lane?)` dispatches jobs with `crypto.randomUUID()` jobIds. Handle worker message routing, crash detection, and automatic replacement.

**Acceptance Criteria**:
- [ ] Constructor spawns `interactiveWorkers` + 1 system worker
- [ ] Workers created with `resourceLimits: { maxOldGenerationSizeMb: 256 }` to prevent single runaway tool from OOMing the host process
- [ ] `exec(spec, lane?)` returns `Promise<ExecResult>`, defaults to `interactive` lane
- [ ] jobId generated via `crypto.randomUUID()` per SD-014
- [ ] Pool validates jobId match on incoming worker messages, discards mismatches
- [ ] Worker crash (`exit` event) rejects pending promise and spawns replacement
- [ ] Worker `error` event handled
- [ ] All pool errors use typed error codes from the enum defined in Task 1.1

**File**: `src/agent/worker-pool.ts`
**Depends on**: Task 1.2 (worker script)

---

### Task 1.4: Implement WorkerPool timeout and abort

**Description**: Add main-thread authoritative timeout per SDD §3.1. On expiry: send `abort` to worker, wait 10s for `aborted` response, then `worker.terminate()` + spawn replacement if no response.

**Acceptance Criteria**:
- [ ] Main thread sets per-job timer based on `spec.timeoutMs`
- [ ] On timeout: sends `{ type: "abort", jobId }` to worker
- [ ] If worker posts `aborted` within 10s: mark worker idle, reject promise with timeout error
- [ ] If no response in 10s: `worker.terminate()`, spawn replacement, reject promise
- [ ] Timeout error includes original command context for debugging

**File**: `src/agent/worker-pool.ts`
**Depends on**: Task 1.3

---

### Task 1.5: Implement WorkerPool queue, overflow, and shutdown

**Description**: Add FIFO queue per lane with configurable max depth (default: 10). Implement per-session fairness at >50% capacity (SD-016). Implement `pool.shutdown()` per SDD §5.2. Implement `pool.stats()` per SDD §3.1.

**Acceptance Criteria**:
- [ ] Jobs queue when all workers in lane are busy
- [ ] Queue depth > max rejects with typed `WORKER_UNAVAILABLE` error
- [ ] Per-session round-robin dispatch when queue > 50% capacity
- [ ] `pool.shutdown()`: set accepting=false, reject queued, abort running, hard terminate after deadline
- [ ] `pool.stats()` returns `WorkerPoolStats` with correct counters
- [ ] Stats track completed, failed, timedOut, avgExecMs

**File**: `src/agent/worker-pool.ts`
**Depends on**: Task 1.4

---

### Task 1.6: Add WorkerPool config to src/config.ts

**Description**: Add `WorkerPool` configuration fields to `src/config.ts`. Support `SANDBOX_MODE` env var for rollback modes (SDD §5.3). Add `SANDBOX_SYNC_FALLBACK` for dev-only fallback.

**Acceptance Criteria**:
- [ ] Config includes: `interactiveWorkers`, `shutdownDeadlineMs`, `maxQueueDepth`
- [ ] `SANDBOX_MODE` env var: `worker` (default), `child_process`, `disabled`
- [ ] `SANDBOX_SYNC_FALLBACK` env var: `true`/`false` (default: false)
- [ ] Worker pool config has sensible defaults (2 workers, 10s shutdown, 10 queue depth)

**File**: `src/config.ts` (modified)

---

### Task 1.7: Convert ToolSandbox.execute() to async

**Description**: Modify `src/agent/sandbox.ts` per SDD §3.3. Change `execute()` to `async execute()` returning `Promise<SandboxResult>`. Add `WorkerPool` to constructor. Insert new steps 6a-6d (resolve binary path, resolve cwd, build sanitized env, build ExecSpec). Replace `execFileSync` with `await pool.exec(spec, "interactive")`.

**Acceptance Criteria**:
- [ ] `execute()` signature is `async execute(rawCommand: string): Promise<SandboxResult>`
- [ ] Constructor accepts `WorkerPool` instance via DI
- [ ] Binary path resolved via `realpath(which(policy.binary))` before dispatch
- [ ] cwd resolved via `realpath(jailRoot)` before dispatch
- [ ] Env sanitized per SDD §4.2 (`buildWorkerEnv`)
- [ ] `execFileSync` call replaced with `await pool.exec(spec, "interactive")`
- [ ] All 9 pipeline stages preserved (stages 1-7 + 9 unchanged, stage 8 async)
- [ ] `SandboxResult` shape unchanged for callers

**File**: `src/agent/sandbox.ts` (modified)
**Depends on**: Task 1.5 (pool complete)

---

### Task 1.8: WorkerPool unit tests

**Description**: Create `tests/finn/worker-pool.test.ts` with comprehensive unit tests per SDD §7.1.

**Acceptance Criteria**:
- [ ] Test: basic exec — dispatch command, get correct result
- [ ] Test: timeout — command exceeding timeout returns error, worker recovers to idle
- [ ] Test: worker crash — simulate exit, verify replacement + promise rejection
- [ ] Test: queue ordering — FIFO within each lane
- [ ] Test: lane isolation — system job runs when interactive queue full
- [ ] Test: shutdown — queued rejected, running aborted, deadline enforced
- [ ] Test: stats — counters increment correctly
- [ ] Test: max queue rejection — excess jobs get WORKER_UNAVAILABLE
- [ ] Test: abort kills child tree — force timeout, assert child terminated, no orphan PID
- [ ] Test: detached child cleanup — verify `-pid` signals child group only
- [ ] Test: env sanitization — worker cannot see ANTHROPIC_API_KEY
- [ ] Test: output truncation — 2MB output truncated at 1MB with marker
- [ ] Test: cwd jail check — worker rejects cwd outside jail
- [ ] Test: adversarial jail escape — symlink pointing outside jail, `../` traversal, mount point edge cases — all rejected by `validateCwd`
- [ ] Test: concurrent abort+complete race — abort arrives just as child exits naturally, verify no double-resolve or unhandled rejection
- [ ] Test: shutdown during active jobs — verify all promises settle (reject), no hanging promises
- [ ] Test: rapid dispatch after crash — worker crashes, replacement spawned, next job dispatched correctly
- [ ] All tests pass

**File**: `tests/finn/worker-pool.test.ts` (new)
**Depends on**: Task 1.5 (pool complete — tests exercise pool + worker directly, not ToolSandbox)

---

### Task 1.9: Implement SandboxExecutor strategy for rollback modes

**Description**: Create a `SandboxExecutor` interface with three implementations per SDD §5.3: (a) `WorkerExecutor` — delegates to WorkerPool (default), (b) `ChildProcessExecutor` — async `execFile` directly (non-blocking, no workers), (c) `DisabledExecutor` — returns typed `SANDBOX_DISABLED` error. `ToolSandbox` receives the executor via DI. Factory selects implementation based on `SANDBOX_MODE` config.

**Acceptance Criteria**:
- [ ] `SandboxExecutor` interface with `exec(spec: ExecSpec): Promise<ExecResult>`
- [ ] `WorkerExecutor` wraps `pool.exec()` — used when `SANDBOX_MODE=worker`
- [ ] `ChildProcessExecutor` uses `execFile` directly (async, non-blocking) — used when `SANDBOX_MODE=child_process`
- [ ] `DisabledExecutor` rejects with `SANDBOX_DISABLED` error — used when `SANDBOX_MODE=disabled`
- [ ] Tests verify app boots and handles tool calls correctly in all three modes
- [ ] `SANDBOX_SYNC_FALLBACK=true` adds dev-only sync path with circuit breaker per SDD §5.3
- [ ] Operational rollback runbook documented: how to flip `SANDBOX_MODE` in production (env var on restart vs config update), verification steps after mode change (health endpoint check, test tool call), who owns the decision (operator), expected behavior per mode

**File**: `src/agent/sandbox-executor.ts` (new), `src/agent/sandbox.ts` (modified)
**Depends on**: Task 1.5 (pool), Task 1.6 (config)

---

### Task 1.10: Repo-wide call-site audit for sandbox.execute()

**Description**: Audit all callers of `sandbox.execute()` across the codebase. Update every call site to `await sandbox.execute()`. Verify `tsc --noEmit` passes with zero errors. Grep confirms no remaining sync usage patterns.

**Acceptance Criteria**:
- [ ] `grep -r 'sandbox.execute\|\.execute(' src/` shows all call sites updated to async
- [ ] `tsc --noEmit` passes with zero type errors
- [ ] Any callers beyond `session.ts` identified and updated (cron jobs, bridgebuilder, tests, etc.)
- [ ] No `sandbox.execute(` without preceding `await` in any production code

**File**: Multiple (depends on audit findings)
**Depends on**: Task 1.7 (async signature change)

---

## Sprint 2: System Integration

**Goal**: Convert GitSync to async via pool, wire the WorkerPool singleton into the entry point, add observability, update session integration, and validate Pi SDK async compatibility.

**Depends on**: Sprint 1 complete

### Task 2.1: Convert GitSync to async via pool

**Description**: Modify `src/persistence/git-sync.ts` per SDD §3.4. Change `git()` and `gitAt()` from sync to async, delegating to pool via system lane. Resolve `gitBinaryPath` once at construction.

**Acceptance Criteria**:
- [x] `git()` returns `Promise<string>`, uses `pool.exec(spec, "system")`
- [x] `gitAt()` returns `Promise<string>`, uses `pool.exec(spec, "system")`
- [x] Constructor accepts `WorkerPool` instance
- [x] `gitBinaryPath` resolved once via `which("git")` + `realpath` at construction
- [x] All callers (`snapshot()`, `push()`, `restore()`) already async — no upstream changes
- [x] Error handling preserved (throw on non-zero exit code)

**File**: `src/persistence/git-sync.ts` (modified)

---

### Task 2.2: Wire WorkerPool singleton in entry point

**Description**: Modify `src/index.ts` per SDD §3.6. Create `WorkerPool` singleton at startup, pass to `ToolSandbox` and `GitSync` constructors, add SIGTERM shutdown handler. Support `SANDBOX_MODE` config for rollback modes.

**Acceptance Criteria**:
- [x] WorkerPool created at startup with config from `src/config.ts`
- [x] Pool passed to `ToolSandbox` constructor
- [x] Pool passed to `GitSync` constructor
- [x] SIGTERM handler calls `pool.shutdown()` before exit
- [x] `SANDBOX_MODE=child_process` skips pool creation, uses direct `execFile`
- [x] `SANDBOX_MODE=disabled` skips pool, returns `SANDBOX_DISABLED` on all tool calls

**File**: `src/index.ts` (modified)

---

### Task 2.3: Update session.ts bash tool wrapper

**Description**: Modify `src/agent/session.ts` per SDD §3.5. Add `await` to the `sandbox.execute()` call in the bash tool wrapper.

**Acceptance Criteria**:
- [x] `sandbox.execute(command)` call changed to `await sandbox.execute(command)`
- [x] No other changes to session.ts
- [x] Pi SDK `createBashTool` already expects async — no interface change needed

**File**: `src/agent/session.ts` (modified)

---

### Task 2.4: Add pool stats to health endpoint and dashboard

**Description**: Modify `src/gateway/dashboard.ts` per SDD §6.1 and §6.3. Include `WorkerPoolStats` in health response and dashboard WebSocket status.

**Acceptance Criteria**:
- [x] `GET /health` response includes `workerPool` field with interactive/system/totals
- [x] Dashboard WebSocket status object includes pool stats
- [x] Health endpoint shows child process count for monitoring (SD-015)

**File**: `src/gateway/dashboard.ts` (modified)

---

### Task 2.5: Update existing sandbox tests for async

**Description**: Update `tests/finn/sandbox.test.ts` — change all `sandbox.execute()` calls to `await sandbox.execute()`. Verify all existing tests pass with the async interface.

**Acceptance Criteria**:
- [x] All existing sandbox tests converted to use `await`
- [x] No test logic changes — only sync→async adaptation
- [x] All tests pass

**File**: `tests/finn/sandbox.test.ts` (modified)

---

### Task 2.6: GitSync worker integration tests

**Description**: Create `tests/finn/git-sync-worker.test.ts` per SDD §7.2. Verify git operations run through the pool system lane without blocking the main thread.

**Acceptance Criteria**:
- [x] Test: git operations execute via system lane worker
- [x] Test: git operations don't block main thread (setTimeout fires during git exec)
- [x] Test: git error handling preserved (non-zero exit throws)
- [x] All tests pass

**File**: `tests/finn/git-sync-worker.test.ts` (new)

---

### Task 2.7: Pi SDK async compatibility integration test (MANDATORY)

**Description**: Create the critical integration test per SDD §7.3 and PRD FR-2. This test is **mandatory before merge** — it validates that Pi SDK's `createBashTool` correctly handles truly async tool execution during streaming.

**Acceptance Criteria**:
- [x] Test creates agent session with async bash tool via `createBashTool({ exec: async (cmd) => { ... } })`
- [x] Test sends a message that triggers a 5s command (`sleep 5 && echo done`)
- [x] Test instruments Pi SDK stream callback/event emitter to capture token events with timestamps
- [x] Test uses a countdown latch (not wall-clock timing) to assert: at least 3 token chunks received **after** tool invocation starts and **before** tool result returns — proving event loop was free during exec
- [x] Tool start/end detected via: (a) audit log `sandbox_exec` entry timestamp, or (b) wrapping exec callback with before/after hooks
- [x] Test verifies tool result stdout contains `done` — proving output was not dropped
- [x] Test verifies tool result is incorporated into the agent's final response
- [x] Test uses `{ timeout: 30_000 }` and deterministic barriers — no `setTimeout`-based assertions that could flake

**File**: `tests/finn/pi-sdk-async-compat.test.ts` (new)
**Priority**: P0 — merge blocker

---

### Task 2.8: Event loop freedom and keepalive perf test harness

**Description**: Implement automated performance verification per PRD §2 success metrics. Creates a test harness that runs a long tool execution and measures event loop responsiveness, scheduler tick accuracy, and WebSocket keepalive.

**Acceptance Criteria**:
- [x] Test runs a 10s `sleep` command via worker pool
- [x] During execution, samples `perf_hooks.monitorEventLoopDelay()` — asserts p99 < 50ms
- [x] During execution, fires `setInterval(100ms)` and asserts actual intervals < 200ms (scheduler jitter < 100ms)
- [x] During execution, sends WebSocket ping and asserts pong received within 1s
- [x] Test produces structured pass/fail output with measured values for CI artifacts
- [x] Test runs deterministically in CI (no external service dependencies)

**File**: `tests/finn/event-loop-freedom.test.ts` (new)

---

## Dependencies

```
Sprint 1:
  1.1 ──→ 1.2 ──→ 1.3 ──→ 1.4 ──→ 1.5 ──→ 1.8 (pool tests)
                                      │
                                      1.6 ──→ 1.9 (rollback executor)
                                      │           ↓
                                      └──→ 1.7 ──→ 1.10 (call-site audit)

Sprint 2 (all depend on Sprint 1):
  2.1 ──→ 2.6
  2.2 ──→ 2.3
  2.4
  2.5
  2.7 (Pi SDK compat — merge blocker)
  2.8 (event loop perf harness)
```

---

## Risk Mitigation

| Risk | Mitigation | Task |
|------|-----------|------|
| Pi SDK breaks with truly async exec | Integration test (Task 2.7) is merge blocker with latch-based assertions | 2.7 |
| Orphan child processes | `detached:true` + process group kill + close event wait | 1.2, 1.8 |
| Worker crash cascading | Pool auto-replaces crashed workers, tests verify | 1.3, 1.8 |
| Incorrect `-pid` kill scope | `detached:true` per SD-013, test verifies | 1.2, 1.8 |
| Sandbox security regression | All 9 pipeline stages preserved, test coverage | 1.7, 2.5 |
| GitSync timing changes | System lane isolation, integration tests | 2.1, 2.6 |
| Rollback modes don't work | SandboxExecutor strategy pattern, tested per mode | 1.9 |
| Missed call sites after async conversion | Repo-wide audit + `tsc --noEmit` gate | 1.10 |
| Can't prove success metrics met | Automated perf/keepalive test harness with pass/fail gates | 2.8 |

---

## Success Criteria (Sprint 2 Exit)

Per PRD §2 success metrics:

- [ ] Event loop blockage during tool exec: **0%** (verified via `monitorEventLoopDelay`)
- [ ] Scheduler tick jitter: **<100ms** during tool execution
- [ ] WebSocket ping/pong: **100% survival** during 10s command
- [ ] Git sync main thread impact: **0ms**
- [ ] All existing tests pass with async conversion
- [ ] All new tests pass (worker-pool, git-sync-worker, Pi SDK compat)
- [ ] No new dependencies added
