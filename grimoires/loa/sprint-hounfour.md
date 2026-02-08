# Sprint Plan: The Hounfour — Multi-Model Provider Abstraction

> **Cycle**: 006
> **PRD**: `grimoires/loa/prd-hounfour.md`
> **SDD**: `grimoires/loa/sdd-hounfour.md`
> **Branch**: `feature/hounfour`
> **Team**: 1 AI engineer (Claude Code)
> **Sprint Duration**: ~1 session each

---

## Sprint Overview

| Sprint | Label | Phase | Global ID | Tasks | Focus |
|--------|-------|-------|-----------|-------|-------|
| sprint-1 | Foundation & Adapter Core | Phase 0 | 14 | 11 | cheval.py, config schema, threat model, cost ledger, model-invoke CLI |
| sprint-2 | Flatline Integration & Budget | Phase 1 | 15 | 10 | Thinking traces, budget enforcement, Flatline refactor, tool-call E2E |
| sprint-3 | Agent Portability & Health | Phase 2 | 16 | 8 | Skill decomposition, circuit breakers, fallback chains, fidelity tests |

---

## Sprint 1: Foundation & Adapter Core (Phase 0)

**Goal**: cheval.py invokes two non-Claude models. Ledger records every call. Threat model document written. Config validated against JSON Schema.

**Exit Criteria**: Threat model reviewed. Conformance fixture tests pass for ≥2 providers. One live smoke test passes when credentials available (Qwen3-Coder-Next or OpenAI gpt-4o-mini). Ledger records correct cost. Config validated against JSON Schema.

### Tasks

#### T-14.1: Threat Model Document (P0, FR-9)
**Description**: Write `grimoires/loa/security/hounfour-threat-model.md` covering all 4 trust boundaries from SDD §7.1. Include trust assertions per hop, attack surfaces, security invariants per phase, penetration test scenarios for Cheval invocation bypass, JWT specification (design-now for Phase 4), and BYOK liability model.
**Acceptance Criteria**:
- [ ] Document covers all 4 boundaries (User→Arrakis, Arrakis→loa-finn, loa-finn→cheval, cheval→Provider)
- [ ] HMAC request signing spec: algo (HMAC-SHA256), canonical JSON serialization for bytes-to-sign (sorted keys, UTF-8, no trailing whitespace), include nonce + trace_id + issued_at + body SHA-256, configurable clock skew tolerance (default 30s), signature encoding (hex), interop test (TS signs → Python verifies), negative tests for encoding differences and replay attempts
- [ ] HMAC secret lifecycle: env var source (`CHEVAL_HMAC_SECRET`), generation method (32-byte random), rotation cadence (manual for Phase 0-2), dual-secret overlap window for zero-downtime rotation, local-dev bootstrap (auto-generate if missing with warning)
- [ ] Credential validation spec: startup API key check (HEAD request or provider-specific validation), missing/invalid key error messages, env var allowlist for `{env:VAR}` interpolation, redaction rules for logs
- [ ] Penetration test scenarios for Cheval invocation bypass documented
- [ ] JWT specification for Phase 4 defined (issuer, signing algo, required claims)
**Assigned**: Claude Code
**Dependencies**: None

#### T-14.2: Provider Config JSON Schema (P0, FR-1)
**Description**: Create `schemas/provider-config.schema.json` and `schemas/cheval-request.schema.json` for config validation at load time. Schema covers providers, aliases, agents, routing, metering, pricing sections from SDD §5.1.
**Acceptance Criteria**:
- [ ] JSON Schema validates full `.loa.config.yaml` provider section
- [ ] ChevalRequest schema v1.0 for machine mode validated
- [ ] CompletionResult schema v1.0 defined at `schemas/completion-result.schema.json`
- [ ] Schema validation errors produce actionable messages
**Assigned**: Claude Code
**Dependencies**: None

