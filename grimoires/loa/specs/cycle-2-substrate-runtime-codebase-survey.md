# Cycle-2 Substrate-Runtime Codebase Survey
## loa-finn Architecture for Effect-Program Construct Loading + Kafka Transport

**Date:** 2025-02-22  
**Target:** Finn substrate-construct loader + Kafka event transport  
**Goal:** Ground architecture for loading executable Effect constructs (e.g., 0xHoneyJar/construct-lore-essay-grader) from filesystem packs, executing in Finn sandboxes, and riding Kafka topics.

---

## 1. Sandbox Architecture

### What's There
- **`src/agent/sandbox.ts`** (461 lines)
  - **FilesystemJail** (§3.3): Strict path validation + symlink rejection (realpath safety)
  - **ToolSandbox** (§3.1): 8-stage execution pipeline: Gate → Tokenize → Policy → Jail → Audit → Dispatch → Redact
  - **SecretRedactor** (§3.5): Pattern-based secret masking (API keys, tokens, passwords)
  - **Command Policy**: Allowlist-based (git, br, ls, cat, wc); denied flags (e.g., `-c`, `--exec-path`); subcommand validation
  - Entry points: `execute()` async → `SandboxExecutor` dispatch (SD-013)

- **`src/agent/sandbox-executor.ts`** (123 lines)
  - Three execution modes via `SANDBOX_MODE` env var:
    - `worker`: Default, non-blocking, wired to `WorkerPool` (interactive lane)
    - `child_process`: Async fallback using `execFile` (no workers)
    - `disabled`: Fail-closed with `SANDBOX_DISABLED` error
  - **WorkerExecutor** → pool.exec(spec, "interactive")
  - **ChildProcessExecutor** → execFile with timeout/maxBuffer handling
  - **DisabledExecutor** → throws PoolError

- **`src/agent/sandbox-worker.ts`**
  - Worker thread script (instantiated at test time; .mjs mirror in tests/finn/sandbox.test.ts)
  - Handles `{type:"exec", jobId, spec, jailRoot}` messages from parent
  - Posts back `{type:"result", jobId, result: {stdout, stderr, exitCode, truncated, durationMs}}`
  - Jail validation: cwdReal must resolve within jailReal (prevents escape)
  - Truncation marker on maxBuffer overflow

- **`src/agent/worker-pool.ts`** (300+ lines)
  - **Lane architecture**: interactive (2 workers, short-lived) vs system (1 worker, reserved)
  - **WorkerPool.exec(spec, lane, jailRoot)**: Dispatches to lane queue or idle worker
  - **Fairness (SD-016)**: Per-session round-robin at >50% capacity
  - **ExecSpec**: {binaryPath, args, cwd, timeoutMs, env, maxBuffer, sessionId?}
  - **ExecResult**: {stdout, stderr, exitCode, truncated, durationMs}
  - **Error codes**: WORKER_UNAVAILABLE, POOL_SHUTTING_DOWN, SANDBOX_DISABLED, EXEC_TIMEOUT, WORKER_CRASHED
  - Stats tracking: completed, failed, timedOut, avgExecMs

- **`src/agent/session.ts`** (100+ lines)
  - **createLoaSession()**: Factory that wires executor → ToolSandbox → Pi SDK tools
  - Jail-wrapped file tools (Read/Write/Edit) validate paths against jail
  - Sandboxed bash tool invokes sandbox.execute() + streams stdout/stderr to Pi SDK
  - Resource loader injects BEAUVOIR.md system prompt + NOTES.md learnings
  - SessionManager (Pi SDK) persists chat history per sessionId

- **`src/agent/identity.ts`**
  - Loa identity injection (referenced in session.ts)

### Public Surface
- `ToolSandbox.execute(commandString)` → Promise<SandboxResult>
- `WorkerPool.exec(spec, lane?, jailRoot?)` → Promise<ExecResult>
- `createLoaSession(options)` → Promise<{session: AgentSession, sessionId: string}>
- `FilesystemJail.validatePath(inputPath)` → string (canonical path or throws SandboxError)

