# Agent — Session & Sandbox Execution

<!-- AGENT-CONTEXT: name=agent, type=module, purpose=Agent session management with sandboxed tool execution, key_files=[src/agent/sandbox.ts, src/agent/worker-pool.ts], interfaces=[LoaSession, ToolSandbox, WorkerPool], dependencies=[@mariozechner/pi-coding-agent, @mariozechner/pi-agent-core], version=1ef38a64bfda4b35c37707c710fc9b796ada7ee5, priority_files=[src/agent/sandbox.ts, src/agent/worker-pool.ts], trust_level=low, model_hints=[code,review] -->

## Purpose

<!-- provenance: CODE-FACTUAL -->
The agent module manages LLM session lifecycle and provides sandboxed tool execution via worker threads. It bridges the Pi SDK's agent protocol with loa-finn's safety and persistence layers (`src/agent/sandbox.ts:1`).

## Key Interfaces

### LoaSession (`src/agent/session.ts`)

```typescript
interface LoaSession {
  prompt(text: string): Promise<void>
  steer(text: string): Promise<void>
  abort(): Promise<void>
  subscribe(cb: (event: AgentSessionEvent) => void): () => void
  state: "idle" | "running" | "blocked"
  isStreaming: boolean
  messages: Array<{ role, content }>
}
```

<!-- provenance: INFERRED -->
Sessions are created via `POST /api/sessions` and streamed via WebSocket at `/ws/:sessionId`.

### ToolSandbox (`src/agent/sandbox.ts`)

```typescript
class ToolSandbox {
  async execute(command: SandboxCommand): Promise<SandboxResult>
}
```

<!-- provenance: CODE-FACTUAL -->
Enforces `CommandPolicy` (`src/agent/sandbox.ts:35`) and `FilesystemJail` (`src/agent/sandbox.ts:109`) for chroot-like confinement to `FINN_SANDBOX_JAIL_ROOT`.

### WorkerPool (`src/agent/worker-pool.ts`)

```typescript
class WorkerPool {
  async exec(spec: ExecSpec, lane?: PoolLane): Promise<ExecResult>
  async shutdown(deadline?: number): Promise<void>
  getStats(): WorkerPoolStats
}
```

<!-- provenance: CODE-FACTUAL -->
**Two lanes**: `interactive` (user-facing prompt execution) and `system` (maintenance tasks) (`src/agent/worker-pool.ts:63`). Lanes run independently so system tasks never block interactive requests.

## Architecture

```
WebSocket/HTTP → LoaSession
                   │
                   ├─→ Pi SDK Agent (prompt, steer, abort)
                   │
                   ├─→ ToolSandbox (policy check)
                   │     ├─→ CommandPolicy (allowlist)
                   │     └─→ FilesystemJail (chroot)
                   │
                   └─→ WorkerPool
                         ├─→ Interactive Lane (prompt execution)
                         └─→ System Lane (maintenance)
```

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `SANDBOX_MODE` | `worker` | Execution mode (worker/child_process/disabled) |
| `FINN_ALLOW_BASH` | `false` | Enable bash execution in sandbox |
| `FINN_SANDBOX_JAIL_ROOT` | `${DATA_DIR}` | Filesystem jail root |
| `FINN_SANDBOX_TIMEOUT` | `30000` | Max execution time (ms) |
| `FINN_SANDBOX_MAX_OUTPUT` | `65536` | Max stdout/stderr buffer (bytes) |
| `FINN_WORKER_POOL_SIZE` | `2` | Worker threads (auto-tunes to CPU count) |
| `FINN_WORKER_SHUTDOWN_MS` | `10000` | Graceful shutdown deadline (ms) |
| `FINN_WORKER_QUEUE_DEPTH` | `10` | Max queued jobs per lane |

## Dependencies

<!-- provenance: DERIVED -->
- **Internal**: `src/hounfour/` (model routing — `src/index.ts:22`), `src/safety/` (audit trail, tool registry — `src/index.ts:5`)
- **External**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core` (Pi SDK)

## Known Limitations

<!-- provenance: CODE-FACTUAL -->
- Worker thread sandbox has 30s default timeout — long-running tools killed (`src/config.ts:1`)
- `SANDBOX_SYNC_FALLBACK` forbidden in production (`NODE_ENV=production`) (`src/config.ts:1`)

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:13:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