#### T-14.3: ProviderRegistry (P0, SDD §4.1)
**Description**: Implement `src/hounfour/registry.ts` — immutable provider registry with alias resolution, capability checking, and binding validation.
**Acceptance Criteria**:
- [ ] `ProviderRegistry.fromConfig()` loads and validates provider config
- [ ] `resolveAlias()` resolves aliases to canonical `provider:model` pairs
- [ ] `validateBindings()` fails fast on misconfigured agent→model bindings
- [ ] `{env:VAR}` interpolation for API keys resolved during construction, with env var name validated against allowlist pattern (e.g., `*_API_KEY`, `CHEVAL_*`) — reject unexpected variable names with warning
- [ ] Unit tests: alias resolution, missing provider, disabled provider, capability validation
**Assigned**: Claude Code
**Dependencies**: T-14.2

#### T-14.4: Hounfour Types & Errors (P0, SDD §4.2)
**Description**: Implement `src/hounfour/types.ts` and `src/hounfour/errors.ts` — shared types (ModelPortBase, CompletionRequest, CompletionResult, CanonicalMessage, ExecutionContext, ToolCall) and typed error classes (HounfourError with codes: NATIVE_RUNTIME_REQUIRED, PROVIDER_UNAVAILABLE, BUDGET_EXCEEDED, etc.).
**Acceptance Criteria**:
- [ ] All interfaces from SDD §4.2 defined with correct types
- [ ] CanonicalMessage type supports null content on tool-call turns
- [ ] ExecutionContext includes scopeMeta, resolved model, binding, pricing
- [ ] `validateExecutionContext()` runtime validation function
- [ ] HounfourError class with typed error codes
**Assigned**: Claude Code
**Dependencies**: None

#### T-14.5: cheval.py Core Adapter (P0, FR-2, SDD §4.5)
**Description**: Implement `adapters/cheval.py` with machine mode entry point (`--request`), human CLI mode, OpenAI-compatible request building, response normalization to CompletionResult v1.0, and HMAC request validation.
**Acceptance Criteria**:
- [ ] Machine mode: `python3 cheval.py --request <path> --schema-version 1` works
- [ ] Human CLI mode: `python3 cheval.py <agent> <prompt-file>` works
- [ ] Response normalization extracts content, tool_calls, usage from OpenAI format with per-provider adapter contract (explicit mapping tables for field extraction, fallback when usage/tool_calls fields missing or renamed)
- [ ] `thinking` field set to `null` for non-thinking models (never fabricated)
- [ ] Graceful handling of missing usage fields (default to 0 with warning), malformed tool_calls (skip with error log), and non-JSON error bodies (wrap as string)
- [ ] HMAC validation: rejects requests with invalid/missing signature
- [ ] ChevalError class with code, provider_code, message, retryable fields
- [ ] Exit codes 0-5 per SDD §6.1.1
- [ ] Stderr for diagnostics only, never structured data. Redaction: never print request bodies, API keys, HMAC secrets, or prompt content to stderr
**Assigned**: Claude Code
**Dependencies**: T-14.2 (schemas), T-14.4 (types)

#### T-14.6: cheval.py Retry & Error Handling (P0, FR-2, SDD §4.2)
**Description**: Add retry logic to cheval.py — exponential backoff with jitter on retryable errors (429, 5xx), no retry on 400/401/403. Max retries configurable per-provider.
**Acceptance Criteria**:
- [ ] Retries on 429, 500, 502, 503, 504, timeout with backoff (1s, 2s, 4s, ±25% jitter, max 30s)
- [ ] No retry on 400, 401, 403, 404
- [ ] Max retries: 3 (default), configurable in ChevalRequest
- [ ] `max_tokens` clamped to `min(requested, provider.limit.output)`
- [ ] `trace_id` (UUID) generated per request, passed as `X-Request-ID` header
**Assigned**: Claude Code
**Dependencies**: T-14.5