### Boundaries & Enablement
- **Hounfour boundary**: None (sandbox is self-contained tool execution, orthogonal to model routing)
- **Kafka boundary**: None yet (events emitted by router, not sandbox)
- **Enables for substrate-construct loader**:
  - **Path jail** for loading constructs from `.claude/constructs/packs/` safely
  - **Tool isolation** for spawning Effect-program subprocesses inside sandbox
  - **Session lifecycle** for per-construct execution context (isolation boundary)

---

## 2. Hounfour Invocation (CompletionRequest → CompletionResult)

### What's There
- **`src/hounfour/cheval-invoker.ts`** (150+ lines)
  - **ChevalInvoker**: Subprocess wrapper for `cheval.py` (Python multi-provider adapter)
  - **Request signing**: HMAC (nonce + issuedAt + traceId), canonicalJsonStringify() matches Python
  - **Dispatch**: writes temp JSON (0600 mode) → spawn python3 cheval.py → parse stdout JSON
  - **Return**: CompletionResult {content, usage, model, stop_reason}
  - Environment scoped: PATH, CHEVAL_HMAC_SECRET, provider API keys injected per-request

- **`src/hounfour/router.ts`** (250+ lines)
  - **HounfourRouter**: Central orchestrator for CompletionRequest → CompletionResult
  - **Options**: ProviderRegistry, BudgetEnforcer, HealthProber, ChevalInvoker, PoolRegistry, BYOKProxy, BillingFinalizeClient, KnowledgeRegistry
  - **Invoke flow**:
    1. Validate context (model capabilities, budget)
    2. Resolve pool (tier-based authorization via JWT claims)
    3. Select model (pool fallback chain, affinity ranking via archetype signals)
    4. Tool-call loop (up to 20 iterations, max 50 tool calls, abort on 3 consecutive failures)
    5. Budget check per iteration (fail-closed if exhausted)
    6. Finalize billing (S2S JWT to arrakis if enabled)
  - **Know**: systemPrompt injection, persona loader, knowledge enrichment (Cycle 025)

- **`src/hounfour/pool-registry.ts`** (120+ lines)
  - **PoolRegistry**: Canonical mapping pool ID → {provider, model, fallback, capabilities, tierAccess}
  - **DEFAULT_POOLS**: cheap (Qwen local), fast-code (Qwen Coder), reviewer (GPT-4o), reasoning (o3), architect (Claude Opus 4.6)
  - **Validation**: circular fallback detection, tier enforcement
  - **Integration**: isValidPoolId() from loa-hounfour (external authority)

- **`src/hounfour/sidecar-manager.ts`** (100+ lines)
  - **SidecarManager**: Lifecycle for HTTP sidecar (Python uvicorn server)
  - **Spawn**: python3 -m uvicorn adapters.cheval_server:app --host 127.0.0.1 --port 3001
  - **Health check**: GET /healthz polling every 500ms until 200 or timeout
  - **Auto-restart**: exponential backoff (1s initial, 30s max, 2x multiplier)
  - **State**: stopped → starting → running → stopping

- **`src/hounfour/sidecar-client.ts`**
  - HTTP client for sidecar; HMAC-signed requests (doctrine §11)

- **`src/hounfour/hmac.ts`**
  - signRequestLegacy(), generateNonce()
  - Canonical JSON serialization (sort_keys=True, separators=(",",":"))

- **`src/hounfour/ensemble.ts`** (150+ lines, T-B.3)
  - Runs same prompt vs N models in parallel
  - Merge strategies: first_complete, best_of_n (ScorerFunction), consensus
  - Budget enforcement: per-model cap + total ensemble cap
  - AbortController hierarchy (parent → child per model)

- **`src/hounfour/quality-gate-scorer.ts`** (F9, T-31.3)
  - Scores ensemble candidates by running quality-gates.sh pipeline
  - Score = gates_passed / gates_total; gate failure → 0.0 (no throw)

- **Brief references**:
  - `billing.ts`: cost attribution, conservation guard
  - `jwt-auth.ts`: TenantContext extraction, tier validation
  - `knowledge-enricher.ts` (Cycle 025): injects Oracle sources into system prompt

