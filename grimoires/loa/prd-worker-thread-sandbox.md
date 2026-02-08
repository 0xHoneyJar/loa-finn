# PRD: Worker Thread Sandbox — Non-Blocking Tool Execution

> **Cycle**: 005 — Worker Thread Sandbox
> **Status**: Draft
> **Author**: @janitooor
> **Date**: 2026-02-08
> **Issue**: [#28 — pi rust port](https://github.com/0xHoneyJar/loa-finn/issues/28)
> **Branch**: `feature/worker-thread-sandbox`

---

## 1. Problem Statement

loa-finn's tool execution pipeline uses `execFileSync` in `src/agent/sandbox.ts:359`, which **blocks the Node.js event loop** for the entire duration of every command execution (up to 30 seconds per tool call). This creates a cascade of failures in a long-running agent system:

| Symptom | Root Cause | Impact |
|---------|-----------|--------|
| Scheduler ticks delayed 15-30s | `execFileSync` blocks main thread | Health checks miss deadlines, cron jobs starve |
| WebSocket pings timeout | Event loop frozen during tool exec | Dashboard connections drop mid-session |
| Git sync stalls system-wide | `git-sync.ts:235,243` uses `execFileSync` | One git operation blocks all other I/O |
| No job preemption | Single-threaded execution | Runaway command starves every other scheduled task |

> **Source**: `src/agent/sandbox.ts:359` — `execFileSync(policy.binary, validatedArgs, {...})`
> **Source**: `src/agent/session.ts:61` — `sandbox.execute(command)` wrapped in async but actually synchronous
> **Source**: `src/persistence/git-sync.ts:235,243` — two `execFileSync` helpers for git operations

### Why This Matters Now

Issue #28 proposes porting to [pi_agent_rust](https://github.com/Dicklesworthstone/pi_agent_rust) for resilience, speed, and stability. Analysis of that project reveals:

- **No C FFI bindings** — no `cbindgen`, no N-API module, no way to load as `.node` addon
- **No HTTP API mode** — CLI tool only, integration requires subprocess spawning
- **QuickJS extension runtime** — limited Node.js API shims (187/223 compatibility)
- **Real bottleneck is LLM latency** — Rust startup savings (~400ms) are dwarfed by 2-10s API calls

The Rust port solves a real problem (process-level isolation, memory efficiency) but introduces significant interop complexity. **Worker threads solve the highest-impact problem (event loop blocking) with zero new dependencies and zero architectural changes.**

> *"When GitHub needed to speed up syntax highlighting, they first tried moving it to a worker pool in Node.js. When that wasn't enough, they built Tree-sitter in C (later Rust). The worker pool bought them 2 years before the rewrite was necessary."* — Issue #28 discussion

---

## 2. Goals & Success Metrics

### Primary Goal

**Unblock the Node.js event loop during tool execution** by moving `execFileSync` operations to worker threads, preserving all existing sandbox security guarantees.

### Success Metrics

| Metric | Current | Target | Method |
|--------|---------|--------|--------|
| Event loop blockage during tool exec | 100% (sync) | 0% (async via worker) | `perf_hooks.monitorEventLoopDelay()` |
| Scheduler tick jitter | 0-30s (blocked by tool exec) | <100ms | Measure actual vs expected tick intervals |
| WebSocket ping/pong survival during tool exec | Drops on long commands | 100% keepalive | Integration test: run 10s command, verify WS stays alive |
| Git sync latency impact on main thread | Blocks 1-5s per operation | 0ms main thread impact | Profile main thread during git snapshot |
| Concurrent tool execution capability | 1 (sequential, blocking) | 2-4 (worker pool) | Load test: fire 4 commands, measure wall time |

### Non-Goals

- **NOT** a Rust port or FFI integration — this is a Node.js-only solution
- **NOT** changing the sandbox security model — all policy enforcement stays
- **NOT** adding process-level isolation — worker threads share memory space
- **NOT** re-architecting the Pi SDK integration — same `createBashTool` wrapper

---

## 3. User & Stakeholder Context

### Primary User: loa-finn Runtime

loa-finn is a persistent Loa agent runtime. It runs 24/7 with concurrent responsibilities:
- **Agent sessions**: LLM-driven tool execution (bash, read, write, edit)
- **Cron scheduler**: Periodic jobs (health checks, git sync, R2 sync, stale detection)
- **Dashboard**: WebSocket connections for real-time monitoring
- **Bridgebuilder**: Autonomous PR review via cron

All of these share a single Node.js event loop. When sandbox.execute() blocks for 30 seconds, everything else freezes.

### Stakeholder: Future Rust Port Decision

This work directly informs issue #28. If worker threads solve the blocking problem and profiling confirms LLM latency dominates, the urgency of a Rust port decreases significantly. The metrics gathered here become the decision criteria:

- If worker threads + LLM latency dominance → Rust port deferred
- If memory pressure from 100+ sessions OR need for multi-provider → Rust port compelling

---

## 4. Functional Requirements

### FR-1: Worker Thread Pool

Create a `WorkerPool` class that manages a fixed pool of worker threads for command execution.

**Acceptance Criteria:**
- Pool size configurable (default: 2, max: `os.cpus().length - 1`)
- Two priority lanes: `interactive` (agent tool calls) and `system` (cron/health/git). System lane has a reserved worker that cannot be starved by interactive jobs
- Commands queued when all workers busy (per-lane FIFO)
- Each worker uses async `execFile` (not `execFileSync`) with AbortController for preemptible timeout. This allows the worker event loop to monitor for cancellation and kill child processes on deadline
- Worker crash/timeout does not crash the main process. Crashed/wedged workers are terminated and replaced automatically
- Orphan process cleanup: on worker timeout, SIGTERM the child process with 5s grace, then SIGKILL. Track child PIDs via `spawn` return value
- Shutdown policy: on SIGTERM, stop accepting new jobs, cancel all queued jobs, send SIGTERM to running child processes, hard-terminate workers after 10s deadline. No unbounded drain

### FR-2: Async Sandbox Execute

Replace `sandbox.execute()` synchronous interface with an async version that delegates to the worker pool.

**Acceptance Criteria:**
- `sandbox.execute(command)` returns `Promise<SandboxResult>` instead of `SandboxResult`
- All callers updated to await the result
- `src/agent/session.ts` bash tool wrapper becomes truly async
- Timeout enforcement preserved (30s default per command) via AbortController in the worker — child process is killed on deadline, not just the Promise
- AbortSignal support for cancellation propagated from caller → pool → worker → child process
- **Pi SDK compatibility verified**: an integration test MUST confirm that Pi's `createBashTool` correctly awaits async tool exec during streaming, retries, and error handling. Test: run a 5s command while streaming tokens, verify tool result is incorporated deterministically and no output is dropped

### FR-3: Non-Blocking Git Operations

Move `git-sync.ts` `execFileSync` operations to worker threads.

**Acceptance Criteria:**
- `git()` and `gitAt()` helpers return `Promise<string>` instead of `string`
- `snapshot()`, `push()`, `restore()` callers already async — no interface change needed
- Git operations no longer block scheduler ticks or WebSocket handlers
- Error handling preserved (throw on non-zero exit code)

### FR-4: Security Preservation

All existing sandbox security guarantees must be preserved in the worker thread model.

**Acceptance Criteria:**
- Policy lookup (binary allowlist, subcommand validation) happens on main thread BEFORE dispatch to worker
- Denied flags check happens on main thread BEFORE dispatch to worker
- Jail path validation happens on main thread BEFORE dispatch to worker
- Audit logging happens on main thread (before and after)
- Secret redaction happens on main thread after worker returns
- Worker receives an immutable execution spec: **absolute resolved binary path** (not command name), **realpath-resolved cwd** within jail, validated args array, timeout, and a sanitized env (no secrets — only PATH, HOME, LANG, and explicitly allowlisted vars)
- **TOCTOU mitigation**: main thread resolves binary path via `realpath` and validates it against the allowlist. Worker re-checks that cwd is within jail realpath (cheap stat, defense-in-depth). No filesystem state relied upon between validation and execution that could be changed by a concurrent tool call
- **Output size limits**: worker enforces `maxBuffer` (default: 1MB) on child process stdout/stderr. Output exceeding the limit is truncated with an explicit `[TRUNCATED at 1MB]` marker. This bounds structured clone overhead and prevents memory spikes from accidental binary output or `cat node_modules/...`
- Worker MUST NOT log or persist command output — all output flows to main thread for redaction before any logging
- No policy objects, no audit log references, no redactor instances cross the thread boundary

### FR-5: Observability

Expose worker pool metrics for dashboard and health checks.

**Acceptance Criteria:**
- `pool.stats()` returns: `{ active, idle, queued, completed, failed, avgExecMs }`
- Health endpoint includes worker pool status
- Audit log entries include `{ worker: true, workerId: number }` when executed via pool

---

## 5. Technical & Non-Functional Requirements

### NFR-1: Zero New Dependencies

Worker threads are built into Node.js (`node:worker_threads`). No npm packages added.

### NFR-2: Backward Compatibility

The sandbox security model, policy enforcement, audit logging, and secret redaction are unchanged. Only the execution mechanism changes from synchronous to asynchronous.

### NFR-3: Failure Isolation

A worker thread crash (OOM, segfault in child process) must not crash the main process. The pool must detect crashed workers, remove them, and spawn replacements.

### NFR-4: Memory Overhead

Each worker thread adds ~5-10MB baseline. With a pool of 2-4 workers, total overhead is 10-40MB — acceptable for a server process.

### NFR-5: Failure Mode on Worker Unavailability

If all workers are wedged or the pool cannot spawn new workers (resource exhaustion):

1. **Production (default)**: Fail the tool call with a typed `WORKER_UNAVAILABLE` error. The agent receives the error and can retry or adapt. This preserves event loop responsiveness — falling back to `execFileSync` on the main thread would reintroduce the exact blocking failure mode this project eliminates, and resource exhaustion (the trigger) is precisely when blocking is most dangerous.
2. **Development only** (`SANDBOX_SYNC_FALLBACK=true`): Fall back to main-thread `execFileSync` for local dev convenience. This flag MUST NOT be set in production deployments.
3. **Emergency worker**: A single long-lived worker is created at boot and reserved for system-priority commands (health checks, git sync). This worker is never used for interactive tool calls and provides a guaranteed execution path for recovery actions even when the interactive pool is exhausted.

---

## 6. Scope & Prioritization

### MVP (Sprint 1)

| Priority | Requirement | Rationale |
|----------|------------|-----------|
| P0 | FR-1: Worker Thread Pool | Foundation — everything else depends on this |
| P0 | FR-2: Async Sandbox Execute | Eliminates the primary blocking point |
| P0 | FR-4: Security Preservation | Non-negotiable — security cannot regress |
| P1 | FR-3: Non-Blocking Git Operations | Secondary blocking point, same pattern |
| P1 | FR-5: Observability | Needed to validate success metrics |

### Out of Scope

| Item | Why |
|------|-----|
| Process-level sandbox (seccomp, namespaces) | Different isolation model, future cycle |
| Rust port / FFI bridge | Issue #28 deferred pending worker thread results |
| Multi-provider LLM support | Unrelated to tool execution |
| Worker thread for LLM API calls | LLM calls are already async (fetch-based) |
| Session branching | Architectural change beyond this scope |

---

## 7. Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pi SDK assumes synchronous tool execution | Medium | High | Pi's `createBashTool` accepts async callbacks (verified in session.ts). **Required**: integration test confirming async tool exec works correctly during streaming, retries, and error handling (FR-2) |
| Worker wedging (hung command, git lock, stdin wait) | Medium | High | Workers use async `execFile` with AbortController for preemptible timeout. Wedged workers terminated and replaced after deadline. Child process SIGTERM→SIGKILL with 5s grace (FR-1) |
| Pool starvation under load | Medium | High | Two priority lanes (interactive + system) with reserved emergency worker. System-priority commands (health, git) cannot be starved by agent tool calls (FR-1) |
| TOCTOU between validation and execution | Low | High | Main thread resolves binary via `realpath` + validates against allowlist. Worker re-checks cwd within jail. Sanitized env passed (no secrets). No mutable filesystem state relied upon between validation and exec (FR-4) |
| Large output causing memory spikes / clone overhead | Medium | Medium | Worker enforces `maxBuffer` (1MB default) with truncation marker. Bounds structured clone overhead. Prevents accidental binary/large output from crashing pool (FR-4) |
| Secret leakage via worker diagnostics | Low | Medium | Worker MUST NOT log command output. All output flows to main thread for redaction before any persistence. Sanitized env excludes secret vars (FR-4) |
| Shared state bugs (audit log, redaction) | Medium | Medium | Keep all state mutations on main thread; workers are stateless |
| Test suite assumes synchronous execution | Medium | Medium | All sandbox tests already use async harness — just need await |
| Shutdown deadlock (hung commands during SIGTERM) | Medium | Medium | Bounded shutdown: stop accepting, cancel queued, SIGTERM children, hard-terminate workers after 10s (FR-1) |

### Dependencies

| Dependency | Status | Risk |
|-----------|--------|------|
| Node.js >= 22 | Already required (package.json engines) | None |
| `node:worker_threads` | Stable API since Node.js 12 | None |
| Pi SDK `createBashTool` | Already accepts async `exec` callback | None |

---

## 8. Architecture Overview

```
Main Thread (Event Loop)                    Worker Pool (2-4 threads)
┌───────────────────────────┐              ┌─────────────────────────┐
│ Pi Agent Session          │              │ Interactive Lane         │
│   ↓                       │              │ ┌─────────────────────┐ │
│ sandbox.execute(cmd)      │   exec spec  │ │ Worker #1           │ │
│   ├─ validate policy      │              │ │   execFile() async  │ │
│   ├─ resolve binary path ─┼────────────▶│ │   ↓ AbortController │ │
│   ├─ resolve cwd realpath │              │ │   run command       │ │
│   ├─ sanitize env         │   result     │ │   ↓ maxBuffer 1MB  │ │
│   ├─ audit log (pre)      │◀────────────┼─│   return stdout/err │ │
│   ├─ await worker result  │              │ └─────────────────────┘ │
│   ├─ redact secrets       │              │ ┌─────────────────────┐ │
│   └─ audit log (post)     │              │ │ Worker #2           │ │
│                           │              │ └─────────────────────┘ │
│ CronService tick ✓        │              ├─────────────────────────┤
│ WebSocket ping/pong ✓     │              │ System Lane (reserved)  │
│ Health checks ✓           │              │ ┌─────────────────────┐ │
│                           │              │ │ Emergency Worker    │ │
│ git-sync, health ─────────┼─────────────▶│ │ (health, git only)  │ │
│                           │              │ └─────────────────────┘ │
└───────────────────────────┘              └─────────────────────────┘
```

**Key principles**:
- Workers are stateless command executors. All security logic (policy, jail, audit, redaction) stays on the main thread
- Workers use async `execFile` (not `execFileSync`) with AbortController for preemptible timeouts
- Emergency worker reserved for system commands — never starved by interactive tool calls
- Worker receives immutable exec spec: resolved binary path, realpath cwd, sanitized env, timeout
- Output bounded at 1MB per command to prevent memory spikes and structured clone overhead

---

## 9. Decision Record

| ID | Decision | Rationale |
|----|----------|-----------|
| D-001 | Worker threads over child processes | Workers share memory space, lower overhead than forking. Async execFile in a worker doesn't block main thread. |
| D-002 | Security validation on main thread, defense-in-depth re-check in worker | Workers receive pre-validated immutable exec spec (resolved paths, sanitized env). Worker re-checks cwd-in-jail as cheap defense-in-depth. No policy objects cross the thread boundary. |
| D-003 | Fixed pool with priority lanes, not auto-scaling | Predictable memory usage. Reserved emergency worker for system commands prevents starvation. |
| D-004 | Fail with WORKER_UNAVAILABLE in production, not sync fallback | Sync fallback reintroduces the blocking failure mode under resource pressure — exactly when it's most dangerous. Agent receives typed error and can retry. Dev-only sync fallback behind explicit flag. |
| D-005 | Worker threads before Rust port | Lowest risk, highest impact. Validates whether Rust port is even necessary. |
| D-006 | Async execFile in workers, not execFileSync | execFileSync cannot be preempted by AbortSignal. Async execFile allows child process kill on timeout, preventing permanently wedged workers. |
| D-007 | Bounded output (1MB maxBuffer) in workers | Prevents memory spikes from large outputs, bounds structured clone overhead, protects pool stability. |

---

## 10. Appendix: Current Blocking Call Sites

| File | Line | Call | Timeout | Impact |
|------|------|------|---------|--------|
| `src/agent/sandbox.ts` | 359 | `execFileSync(policy.binary, validatedArgs, ...)` | 30s | **Primary** — all bash tool calls |
| `src/persistence/git-sync.ts` | 235 | `execFileSync("git", args, ...)` via `git()` helper | 30s | **Secondary** — snapshot, push |
| `src/persistence/git-sync.ts` | 243 | `execFileSync("git", args, ...)` via `gitAt()` helper | 30s | **Secondary** — restore |

### Verified Non-Blocking Patterns (No Change Needed)

| File | Pattern | Why It's Fine |
|------|---------|--------------|
| `src/agent/tools.ts:39` | `execFileAsync("br", args)` | Already async via `util.promisify(execFile)` |
| `src/agent/tools.ts:183` | `execFileAsync("br", args)` | Already async |
| `src/persistence/r2-sync.ts` | `@aws-sdk/client-s3` | AWS SDK is fully async |
| `src/gateway/server.ts` | Hono HTTP handlers | Fully async |