#### T-14.7: Cost Ledger & Budget Enforcer (P0, FR-6, SDD §4.6)
**Description**: Implement `src/hounfour/budget.ts` — JSONL append-only ledger, budget checkpoint file, in-memory counters with write-ahead commit, and `deriveScopeKey()`.
**Acceptance Criteria**:
- [ ] JSONL ledger entries match schema from SDD §5.2 (all 16 fields)
- [ ] `deriveScopeKey()` produces consistent keys for project/phase/sprint scopes
- [ ] Write-ahead commit: ledger append → checkpoint write → counter update (SDD §4.6 SKP-005)
- [ ] `initFromCheckpoint()` O(1) startup, bounded fallback to current segment
- [ ] Configurable `on_ledger_failure`: `fail-open` (default for dev) or `fail-closed` (recommended for enforcement-critical scopes). Fail-closed rejects requests with `METERING_UNAVAILABLE` error when ledger writes fail
- [ ] On ledger write failure: emit loud console warning, mark budget state as `unknown`, log failure count. After >5min consecutive failures, report health degradation
- [ ] Integration tests: simulate disk-full/permission errors for both fail-open and fail-closed paths
- [ ] Async mutex around commit sequence
- [ ] GPU-hourly cost calculation: `(total_tokens / throughput) * (gpu_cost / 3600)`
- [ ] Unit tests: counter increment, threshold warnings, checkpoint recovery, fail-open/fail-closed
**Assigned**: Claude Code
**Dependencies**: T-14.4

#### T-14.8: ChevalInvoker & ChevalModelAdapter (P0, SDD §4.4, §4.2)
**Description**: Implement `src/hounfour/cheval-invoker.ts` — subprocess wrapper that constructs fully-resolved ChevalRequest, writes temp file with 0600 permissions, spawns cheval.py with HMAC signing and scoped env, parses stdout JSON.
**Acceptance Criteria**:
- [ ] ChevalInvoker passes fully-resolved config (TypeScript is single authority — SKP-001)
- [ ] Temp files in `/tmp/cheval-{pid}/` with 0600 permissions, securely deleted (unlink) after subprocess exits regardless of success/failure
- [ ] Environment scoped: only selected provider API key + CHEVAL_HMAC_SECRET + PATH (explicit allowlist, no pass-through of parent env)
- [ ] ChevalModelAdapter implements ModelPortBase (complete, capabilities, healthCheck)
- [ ] Health prober recordSuccess/recordFailure called on completion/error
- [ ] createModelAdapter() factory returns correct adapter for provider type
- [ ] Unit tests: subprocess invocation, exit code handling, HMAC generation
**Assigned**: Claude Code
**Dependencies**: T-14.3, T-14.5, T-14.7

#### T-14.9: `model-invoke` CLI Wrapper (P0, SDD §6.1)
**Description**: Implement `.claude/adapters/model-invoke` shell wrapper and `src/hounfour/cli.ts` entry point. Loads config, constructs CompletionRequest, calls ChevalInvoker, prints CompletionResult JSON to stdout.
**Acceptance Criteria**:
- [ ] `model-invoke <agent> <prompt-file> [--model alias]` invokes cheval.py via ChevalInvoker
- [ ] Loads provider config from `.loa.config.yaml`
- [ ] Constructs fully-resolved ChevalRequest with HMAC signing
- [ ] Prints CompletionResult JSON to stdout, diagnostics to stderr
- [ ] Non-zero exit on HounfourError/ChevalError with structured error JSON
- [ ] Unit tests: argument parsing, error propagation
**Assigned**: Claude Code
**Dependencies**: T-14.3, T-14.5, T-14.8

#### T-14.10: Provider Conformance Tests (P0, FR-2, SDD §11.2)
**Description**: Create golden fixture-based conformance tests for cheval.py. Per-provider request/response fixtures at `adapters/fixtures/`. Tests validate normalization.
**Acceptance Criteria**:
- [ ] OpenAI fixtures: completion, tool_call, error_429
- [ ] Moonshot fixtures: completion, thinking_trace (reasoning_content extraction)
- [ ] Qwen-local fixtures: completion, tool_call
- [ ] All fixtures validate CompletionResult schema v1.0
- [ ] Content/thinking separation verified per provider
- [ ] thinking=null for non-thinking models (not empty string)
- [ ] Contract tests for edge cases: missing usage fields, malformed tool_calls, non-JSON error bodies, truncated streaming chunks
- [ ] Conformance tests pass for ≥2 providers
**Assigned**: Claude Code
**Dependencies**: T-14.5