### Public Surface
- `HounfourRouter.invoke(request: CompletionRequest, context: ExecutionContext, options?: InvokeOptions)` → Promise<CompletionResult>
- `PoolRegistry.get(poolId)` → PoolDefinition | undefined
- `ChevalInvoker.invoke(request: ChevalRequest)` → Promise<CompletionResult>
- `SidecarManager.start()`, `.stop()`, `.status()` for Phase 3+ HTTP adapter

### Boundaries & Enablement
- **Sandbox boundary**: Router is post-sandbox (sandbox provides tool results; router invokes models on those results)
- **Kafka boundary**: Routing quality signals (per personality/pool) emitted to `STREAM_ROUTING_QUALITY` (§3.1 routing-quality.ts)
- **Enables for substrate-construct loader**:
  - **Pool registry** is plugpoint for construct-specific model pools (custom pool IDs)
  - **Knowledge enrichment** can include construct documentation/examples
  - **Billing finalize** can track construct-program cost attribution separately
  - **Tool-call loop** is where constructs would be invoked as tool definitions

---

## 3. Existing Construct Loading Patterns

### What's There
- **No explicit "construct loader"** in src/hounfour/ or src/agent/
- **Similar patterns** that do dynamic resource loading:
  - **`src/agent/resource-loader.ts`**: Injects BEAUVOIR.md + NOTES.md via DefaultResourceLoader (Pi SDK extension point)
  - **`src/nft/static-personality-loader.ts`**: Loads personalities.json from `config/` directory, validates schema
  - **`src/hounfour/knowledge-loader.ts`** (Cycle 025): Loads Oracle sources from file paths
  - **`src/hounfour/persona-loader.ts`**: loadPersona() from filesystem (invoked in router.ts tool-call loop)
  - **`.claude/skills/autonomous-agent/construct.yaml`**: Example construct metadata (exists in .claude/skills/)

### Config Schema
- **`.loa.config.yaml`** (1700+ lines):
  - Registry integration (lines 273-293): endpoint URL, license validation, offline grace period
  - Skills configuration (lines 1382-1420): deferred loading toggles, per-skill categories
  - **No construct-specific config** (would be Phase 2+)

- **`src/config.ts`**:
  - `oracle.sourcesConfigPath` (Cycle 025 integration)
  - `personalityConfigPath` (Sprint 4)
  - **No construct-pack-dir** (would be added in substrate-construct loader)

### JWT License Awareness
- **`src/hounfour/jwt-auth.ts`**: Validates JWT claims (tier, scopes, rate limits)
- **`.loa.config.yaml` line 285**: `validate_licenses: false` (with note: "Disabled for sk_test_ keys")
- Doctrine §11 (HMAC-signed credentials + tier-based authorization) already patterns the way constructs should be validated

### Enables for substrate-construct loader
- **Resource loader pattern** shows how to inject construct metadata into system prompts
- **Personality loader** shows how to scan filesystem packs (personalities.json → static file read)
- **JWT validation** is ready for construct license checking (no additional work)

---

## 4. Kafka / Event Bus

### What's There
- **No Kafka client** in package.json (kafkajs, node-rdkafka absent)
- **Custom EventStore architecture** (src/events/):
  - **`src/events/types.ts`**: EventEnvelope (universal event container), EventStream (branded type)
  - **Registered streams** (pre-registered in types.ts):
    - STREAM_BILLING (billing events)
    - STREAM_CREDIT (credit journal)
    - STREAM_RECONCILIATION (reconciliation audit)
    - STREAM_PERSONALITY (personality versions)
    - STREAM_ROUTING_QUALITY (quality signals for pool affinity — Sprint 3, GID 123)
  - **EventEnvelope fields**: event_id (ULID), stream (branded), event_type (app-level), timestamp, correlation_id, sequence, checksum (CRC32), schema_version, payload

- **Backend writers/readers**:
  - **`src/events/jsonl-writer.ts`**: Append-only JSONL file backend (local development)
  - **`src/events/pg-writer.ts`**: PostgreSQL backend (production)
  - **`src/events/jsonl-reader.ts`, `pg-reader.ts`**: Replay from cursor (sequence-based)

- **Event emission in production**:
  - **`src/nft/routing-quality.ts`** (Sprint 3, GID 123): RoutingQualityEvent emitted to STREAM_ROUTING_QUALITY
  - Dual-index (personality_id, pool_id) for O(1) quality lookups
  - In-memory LRU cache (max 1000, TTL 5 min) + exponential decay aggregation