#### T-14.11: Integration Test — E2E Model Invoke (P0)
**Description**: End-to-end test: `translating-for-executives` agent invoked via `model-invoke` on Qwen3-Coder-Next (if available) or OpenAI gpt-4o-mini. Verify full path: config load → registry → model-invoke → ChevalInvoker → cheval.py → provider → CompletionResult → ledger entry.
**Acceptance Criteria**:
- [ ] Agent invocation via `model-invoke` succeeds with correct CompletionResult
- [ ] Ledger entry written with all 16 fields populated
- [ ] Cost calculated correctly from pricing config
- [ ] trace_id correlation from request to ledger entry
- [ ] Smoke test passes with live provider when credentials available; fixture-only when not
**Assigned**: Claude Code
**Dependencies**: T-14.9, T-14.5, T-14.7, T-14.8

---

## Sprint 2: Flatline Integration & Budget (Phase 1)

**Goal**: Flatline Protocol runs via Hounfour (not ad-hoc API calls). Thinking traces captured from Kimi-K2. Budget enforcement warns/blocks. Minimal tool-call E2E test passes.

**Exit Criteria**: Flatline uses `model-invoke` for both primary (GPT) and challenger (Kimi-K2). Thinking traces normalized. Budget warn at 80%. Tool-call roundtrip E2E passes.

### Tasks

#### T-15.1: HounfourRouter Core (P0, SDD §4.2)
**Description**: Implement `src/hounfour/router.ts` — central routing with resolveExecution(), invoke(), validateBindings(). Wires registry, budget, health, cheval.
**Acceptance Criteria**:
- [x] `resolveExecution()` implements alias resolution → capability check → budget downgrade → availability fallback
- [x] `walkChain()` with ordering, termination, cycle detection, exhaustion behavior (IMP-001)
- [x] `invoke()` builds ExecutionContext, creates ModelPortBase adapter, calls port.complete()
- [x] Post-invoke: records cost to budget, appends ledger, reports to health prober
- [x] `validateBindings()` fails fast at startup on misconfigured bindings
- [x] Unit tests: routing resolution, fallback walking, downgrade, native_runtime rejection
**Assigned**: Claude Code
**Dependencies**: T-14.3, T-14.4, T-14.7, T-14.8

#### T-15.2: Thinking Trace Normalization (P0, FR-7, SDD §4.10)
**Description**: Implement thinking trace extraction in cheval.py for Kimi-K2 (`reasoning_content` field). Add content/thinking separation tests.
**Acceptance Criteria**:
- [x] Kimi-K2: `choices[0].message.reasoning_content` → `CompletionResult.thinking`
- [x] Non-thinking models (GPT-4o, Qwen3): `thinking = null`
- [x] Strict separation: thinking never in content, content never in thinking
- [x] Conformance test with golden fixture for Kimi-K2 thinking trace
- [x] Ephemeral by default: traces not persisted
**Assigned**: Claude Code
**Dependencies**: T-14.5

#### T-15.3: Budget Enforcement — Warn/Block/Downgrade (P1, FR-6)
**Description**: Add budget enforcement paths to HounfourRouter. Warn at configurable %, block or downgrade at 100%.
**Acceptance Criteria**:
- [x] `budget.isWarning()` triggers console warning with scope and percentage
- [x] `budget.isExceeded()` triggers block (BUDGET_EXCEEDED error) or downgrade based on config
- [x] Downgrade walks downgrade chain, skipping capability-incompatible entries
- [x] Per-iteration budget check in tool-call loop
- [x] `getBudgetSnapshot()` method exposed via HealthDeps for dashboard consumption (wired in T-15.9)
- [x] Unit tests: warn threshold, block threshold, downgrade path
**Assigned**: Claude Code
**Dependencies**: T-15.1, T-14.7

#### T-15.4: Flatline Protocol Refactor (P0)
**Description**: Replace ad-hoc GPT API calls in `.claude/scripts/gpt-review-api.sh` and `.claude/scripts/flatline-orchestrator.sh` with `model-invoke` via Hounfour.
**Acceptance Criteria**:
- [x] `model-invoke flatline-primary "$prompt_file" --model reviewer` replaces direct OpenAI curl
- [x] `model-invoke flatline-challenger "$prompt_file" --model reasoning` replaces direct Moonshot curl
- [x] Flatline Protocol produces identical review structure
- [x] Cost metered through JSONL ledger with `agent: "flatline-primary"` / `"flatline-challenger"`
- [x] Existing Flatline tests still pass
**Assigned**: Claude Code
**Dependencies**: T-14.9 (model-invoke), T-15.1, T-15.2

#### T-15.5: Persona Loader (P0, SDD §4.11, IMP-005)
**Description**: Implement persona loading mechanism. Read persona.md at invocation time, inject as system message, run injection detection.
**Acceptance Criteria**:
- [x] Persona path resolved from AgentBinding.persona (relative to project root)
- [x] Content loaded at invocation time (not cached)
- [x] Injected as first system message in CompletionRequest.messages
- [x] Injection detection: known patterns scanned, rejected with warning on match
- [x] Missing persona file: proceed with user prompt alone (logged warning)
**Assigned**: Claude Code
**Dependencies**: T-15.1

#### T-15.6: Capability Checking & Fail-Fast (P0, FR-3)
**Description**: Implement capability validation at routing time. Hard-fail on native_runtime mismatch, tool_calling requirement, thinking_traces requirement.
**Acceptance Criteria**:
- [x] `native_runtime: true` agent bound to non-Claude provider → hard fail with NATIVE_RUNTIME_REQUIRED
- [x] `tool_calling: true` agent bound to non-tool-calling model → hard fail
- [x] `thinking_traces: required` agent bound to non-thinking model → hard fail
- [x] `thinking_traces: optional` → no failure (soft degradation)
- [x] Validation runs at startup (`validateBindings()`) AND at routing time
**Assigned**: Claude Code
**Dependencies**: T-15.1

#### T-15.7: Tool-Call Loop Orchestrator (P0, FR-4, SDD §4.9)
**Description**: Implement `invokeWithTools()` in HounfourRouter — multi-turn tool-call loop with idempotency, argument validation, repair strategy, context budget tracking.
**Acceptance Criteria**:
- [x] CanonicalMessage format with null content on tool-call turns
- [x] Idempotency cache keyed by deterministic key: `hash(tool_name + normalized_args + turn_index)` — handles providers that regenerate tool_call_id on retries
- [x] Tool argument validation against JSON schema before execution
- [x] Repair strategy: malformed JSON → error fed back, one retry per tool call
- [x] Budget check per iteration using ExecutionContext.scopeMeta
- [x] Context budget tracking via provider `usage` response (not local estimator): warn at 80% of max_context, abort at 90% (IMP-009)
- [x] Loop invariants enforced: `max_iterations` (default: 20), `abort_on_consecutive_failures` (default: 3), `max_wall_time_ms` (default: 120000), `max_total_tool_calls` (default: 50)
- [x] Unit tests: idempotency with changing tool_call_id, max iterations, consecutive failures, arg validation, context overflow, partial tool failures, model returning repeated tool_calls
**Assigned**: Claude Code
**Dependencies**: T-15.1, T-14.7

#### T-15.8: Tool-Call E2E Test (P0)
**Description**: Minimal tool-call roundtrip E2E test per PRD Phase 1 exit criterion: one tool definition sent, one tool_call returned, one tool_result fed back, final content received.
**Acceptance Criteria**:
- [x] Test sends CompletionRequest with one tool definition
- [x] Model returns tool_call, normalized to canonical ToolCall
- [x] Tool result fed back as CanonicalMessage with role: "tool"
- [x] Final response contains content (not another tool call)
- [x] Iteration accounting: 2 iterations counted
- [x] Budget charged for both iterations
**Assigned**: Claude Code
**Dependencies**: T-15.7