- **Billing event stream** (src/billing/):
  - WAL (write-ahead log) events: BillingWALEnvelope → EventEnvelope conversion (§4.4)

### DomainEvent Routing Convention
- Not yet explicit in loa-finn (this is loa-hounfour doctrine §11 convention)
- Pattern expected: `{aggregate}.{noun}.{verb}` (e.g., `construct.execution.completed`)
- Implementation ready: EventStream + event_type fields support this

### Public Surface
- `EventWriter.append(envelope: EventEnvelope)` → Promise<void>
- `EventReader.replay(cursor: EventCursor)` → AsyncIterable<EventEnvelope>
- `registerEventStream(name)` → EventStream
- `computePayloadChecksum(payload)` → string

### Boundaries & Enablement
- **Current**: EventStore is append-only audit trail + quality feedback (no pub/sub yet)
- **Kafka integration**: Would wire EventWriter → KafkaProducer on custom topics (e.g., `construct.execution.*`)
- **Enables for substrate-construct loader**:
  - **Event envelope** can carry construct execution metadata (effect_result, latency, cost)
  - **Stream registration** allows `STREAM_CONSTRUCT_EXECUTION` or per-construct topics
  - **Quality signals** can feed into construct performance ranking (similar to routing-quality)

---

## 5. Effect-TS Usage in loa-finn

### Current State
- **No Effect imports** found in src/hounfour/, src/agent/, src/nft/
- **Promise-based** throughout (async/await, Promise<T> type signatures)
- **Pi SDK** (from @mariozechner/pi-*) provides Agent abstraction, not Effect

### Enabling for Effect-Program Constructs
- **Construct entry points** would be Effect.Effect<A, E, R> (pure, typed error handling, requirements)
- **Sandbox execution** would need Effect runtime integration:
  - Option A: Wrap Effect.run() inside sandbox.execute() (subprocess isolation)
  - Option B: Use Effect's standard library for file I/O, HTTP calls (avoid node:fs/node:http directly)
  - Option C: Layer Effect on top of existing Promise-based ToolSandbox (bridge pattern)
- **Cost estimation**: Moderate. Effect imports only needed in construct-loader module + wrapper for Effect.run().

### No existing Effect usage = minimal migration cost
- Constructs can be Effect-pure; Finn runtime stays Promise-based
- Marshalling layer (Effect → Promise) at substrate-construct-loader boundary

---

## 6. Sprint-124-125: "Adaptive Intelligence — Quality Governance" + Sprint-123: "Quality Feedback Loop"

### What Was Shipped
- **Sprint 123 (GID 124)**: Quality Feedback Loop
  - Integrated routing-quality.ts event stream
  - Per-(personality, pool) quality scores fed back into pool selection affinity
  - Exponential decay aggregation (half-life configurable, default 5 min)

- **Sprint 124-125 (GID 125)**: Quality Governance + Adaptive Routing
  - Dual-index for O(1) quality lookups (personality_id, pool_id)
  - In-memory LRU cache (1000 keys, 5 min TTL)
  - Integration with routing-affinity for dynamic pool ranking
  - Quality signals: user_satisfaction, coherence_score, safety_pass, challenge_rate, task_completion, response_depth

### Overlaps with Substrate-Construct Routing
- **Quality governance** can rank constructs by effectiveness (task_completion signal)
- **Pool affinity** can prefer fast/accurate construct pools (new quality dimension)
- **Signal types** extensible: could add `construct_execution_success`, `construct_latency_ms`, `construct_cost_efficiency`
- **NOT overlapping**: No substrate-construct routing config in quality-gate-scorer.ts yet (opportunity for Phase 2)

---

## 7. Worker Pool Lanes: Interactive vs System

### What's There (src/agent/worker-pool.ts)
- **Interactive lane** (2 workers by default, configurable):
  - User-facing short-lived tool calls
  - Round-robin fairness at >50% capacity (per-session)
  - Fast path for responsiveness
  