#### T-15.9: HealthProber Stub & Boot Sequence Integration (P0, SDD §8.1, §4.7)
**Description**: Implement minimal `src/hounfour/health.ts` stub (recordSuccess/recordFailure/isHealthy — default healthy, no background probes). Wire Hounfour into `src/index.ts` boot sequence as step 6e. Extend AppOptions with `hounfour`, HealthDeps with `getProviderHealth`.
**Acceptance Criteria**:
- [x] HealthProber stub: `recordSuccess()`, `recordFailure()`, `isHealthy()` (always returns true — no circuit breaker logic yet)
- [x] Step 6e: ProviderRegistry → BudgetEnforcer → HealthProber(stub) → ChevalInvoker → HounfourRouter
- [x] Graceful skip when no providers configured (backward compatible per NFR-3)
- [x] AppOptions extended with `hounfour?: HounfourRouter`
- [x] HealthDeps extended with `getProviderHealth` + `getBudgetSnapshot`
- [x] Dashboard health check includes provider status (from stub) and budget snapshot
**Assigned**: Claude Code
**Dependencies**: T-15.1, T-15.3

#### T-15.10: Connection Pooling (P1, FR-2)
**Description**: Configure httpx.Client reuse in cheval.py for self-hosted endpoints. Persistent connections reduce TCP overhead.
**Acceptance Criteria**:
- [x] httpx.Client created per provider with keep-alive
- [x] Connection pool size configurable (default: 10 per provider)
- [x] Client reused across invocations in human CLI mode
- [x] Machine mode: no pooling (subprocess lifecycle is one request)
**Assigned**: Claude Code
**Dependencies**: T-14.5

---

## Sprint 3: Agent Portability & Health (Phase 2)

**Goal**: 3+ agents run on non-Claude models. Health checks detect downed providers. Fallback chains work. Skill decomposition complete.

**Exit Criteria**: 3+ agents validated on non-Claude models. Model swap requires only config change. Health checks detect downed endpoint within 90s. Conformance tests pass for all enabled providers.

### Tasks

#### T-16.1: Skill Decomposition — persona.md + output-schema.md (P0, FR-8)
**Description**: Create `persona.md` and `output-schema.md` for all 8 agents. Zero breakage on native_runtime path.
**Acceptance Criteria**:
- [x] All 8 agent skills have `persona.md` (model-agnostic system prompt)
- [x] All 8 agent skills have `output-schema.md` (expected output format)
- [x] `SKILL.md` unchanged (native_runtime entry point preserved)
- [x] `remote_model` reads `persona.md` as system prompt + `output-schema.md` as format instruction
- [x] Native_runtime path unaffected (zero regression)
**Assigned**: Claude Code
**Dependencies**: T-15.5

#### T-16.2: Health Prober & Circuit Breaker — Full Implementation (P0, FR-5, SDD §4.7)
**Description**: Extend the HealthProber stub from T-15.9 into full implementation in `src/hounfour/health.ts` — per-provider:model health tracking, circuit breaker state machine, per-request feedback, background probes.
**Acceptance Criteria**:
- [x] Health state tracked per `provider:model` pair (SKP-004)
- [x] Error taxonomy: 429 NOT health failure, 5xx/timeout/connection refused ARE health failures
- [x] Circuit breaker: CLOSED → OPEN (N failures) → HALF_OPEN (interval + jitter) → CLOSED (success)
- [x] recordSuccess/recordFailure as primary signal, background probes supplementary
- [x] Background probes: provider-specific URL composition (baseURL + probe_path, host_relative)
- [x] Requires_auth probes include Bearer token
- [x] State transitions logged to WAL
- [x] Unit tests: circuit breaker transitions, probe timeout, host-relative URL, 429 vs 5xx taxonomy
**Assigned**: Claude Code
**Dependencies**: T-15.1

#### T-16.3: Outbound Rate Limiter (P0, SDD §4.8)
**Description**: Implement `src/hounfour/rate-limiter.ts` — per-provider token bucket for RPM and TPM.
**Acceptance Criteria**:
- [x] Token bucket per provider for RPM and TPM
- [x] Request queued (up to timeout) when over limit, not immediately failed
- [x] Rate limits configurable per-provider in config
- [x] Rate limiter acquire() called once per logical request (not per retry)
- [x] Unit tests: bucket depletion, queue timeout, refill
**Assigned**: Claude Code
**Dependencies**: T-14.4

#### T-16.4: Fallback & Downgrade Chains (P0, FR-5, SDD §4.3)
**Description**: Integrate walkChain() into live routing. Config-driven fallback (availability) and downgrade (cost) with capability filtering.
**Acceptance Criteria**:
- [x] Fallback triggered when health.isHealthy() returns false
- [x] Downgrade triggered when budget.isExceeded() and on_budget_exceeded=downgrade
- [x] Both chains skip entries not satisfying agent.requires capabilities
- [x] Downgrade impossible for native_runtime agents
- [x] Automatic restore when budget resets
- [x] Integration test: provider goes down → fallback → recovery → restore
**Assigned**: Claude Code
**Dependencies**: T-16.2, T-15.3

#### T-16.5: Ledger Rotation (P1, FR-6)
**Description**: Add size-based and age-based rotation to JSONL cost ledger.
**Acceptance Criteria**:
- [x] Rotate when file exceeds `max_size_mb` (default: 50MB)
- [x] Rotate files older than `max_age_days` (default: 30 days)
- [x] Archive path: configurable (default: `grimoires/loa/a2a/archive/cost-ledger/`)
- [x] Naming: `cost-ledger-{date}-{seq}.jsonl`
- [x] Rotation integrated into budget append workflow
**Assigned**: Claude Code
**Dependencies**: T-14.7

#### T-16.6: Fidelity Test Suite (P1, FR-8)
**Description**: Golden input fidelity tests to verify agent quality across models. Structural assertions (correctness, format, token budget) — not semantic equivalence.
**Acceptance Criteria**:
- [x] Golden inputs for at least 3 agents (translator, reviewer, flatline-challenger)
- [x] Structural assertions: output format matches output-schema.md, token count within budget
- [x] Tests run against at least 2 non-Claude models
- [x] Test results documented with pass/fail per agent per model
**Assigned**: Claude Code
**Dependencies**: T-16.1

#### T-16.7: `/cost-report` Command (P1, FR-6)
**Description**: Shell script that reads JSONL ledger, generates per-agent per-model per-provider spend breakdown in markdown.
**Acceptance Criteria**:
- [x] Reads all ledger files (including rotated archives)
- [x] Breakdown by: agent, model, provider, phase, sprint
- [x] Total cost, average cost per request, request count
- [x] Markdown output for embedding in sprint reports
**Assigned**: Claude Code
**Dependencies**: T-14.7, T-16.5

#### T-16.8: Dockerfile & Deployment Updates (P0, SDD §10.1)
**Description**: Update `deploy/Dockerfile` to include Python 3.10+, httpx, pyyaml. Copy adapters/ and schemas/ directories.
**Acceptance Criteria**:
- [x] Python 3.10+ installed in container
- [x] httpx and pyyaml pip-installed
- [x] adapters/ and schemas/ copied to build output
- [x] `model-invoke` wrapper script at `.claude/adapters/model-invoke`
- [x] Container builds and boots with Hounfour step 6e
**Assigned**: Claude Code
**Dependencies**: T-14.5, T-15.9

---

## Contingency & Rollback Strategy

**Schedule risk** (SKP-001): All tasks are P0 for a single AI engineer. If a sprint exceeds one session:
- **Thin vertical slice first**: Within each sprint, implement the narrowest path that satisfies exit criteria before expanding. Sprint 1: one provider + ledger + CLI before second provider.
- **Parallelizable checkpoints**: Schemas/fixtures (T-14.2, T-14.10) can proceed independently of adapter code. Threat model (T-14.1) has no code dependencies.
- **Overflow tasks**: If a sprint cannot complete, remaining P1 tasks roll to next sprint. P0 tasks must complete before sprint exit.