- **System lane** (1 worker, reserved):
  - Low-priority background work (scheduled syncs, cleanup, audits)
  - Single queue to prevent interference with interactive requests
  - Backoff handling (WORKER_UNAVAILABLE when queue full)

### For Substrate-Constructs
- **Interactive lane**: Default for user-triggered construct invocation (e.g., "run this essay grader")
- **System lane**: Optional for construct setup/teardown, long-running training (if applicable)
- **Lane selection** in ToolSandbox: Currently hardcoded to interactive in sandbox-executor.ts WorkerExecutor (line 26)
  - **Enablement**: Add `lane?: PoolLane` parameter to ExecSpec for substrate-constructs to opt into system lane

---

## 8. Tests for Sandbox + Hounfour

### Sandbox Tests
- **`tests/finn/sandbox.test.ts`** (100+ lines)
  - Creates real .mjs worker script at test time
  - Tests FilesystemJail.validatePath() (symlink rejection, jail escape prevention)
  - Tests SecretRedactor (API key masking)
  - Tests ToolSandbox.execute() via WorkerPool dispatch
  - Uses vitest + assert/strict (no Effect.Test)

### Hounfour Tests
- **`tests/nft/quality-tracker.test.ts`**: Quality event aggregation, LRU cache, decay scoring
- **`tests/nft/routing-quality.test.ts`**: RoutingQualityEvent append/replay, archetype governance
- **`tests/nft/experience-accumulator.test.ts`**: Experience metric accumulation (signal integration)
- **Pattern**: vitest + fast-check (property-based testing), no Effect.TestClock

### Test Pattern Summary
- **Mock-first**: sandbox tests mock worker.ts; hounfour tests use in-memory EventStore backends
- **No Effect runtime testing**: Tests run synchronous assertions; async code uses Promise<T>
- **Vitest standard**: Uses vitest describe/it/expect, not Zod validators (uses TypeBox for schemas)

---

## 9. construct.yaml Awareness in loa-finn

### Current Usage
- **`.claude/skills/autonomous-agent/construct.yaml`**: Example construct metadata file
  - Located in .claude/skills/, not .claude/constructs/packs/
  - Format: YAML key-value metadata (name, description, version, etc.)
  - **No consumption** by Finn runtime (purely documentation at this stage)

### Where It Would Be Consumed
- **Substrate-construct-loader** (Phase 2):
  - Scan `.claude/constructs/packs/*/construct.yaml`
  - Extract: name, version, entry_point, effect_signature, cost_estimate, license (JWT)
  - Validate against JSON schema (typeBox schema in .claude/schemas/)
  - Register with pool-registry (if applicable) or direct tool definition

### Current Config Readiness
- **`.loa.config.yaml`**: No construct-pack-dir or construct-discovery section (would be added)
- **JSON Schema support**: `.loa.config.yaml` line 310-326 mentions structured_outputs + schemas/
  - Could add `.claude/schemas/construct.schema.json` for validation

---

## 10. Existing Config Schema & Environment Variables

### Config File Locations
- **`.loa.config.yaml`** (root): Primary config; Loa framework conventions (registry, learnings, oracle)
- **`src/config.ts`**: FinnConfig interface; environment variable mapping
- **`config/personalities.json`**: NFT personality metadata (loaded by static-personality-loader.ts)

### FinnConfig Keys (src/config.ts, lines 1-150)
- Model & Thinking: model, thinkingLevel, beauvoirPath
- Gateway: port, host
- Persistence: dataDir, sessionDir, r2 (S3-compatible), git (commit/push)
- Auth: bearerToken, corsOrigins, rateLimiting
- Scheduler: syncIntervalMs, gitSyncIntervalMs, healthIntervalMs
- **Sandbox**: allowBash, jailRoot, execTimeout, maxOutput
- **Worker Pool** (Cycle 005): interactiveWorkers, shutdownDeadlineMs, maxQueueDepth
- Sandbox Mode: "worker" | "child_process" | "disabled"
- Cheval Mode: "subprocess" | "sidecar"
- x402, apiKeys, siwe, personalityConfigPath
- postgres, redis, pools.configPath, s2s, oracle

### Environment Variable Conventions
- `FINN_*` prefix: Core Finn config (e.g., FINN_ALLOW_BASH, FINN_QUALITY_INDEX_ENABLED)
- `SANDBOX_MODE`: Executor mode ("worker", "child_process", "disabled")
- `CHEVAL_HMAC_SECRET`: Sidecar HMAC signing
- `LOA_REGISTRY_URL`: Registry API endpoint
- No explicit `CONSTRUCT_PACK_DIR` yet (opportunity for substrate-construct-loader)

### Where Substrate-Construct Config Would Live
- **Option A** (preferred): `.loa.config.yaml` new section:
  ```yaml
  substrate_constructs:
    pack_dir: .claude/constructs/packs/
    enable_effect_runtime: true
    kafka_topic_prefix: construct.execution
    cost_cap_per_execution_cents: 100
  ```
- **Option B**: `src/config.ts` FinnConfig.substrate_constructs: {...}
- **Option C**: Environment variables (SUBSTRATE_CONSTRUCT_PACK_DIR, etc.)

---

## Summary: 5 Most Load-Bearing Findings for Substrate-Construct Architecture

1. **Sandbox + Worker Pool isolation is ready** — ToolSandbox.execute() dispatches to WorkerPool (interactive/system lanes); FilesystemJail prevents escape; path validation via realpath + symlink rejection. Substrate-constructs can run safely inside interactive lane with session isolation + per-construct jailRoot.

2. **Hounfour routing layer is orthogonal but extendable** — CompletionRequest → PoolRegistry → Model invocation is decoupled from tool execution. Construct-specific pools (e.g., construct-lore-essay-grader with lower latency SLA) can be registered in PoolRegistry; billing finalize tracks construct cost attribution separately via S2S JWT to arrakis.

3. **EventStore + RoutingQuality streams already emit feedback signals** — Quality signals (user_satisfaction, coherence_score, challenge_rate, task_completion, response_depth) are persisted to STREAM_ROUTING_QUALITY. Substrate-constructs can emit similar signals (construct_execution_success, construct_latency_ms, cost_efficiency) to a new STREAM_CONSTRUCT_EXECUTION for adaptive ranking.

4. **No Kafka client yet; custom append-only architecture is foundation** — EventStore uses JSONL/PostgreSQL backends, not Kafka. EventEnvelope + EventStream branded types are ready for topic routing. Kafka transport would be an adapter (KafkaEventWriter) that bridges EventWriter interface to Kafka producer; three-segment topic convention (construct.execution.completed) aligns with doctrine §11.

5. **Effect-TS is orthogonal; Finn is Promise-based** — No Effect imports in Finn runtime. Constructs are pure Effect.Effect<A, E, R> programs; substrate-construct-loader marshals them to Promise via Effect.runSync/runPromise() at boundaries. Cost: Minimal (Effect only in construct-loader module + wrapper, not entire Finn runtime).

---

## Recommended Next Steps (Cycle-2 Kickoff)

1. **Create substrate-construct-loader module** (`src/agent/substrate-construct-loader.ts`)
   - Scan `.claude/constructs/packs/*/construct.yaml`
   - Parse + validate construct metadata (JSON Schema)
   - Register as ToolSandbox "policies" or direct Hounfour tool definitions
   - Inject Effect.run() wrapper for construct entry points

2. **Extend config schema** (`.loa.config.yaml` + `src/config.ts`)
   - Add substrate_constructs section with pack_dir, effect_runtime flag, kafka_topic_prefix
   - Add SUBSTRATE_CONSTRUCT_PACK_DIR environment variable

3. **Register STREAM_CONSTRUCT_EXECUTION** (src/events/types.ts)
   - New event stream for construct execution lifecycle
   - Signal types: {construct_id, execution_id, status, latency_ms, cost_cents, quality_signals}

4. **Sketch Kafka adapter** (src/events/kafka-writer.ts)
   - KafkaEventWriter implements EventWriter interface
   - Marshals EventEnvelope → Kafka message with topic = `{stream}.{event_type}`
   - No immediate implementation; document interface + integration points

5. **Add test fixtures** (tests/finn/substrate-construct-loader.test.ts)
   - Mock construct.yaml pack structure
   - Test path jail validation + construct discovery
   - Test Effect.run() marshalling in ToolSandbox context