**Partial-completion criteria** (IMP-001): Each sprint defines a minimum viable completion:
- Sprint 1 minimum: T-14.1 + T-14.2 + T-14.4 + T-14.5 + T-14.7 (threat model, schemas, types, adapter, ledger). Remaining tasks can start Sprint 2 in parallel.
- Sprint 2 minimum: T-15.1 + T-15.7 + T-15.9 (router, tool-call loop, boot). Flatline refactor (T-15.4) can proceed after Sprint 2 minimum.
- Sprint 3 minimum: T-16.1 + T-16.2 + T-16.4 (skill decomposition, health prober, fallback). Fidelity tests and cost-report can follow.

**Rollback**: All config/schema/CLI changes are additive (new files/fields). Rollback = `git revert` of sprint branch. No backward-incompatible changes to existing code paths.

## Provider Timeout Configuration (IMP-010)

Per-provider timeout semantics added to config schema (T-14.2):

| Timeout | Default (API) | Default (Self-hosted) | Description |
|---------|--------------|----------------------|-------------|
| `connect_timeout_ms` | 5000 | 3000 | TCP connection timeout |
| `read_timeout_ms` | 60000 | 30000 | Response read timeout |
| `total_timeout_ms` | 300000 | 120000 | Full request lifecycle including retries |

Reasoning models (Kimi-K2) should use higher `read_timeout_ms` (120000) to allow for thinking time.

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Provider API unavailable during testing | Conformance fixture tests are mandatory; live smoke test is best-effort (pass when credentials available, skip gracefully otherwise) |
| Python subprocess overhead too high | Measured <50ms per invocation; library import eliminates in Phase 3. Tool-call loops: accept overhead for Phase 0-2, quantify actual overhead during Sprint 2 E2E testing (IMP-007) |
| Budget counter drift | Checkpoint file + bounded segment scan on startup |
| Tool-call loop cost explosion | Per-iteration budget check + max_iterations + max_wall_time + abort on consecutive failures |
| Config complexity | System defaults provide Claude-only config; gradual opt-in |
| HMAC interop failure | Canonical JSON serialization spec + TS→Python interop test in T-14.1 |
| Ledger write failure disabling budget | Configurable fail-open/fail-closed + health degradation alert after 5min |

## Sprint Dependencies

```
Sprint 1 (Foundation)
  └── Sprint 2 (Flatline + Budget) ← depends on registry, types, cheval, budget
       └── Sprint 3 (Portability + Health) ← depends on router, enforcement, probes
```

All sprints are sequential. Sprint 2 cannot start until Sprint 1 core components (registry, cheval, budget) are complete. Sprint 3 cannot start until Sprint 2 router and enforcement are wired.

## Flatline Review Findings Addressed

| ID | Type | Status | Resolution |
|----|------|--------|------------|
| SKP-001 | BLOCKER | Accepted | Added contingency & rollback strategy, minimum viable completion per sprint |
| SKP-002 | BLOCKER | Accepted | HMAC spec expanded: canonical JSON, nonce, clock skew, rotation lifecycle, interop tests |
| SKP-003 | BLOCKER | Accepted | fail-open/fail-closed configurable, health degradation alert, integration tests for disk errors |
| SKP-004 | BLOCKER | Accepted | Idempotency key uses deterministic hash (not provider tool_call_id), added loop invariants |
| SKP-005 | BLOCKER | Accepted | Per-provider adapter contract with explicit mapping, contract tests for missing fields |
| SKP-006 | BLOCKER | Accepted | Env var allowlist, temp file secure deletion, stderr redaction rules, scoped env allowlist |
| IMP-001 | HIGH | Integrated | Partial-completion criteria and rollback strategy per sprint |
| IMP-002 | HIGH | Integrated | HMAC secret provisioning/rotation/bootstrap in T-14.1 |
| IMP-004 | HIGH | Integrated | Credential validation spec in T-14.1 |
| IMP-007 | HIGH | Integrated | Subprocess overhead quantified in risk table, measured during Sprint 2 E2E |
| IMP-010 | HIGH | Integrated | Provider timeout config section with per-class defaults |
