# Sprint Plan: Cycle 2 — Substrate Runtime

> **Cycle**: cycle-2 substrate-runtime (Finn loader + Effect bridge + Kafka path deferred to Phase 3)
> **Build Doc**: `grimoires/loa/specs/cycle-2-substrate-runtime-build.md` — intent + invariants 1-8 + design + BARTH cuts (load-bearing)
> **Codebase Survey**: `grimoires/loa/specs/cycle-2-substrate-runtime-codebase-survey.md` — current loa-finn state, 5 load-bearing findings
> **Landscape Report**: `grimoires/loa/specs/cycle-2-substrate-runtime-landscape.md` — Effect-TS · Kafka · isolation · JWT recommendations
> **Doctrine**: `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md` §12 (cycle-1 first-execution corrections)
> **Personas**: OSTROM (ARCH lead) · ALEXANDER (Sprint 6 CLI surface only) · BARTH (scope cuts already held in build doc §10)
> **Prior cycle**: cycle-1 substrate-integration shipped 2026-05-03 — protocol Effect Schema + first instance (construct-lore-essay-grader) + manifest contract (loa-constructs#223 + construct-base#12) + 7 dispatch tests
> **Spike**: `scripts/substrate-spike.mjs` ✅ GREEN at 14.58ms cold-start — worker_threads can dynamic-import absolute file:// URLs, call default exports, await async exports. The load-bearing primitive holds.
> **Developer**: @zksoju (lead) · OSTROM-driven · pair-points at Sprint 3 mid + Sprint 7 close

---

## Sprint Overview

| Sprint | Label | Goal | Tasks | Build doc § |
|--------|-------|------|-------|-------------|
| sprint-1 | Loader scaffolding | `src/substrate/{types,loader,jwt-validator}.ts` + tests + `effect@^3.10` dep | 5 | §5.1 + §5.2 + §8.1 |
| sprint-2 | Runtime composition | `src/substrate/runtime.ts` ManagedRuntime + capability check + tests | 4 | §5.3 + §8.2 |
| sprint-3 | ModelRunner Layer | `model-runner-layer.ts` + cross-pack Tag identity bridge test (PAIR-POINT) | 4 | §5.4 + §8.3 |
| sprint-4 | EventWriter Layer | `event-writer-layer.ts` wrapping `src/events/writer.ts` + tests | 3 | §5.5 + §8.4 |
| sprint-5 | Sandbox bridge | `sandbox-bridge.ts` wire-up to `ToolSandbox.execute()` + worker-pool routing + tests | 3 | §8.5 + §6.2 |
| sprint-6 | CLI + API | `cli.ts` (ALEXANDER craft per §9) + `Substrate.invoke()` programmatic + tests | 4 | §5.6 + §8.6 + §9 |
| sprint-7 | E2E + doctrine | E2E test against published construct-lore-essay-grader + doctrine §13 + memory entry | 3 | §8.7 + §11 |

**Total tasks**: 26
**Branch shape**: `feat/substrate-runtime-sprint-N-<slug>` per sprint (1 PR per sprint per build doc §13.5 · gated on tests + Bridgebuilder review)
**No merge to main without**: loader + runtime + ModelRunner + EventWriter + sandbox-bridge + CLI all green individually + E2E green
**Operator pair-points**: pre-Sprint-1 (✅ done · spike GREEN · path drift fixed) · mid-Sprint-3 (Tag identity bridge) · pre-Sprint-7 (E2E fixture choice) · post-Sprint-7 (doctrine §13 review)

---

## Invariants (must not change · per build doc §2)

1. Effect-program construct contract: `(input: I) => Effect<O, E, R>` (cycle-1 sealed)
2. construct.yaml manifest schema: `type: substrate-construct` requires `executable.entry/export/protocol.input/protocol.output` + `runtime.engine`
3. Hounfour CompletionRequest/Result contract (TypeBox): wire format unchanged
4. Sandbox + worker-pool isolation: substrate-constructs RIDE `ToolSandbox.execute()` + filesystem jail; do NOT bypass
5. EventStore append-only contract at `src/events/writer.ts` + `src/events/types.ts` (NOT `src/persistence/` which is WAL+r2-sync+git-sync)
6. JWT licensing per `.claude/protocols/constructs-integration.md`: RS256 + cached refresh + grace periods
7. SubstrateStepSubmission/Verdict protocol contract version 1.0.0 frozen
8. Capability-bounded Layer: a construct can only do what its declared `requirements[].tag` set permits — Tag set IS capability set

---

## Sprint 1: Loader Scaffolding

**Goal**: Lay `src/substrate/` directory; ship loader that scans `.loa.config.yaml#substrate.constructs_dir` for `type: substrate-construct` packs, validates manifests against the just-merged Zod schema (loa-constructs#223), validates JWT licenses, and lazy-resolves dynamic imports on first invocation.

**Depends on**: Spike GREEN ✅
**Build doc reference**: §5.1 (directory layout) + §5.2 (loader interface + failure modes) + §8.1 (sprint instructions)
**Pre-implementation reads**: `~/Documents/GitHub/loa-constructs/packages/shared/src/validation.ts` (Zod schema) · `~/Documents/GitHub/loa-constructs/.claude/protocols/constructs-integration.md` (JWT flow) · `~/Documents/GitHub/construct-lore-essay-grader/construct.yaml` (manifest fixture) · `src/agent/resource-loader.ts` (filesystem-resolution pattern reference)

### Task 1.1: Add `effect@^3.10` to dependencies

**Description**: Run `pnpm add effect@^3.10` (or yarn/npm equivalent — confirm package manager). Effect-TS lives in `src/substrate/` only; no Finn-wide refactor. Verify `pnpm typecheck` passes after install.

**Acceptance Criteria**:
- [ ] `effect` listed in `package.json` dependencies at `^3.10.x`
- [ ] `pnpm install` (or equivalent) succeeds with no peer-dep warnings
- [ ] `pnpm typecheck` passes
- [ ] `package-lock.json` / `pnpm-lock.yaml` committed

**File**: `package.json` (modified)

---

### Task 1.2: Create `src/substrate/types.ts`

**Description**: Define internal types referenced by loader/runtime: `LoadedConstruct`, `ValidatedLicense`, `ManifestParseError`, `ManifestValidationError`, `LicenseError`, `EntryResolutionError`, `UnknownRequirementError`. Match build doc §5.2 interface shape exactly.

**Acceptance Criteria**:
- [ ] `LoadedConstruct` has `slug`, `manifest: ValidatedPackManifest`, `entryPath: string`, `loadModule: () => Promise<Record<string, unknown>>`, `license: ValidatedLicense`
- [ ] `ValidatedLicense` includes `tier`, `exp`, `kid`, `gracePeriodMs`
- [ ] All four error types are typed with `_tag` discriminator field
- [ ] File compiles with zero errors

**File**: `src/substrate/types.ts` (new)

---

### Task 1.3: Implement `src/substrate/jwt-validator.ts`

**Description**: Adapt the existing skill-pack JWT validation flow from `loa-constructs/.claude/protocols/constructs-integration.md` into a standalone module. RS256 verification via `jose` (already in package.json) · cached public key by `kid` · TTL = `min(license.exp, 1h)` · grace periods per tier (individual 24h · pro 24h · team 72h · enterprise 168h).

**Acceptance Criteria**:
- [ ] Public-key resolver is injectable (test mocks · prod fetches from registry)
- [ ] Validates RS256 signature; rejects with `LicenseError` if invalid
- [ ] Validates `exp`; rejects beyond grace period
- [ ] Caches validation result keyed by license fingerprint with TTL
- [ ] `LOA_OFFLINE=1` skips network refresh, uses cached key + result
- [ ] Unit tests cover: valid · expired-within-grace · expired-beyond-grace · bad-signature · missing-kid

**File**: `src/substrate/jwt-validator.ts` (new) + `src/substrate/__tests__/jwt-validator.test.ts`

---

### Task 1.4: Implement `src/substrate/loader.ts`

**Description**: Filesystem scanner + manifest validator + lazy dynamic-import memoization. Match build doc §5.2 interface exactly. Realpath canonicalization on `executable.entry` to prevent path traversal. Uses `@loa-constructs/shared` Zod schema (just-merged loa-constructs#223 superRefine).

**Acceptance Criteria**:
- [ ] `loadConstructsFromFilesystem(opts)` returns `Promise<Map<string, LoadedConstruct>>`
- [ ] Scans `opts.packsDir` for directories containing `construct.yaml` with `type: substrate-construct`
- [ ] Parses YAML; throws `ManifestParseError` on malformed
- [ ] Validates against `@loa-constructs/shared` Zod schema; throws `ManifestValidationError` with Zod issues array
- [ ] Validates `.license.json` via jwt-validator; throws `LicenseError` on rejection
- [ ] Resolves `executable.entry` to absolute path; rejects path-traversal (`..`) via realpath; throws `EntryResolutionError`
- [ ] `loadModule` is a memoized closure: first call does `await import(pathToFileURL(entry).href)`, subsequent calls return same module
- [ ] Loader is pure (no globals · no side effects beyond fs reads)

**File**: `src/substrate/loader.ts` (new)
**Depends on**: Task 1.2 (types), Task 1.3 (jwt-validator)

---

### Task 1.5: Loader unit tests

**Description**: Vitest tests using mock filesystem (in-memory) + mock JWT resolver. Cover happy path + each failure mode + memoization.

**Acceptance Criteria**:
- [ ] Loader correctly loads construct-lore-essay-grader fixture (use the published pack as a real-world fixture)
- [ ] Rejects manifest missing `executable.entry` with `ManifestValidationError`
- [ ] Rejects manifest with path-traversal in `executable.entry` with `EntryResolutionError`
- [ ] Rejects expired-beyond-grace license with `LicenseError`
- [ ] `loadModule` called twice returns the same module instance (referential equality)
- [ ] Test file uses vitest (matches existing `tests/finn/*.test.ts` pattern)

**File**: `src/substrate/__tests__/loader.test.ts` (new)
**Depends on**: Task 1.4

---

## Sprint 2: Runtime Composition

**Goal**: Per-construct Effect Layer composition via `ManagedRuntime.make(layer)`. Capability-bounded — a construct can only request services declared in its `requirements[].tag`.

**Depends on**: Sprint 1 complete (loader returns LoadedConstruct)
**Build doc reference**: §5.3 + §8.2
**Pre-implementation reads**: Effect docs `ManagedRuntime.ts` + Layer composition rules · landscape report Q1 §"Recommended canonical loader shape"

### Task 2.1: Implement `src/substrate/runtime.ts`

**Description**: `createConstructRuntime(loaded, opts)` returns `ConstructRuntime` with `slug`, `invoke<I,O>(input): Promise<O>`, `dispose(): Promise<void>`. Composes Layer from `loaded.manifest.requirements[].tag` matched against opts-provided Layers (ModelRunnerLayer, EventWriterLayer, default Logger, default Clock).

**Acceptance Criteria**:
- [ ] Walks `loaded.manifest.requirements[].tag` array
- [ ] For each declared Tag, verifies caller-provided Layer matches (by Tag string identifier)
- [ ] If construct declares unknown Tag → `UnknownRequirementError` at construction time (NOT at invoke time)
- [ ] Loader does NOT inject Tags not in declared `requirements[]` (capability-bounded · invariant 8)
- [ ] `ManagedRuntime.make(layer)` invoked once per construct lifetime (not per invocation)
- [ ] `dispose()` calls `runtime.dispose()` to release Layer scopes
- [ ] `invoke<I,O>(input)` calls `runtime.runPromise(program(input))` where `program` is resolved via `loaded.loadModule()` then `mod[manifest.executable.export]`

**File**: `src/substrate/runtime.ts` (new)
**Depends on**: Sprint 1 complete

---

### Task 2.2: Capability-check enforcement in runtime composition

**Description**: Reject runtime construction if `requirements[].tag` declares a Tag that has no matching Layer in opts. Validate at construction (fail fast) not at invocation (fail late).

**Acceptance Criteria**:
- [ ] `createConstructRuntime(loaded, { modelRunnerLayer, eventWriterLayer })` throws `UnknownRequirementError` if construct declares a third Tag not in opts
- [ ] Error message names the unknown Tag(s) and lists the loader's available Tag set
- [ ] Loader does not silently inject Tags the construct didn't request (test: construct with empty `requirements[]` cannot resolve `ModelRunner` even if Layer is in opts)

**File**: `src/substrate/runtime.ts` (continuation)

---

### Task 2.3: Lifetime + dispose semantics

**Description**: Runtime is created on first invocation request, cached per slug, disposed on JWT TTL expiry OR config reload. Verify no Layer reconstruction per invocation (Layer build is expensive · per landscape Q1).

**Acceptance Criteria**:
- [ ] First `invoke()` creates ManagedRuntime; subsequent `invoke()` calls reuse it
- [ ] `dispose()` properly releases all Layer-allocated resources (no Scope leaks)
- [ ] After `dispose()`, subsequent `invoke()` throws (or auto-recreates · operator decides in test)
- [ ] Memory: per-construct ManagedRuntime memory bounded; no growth across N invocations

**File**: `src/substrate/runtime.ts` (continuation)

---

### Task 2.4: Runtime unit tests

**Description**: Vitest tests with mock LoadedConstruct + mock Layers. Cover capability-check + lifetime + dispose.

**Acceptance Criteria**:
- [ ] Runtime created from mock LoadedConstruct yields callable `invoke`
- [ ] Refuses to construct if construct declares unknown Tag
- [ ] Refuses to invoke after dispose (or recreates · per task 2.3 decision)
- [ ] No zombie Layers after dispose (verified via reference equality + GC hint)
- [ ] Tests use vitest pattern

**File**: `src/substrate/__tests__/runtime.test.ts` (new)
**Depends on**: Tasks 2.1-2.3

---

## Sprint 3: ModelRunner Layer + Tag Identity Bridge (PAIR-POINT)

**Goal**: Build the Effect Layer that provides `ModelRunner` Tag wrapping `src/hounfour/cheval-invoker.ts`. **CRITICAL**: cross-pack Tag identity must match — the construct's `Context.Tag("ModelRunner")` and the loader's `Context.Tag("ModelRunner")` must resolve to the same identity at runtime.

**Depends on**: Sprint 2 complete
**Build doc reference**: §5.4 + §8.3 + §13 mid-Sprint-3 pair-point
**Pre-implementation reads**: `~/Documents/GitHub/construct-lore-essay-grader/src/grader.ts` (verify the exact Tag declaration shape) · `src/hounfour/cheval-invoker.ts` (the wrapped function signature)

### Task 3.1: Verify Tag identity contract with construct-lore-essay-grader

**Description**: Read the construct's `src/grader.ts` to confirm the exact `Context.Tag("ModelRunner")` declaration. Document the canonical Tag identifier + interface shape in `src/substrate/types.ts`. This is the cross-pack ABI for Sprint-3 onward.

**Acceptance Criteria**:
- [ ] Tag identifier confirmed (string passed to `Context.Tag(...)`)
- [ ] Interface shape (e.g., `{ complete: (params) => Effect<string, ModelRunnerError> }`) documented in types.ts
- [ ] Document is the SOURCE OF TRUTH that future substrate-construct authors match
- [ ] Operator pair-point: surface findings before authoring Layer

**File**: `src/substrate/types.ts` (modified — add ModelRunner Tag contract section)

---

### Task 3.2: Implement `src/substrate/model-runner-layer.ts`

**Description**: Effect Layer that provides `ModelRunner` Tag. The Layer's `complete()` impl wraps `src/hounfour/cheval-invoker.ts:invoke()` — builds Hounfour `CompletionRequest` (TypeBox-validated) from `{systemPrompt, userMessage, modelId, agentId, tenantId}` opts, calls cheval, returns model text. Errors typed as `ModelRunnerError`.

**Acceptance Criteria**:
- [ ] Tag declared with EXACT identifier from Task 3.1
- [ ] Interface shape EXACTLY matches what construct's grader.ts expects
- [ ] `buildModelRunnerLayer(opts)` factory takes `{poolId, modelId, agentId, tenantId}`
- [ ] Wraps `chevalInvoke()` via `Effect.tryPromise`; converts thrown errors to `ModelRunnerError`
- [ ] Does not modify `cheval-invoker.ts` itself (invariant 3)
- [ ] HMAC signing + canonicalJsonStringify handled inside cheval (Layer doesn't re-implement)

**File**: `src/substrate/model-runner-layer.ts` (new)
**Depends on**: Task 3.1

---

### Task 3.3: Cross-pack integration test (TAG IDENTITY BRIDGE)

**Description**: **THE LOAD-BEARING TEST.** Import `gradeLoreEssay` directly from `~/Documents/GitHub/construct-lore-essay-grader/src/grader.ts` (via local file path resolution OR npm-link). Provide the loader's `buildModelRunnerLayer({...})` Layer with a mocked `chevalInvoke`. Run the Effect program. Verify the Tag resolves correctly + the Effect resolves to a `LoreEssayOutput` with the mocked response.

**Acceptance Criteria**:
- [ ] Test imports actual published construct module (not a re-implementation)
- [ ] Mock `chevalInvoke` returns canned JSON matching `LoreEssayOutput` schema
- [ ] `Effect.runPromise(gradeLoreEssay(input).pipe(Effect.provide(layer)))` resolves correctly
- [ ] Verifies Tag identity matches (no "Tag not provided" error)
- [ ] If this fails: stop · operator pair-point · adjust Tag identifier or interface shape

**File**: `src/substrate/__tests__/model-runner-layer.integration.test.ts` (new)
**Depends on**: Task 3.2

---

### Task 3.4: ModelRunner Layer unit tests

**Description**: Test buildModelRunnerLayer with mock cheval. Cover happy path · cheval throws · timeout · invalid response.

**Acceptance Criteria**:
- [ ] Layer composes with ModelRunner Tag
- [ ] `complete()` correctly translates Effect → CompletionRequest → Effect
- [ ] cheval throws → ModelRunnerError surfaces with cause
- [ ] HMAC signing happens (verify via cheval mock spy)

**File**: `src/substrate/__tests__/model-runner-layer.test.ts` (new)
**Depends on**: Task 3.2

---

## Sprint 4: EventWriter Layer

**Goal**: Effect Layer that provides `EventWriter` Tag wrapping the existing EventStore at `src/events/writer.ts`. Phase-3 KafkaWriter swaps in via same Tag, different impl.

**Depends on**: Sprint 3 complete (Tag identity contract is the template)
**Build doc reference**: §5.5 (with path correction noted in build doc) + §8.4
**Pre-implementation reads**: `src/events/writer.ts` (EventWriter API surface) · `src/events/types.ts` (EventEnvelope shape: event_id ULID · stream branded · event_type · timestamp · correlation_id · sequence · checksum CRC32 · schema_version · payload)

### Task 4.1: Implement `src/substrate/event-writer-layer.ts`

**Description**: Effect Layer providing `EventWriter` Tag. Wraps `src/events/writer.ts` EventWriter. `publish(subject, payload)` constructs full EventEnvelope (event_id ULID · stream branded · event_type=`substrate.invocation.result` or per-construct subject · timestamp ISO · correlation_id from input · sequence per-stream · checksum CRC32 · schema_version=1 · payload).

**Acceptance Criteria**:
- [ ] Tag declared (string identifier "EventWriter")
- [ ] Interface: `publish: (subject: string, payload: unknown) => Effect<void, EventWriterError>`
- [ ] Constructs full EventEnvelope per `src/events/types.ts` schema
- [ ] Three-segment subject naming `{aggregate}.{noun}.{verb}` enforced (warn or reject malformed)
- [ ] Wraps existing EventWriter (no modification to events/ module · invariant 5)

**File**: `src/substrate/event-writer-layer.ts` (new)

---

### Task 4.2: Subject naming convention helper

**Description**: Util to validate three-segment dotted subjects. Reject malformed at Layer construction OR per-publish (operator decides).

**Acceptance Criteria**:
- [ ] `validateSubject(subject)` returns `Result<string, SubjectError>`
- [ ] Three segments separated by `.` (e.g., `agent.lore-essay.verdict`)
- [ ] Each segment matches `/^[a-z][a-z0-9-]*$/`
- [ ] Helper exported for Phase-3 KafkaWriter reuse

**File**: `src/substrate/event-writer-layer.ts` (continuation)

---

### Task 4.3: EventWriter Layer tests

**Description**: Vitest with in-memory EventWriter mock. Verify envelope shape · subject validation · checksum computation.

**Acceptance Criteria**:
- [ ] `publish()` correctly constructs EventEnvelope matching types.ts shape
- [ ] Bad subjects rejected with SubjectError
- [ ] checksum field populated via `computePayloadChecksum`
- [ ] schema_version=1 set

**File**: `src/substrate/__tests__/event-writer-layer.test.ts` (new)
**Depends on**: Tasks 4.1-4.2

---

## Sprint 5: Sandbox Bridge (Wire-Up)

**Goal**: Route `ConstructRuntime.invoke()` through `ToolSandbox.execute()` and run Effect inside the existing `worker-pool.ts` interactive lane. Spike already proved primitive works (✅ 14.58ms cold-start) — this sprint is wire-up.

**Depends on**: Sprint 4 complete
**Build doc reference**: §8.5 + §6.2 boundaries
**Pre-implementation reads**: `src/agent/sandbox.ts` (ToolSandbox + FilesystemJail) · `src/agent/worker-pool.ts` (lane dispatch) · `src/agent/sandbox-worker.ts` (worker-side bash exec — substrate adds dynamic-import path)

### Task 5.1: Extend sandbox-worker for substrate-construct invocation

**Description**: Add a new message type `substrate-invoke` to `sandbox-worker.ts` parallel to existing `exec`/`abort`. Worker receives `{type:"substrate-invoke", jobId, modPath, exportName, input, runtimeContext}`. Worker dynamic-imports modPath, resolves exportName, runs the Effect with provided runtime context (Layer), posts result `{type:"result", jobId, result}`.

**Acceptance Criteria**:
- [ ] New message type `substrate-invoke` handled alongside `exec`/`abort`
- [ ] Worker validates `modPath` against jail (jailReal contains modPath)
- [ ] Dynamic-import via `pathToFileURL(modPath).href` (proven by spike)
- [ ] Result envelope matches existing pattern (`{type:"result", jobId, result}`)
- [ ] Errors translated to `{type:"result", jobId, error}` shape

**File**: `src/agent/sandbox-worker.ts` (modified)

---

### Task 5.2: Implement `src/substrate/sandbox-bridge.ts`

**Description**: Bridge between `ConstructRuntime.invoke()` and `WorkerPool.exec(spec, "interactive")`. Marshals input + runtime-context into worker message; awaits result; deserializes verdict.

**Acceptance Criteria**:
- [ ] `bridgeInvoke(loaded, layer, input)` dispatches to interactive lane via WorkerPool
- [ ] Marshals input to JSON-serializable shape (Effect Layer is built parent-side; only input crosses worker boundary — see open Q below)
- [x] ✅ **RESOLVED** by PRD v1.2.0 (2026-05-03): **Option A — worker-side runtime + Layer composition + Effect program execution; ModelRunner/EventWriter Layer impls bridge to parent via `postMessage` for cheval-invoker / EventStore calls.** Module split: `src/agent/sandbox-worker.ts` (Effect-free, validates envelope + delegates) → `src/substrate/worker-runtime.ts` (NEW, Effect lives here, holds the per-worker per-construct ManagedRuntime cache). Bridge envelopes are structured-clone-safe (NOT JSON), with type-specific payload schemas. See PRD FR-5 + SDD §4.7-§4.9 for full protocol.
- [ ] Filesystem jail enforced (worker rejects modPath outside jail)
- [ ] Worker survives + accepts next invocation after each call

**File**: `src/substrate/sandbox-bridge.ts` (new)
**Depends on**: Task 5.1

---

### Task 5.3: Sandbox bridge tests

**Description**: Integration test using real WorkerPool + real sandbox-worker + a fixture substrate-construct.

**Acceptance Criteria**:
- [ ] Substrate invocation runs in interactive lane (worker 1 or 2 occupied during invoke)
- [ ] Worker survives + handles second invocation after first completes
- [ ] Filesystem jail blocks attempts to read outside pack dir (verify via test fixture trying `fs.readFileSync('/etc/hosts')`)
- [ ] Test uses vitest pattern; runs against real worker_threads (not mocked)

**File**: `src/substrate/__tests__/sandbox-bridge.integration.test.ts` (new)
**Depends on**: Tasks 5.1-5.2

---

## Sprint 6: CLI + Programmatic API (ALEXANDER craft)

**Goal**: Operator-facing CLI `loa-finn substrate-construct invoke <slug> --input <file>` + programmatic API `Substrate.invoke(slug, input)`.

**Depends on**: Sprint 5 complete
**Build doc reference**: §5.6 + §8.6 + §9 (ALEXANDER design rules)
**Persona**: ALEXANDER for CLI surface (the only Sprint where ALEXANDER engages directly · stdout JSON discipline · stderr human progress · color only on status · monospace numerics)

### Task 6.1: Implement `src/substrate/cli.ts`

**Description**: Subcommand `loa-finn substrate-construct invoke <slug> --input <file>`. Reads input JSON, instantiates loader + runtime + Layers, dispatches via sandbox-bridge, returns verdict.

**Acceptance Criteria**:
- [ ] Subcommand parses `<slug>` + `--input <file>` args
- [ ] Loader scans `.loa.config.yaml#substrate.constructs_dir` (default `~/.loa/constructs/packs/`)
- [ ] On success: stdout = JSON verdict matching `SubstrateStepVerdict` Effect Schema · exit 0/1/2 by status
- [ ] On error: stderr = human trace · exit 3+
- [ ] Wires CLI into existing `src/index.ts` or `src/hounfour/cli.ts` entry point pattern

**File**: `src/substrate/cli.ts` (new)

---

### Task 6.2: ALEXANDER craft for CLI output

**Description**: Apply build doc §9 design rules. stdout = JSON only · stderr = human progress with `Loading...` `Composing...` `Invoking...` prefixes · color ONLY on status (APPROVED green oklch(0.65 0.18 145) · REJECTED red oklch(0.62 0.22 25) · NEEDS_HUMAN yellow oklch(0.78 0.18 90)) · monospace numerics for confidence + dimensions · NO emoji · NO decoration · NO progress bars.

**Acceptance Criteria**:
- [ ] stderr human progress messages match build doc §5.6 examples
- [ ] stdout is parseable JSON (machine-readable Nakamoto protocol)
- [ ] Color applied only when stderr is a TTY (don't paint pipes)
- [ ] Confidence + dimension floats render with `tabular-nums` equivalent (right-aligned · fixed-width)
- [ ] Test verifies output capture: stdout matches `SubstrateStepVerdict` shape

**File**: `src/substrate/cli.ts` (continuation)

---

### Task 6.3: Programmatic `Substrate.invoke()` API

**Description**: Barrel export at `src/substrate/index.ts`: `Substrate.invoke(slug, input)` → `Promise<SubstrateStepVerdict>`. For freeside-quests/apps/api consumers in cycle-3.

**Acceptance Criteria**:
- [ ] `import { Substrate } from "@loa-finn/substrate"` (or relative path) returns API object
- [ ] `Substrate.invoke(slug, input)` returns typed verdict
- [ ] No CLI craft (programmatic API has no human surface)
- [ ] Types are the API: TypeScript autocompletion shows method signature + verdict shape

**File**: `src/substrate/index.ts` (new — barrel export)

---

### Task 6.4: CLI + API tests

**Description**: Vitest CLI integration test (spawn process, capture stdout/stderr) + programmatic API test (direct call).

**Acceptance Criteria**:
- [ ] CLI test: invoke against published construct-lore-essay-grader, capture stdout JSON, verify shape
- [ ] CLI test: exit code matches status (0 APPROVED · 1 REJECTED · 2 NEEDS_HUMAN · 3+ system error)
- [ ] API test: `Substrate.invoke("lore-essay-grader", input)` returns typed verdict
- [ ] Tests use vitest pattern

**File**: `src/substrate/__tests__/cli.test.ts` + `src/substrate/__tests__/index.test.ts` (new)
**Depends on**: Tasks 6.1-6.3

---

## Sprint 7: E2E Smoke + Doctrine §13 + Memory

**Goal**: End-to-end test loading the real construct-lore-essay-grader pack with a TestModelRunner Layer. Then doctrine update + memory entry shipping cycle-2 first-execution learnings.

**Depends on**: Sprint 6 complete
**Build doc reference**: §8.7 + §11 verify checklist + §12 deferred V1.5
**Pre-implementation reads**: `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md` §12 (cycle-1 doctrine — §13 will be authored here) · cycle-1 memory entries in `/Users/zksoju/.claude/projects/-Users-zksoju-bonfire/memory/`

### Task 7.1: E2E test against real construct-lore-essay-grader pack

**Description**: Set up fixture: copy or symlink construct-lore-essay-grader pack into a fixture packs dir. Loader scans, finds construct, validates manifest + license, runtime composes Layer with `TestModelRunner` (canned response matching LoreEssayOutput schema), CLI invokes with sample essay input, verdict matches expected.

**Acceptance Criteria**:
- [ ] Fixture packs dir created (test scope · auto-cleaned)
- [ ] construct-lore-essay-grader pack present (real, not mocked — use the published source)
- [ ] TestModelRunner returns canned JSON matching LoreEssayOutput schema
- [ ] CLI invocation `loa-finn substrate-construct invoke lore-essay-grader --input ./test-essay.json` returns expected verdict
- [ ] Exit code matches expected status
- [ ] All 12 verify checklist items from build doc §11 pass

**File**: `src/substrate/__tests__/e2e.test.ts` (new) + `src/substrate/__tests__/fixtures/test-essay.json`
**Operator pair-point**: pre-Sprint-7 — confirm fixture choice (real pack vs simplified test pack)

---

### Task 7.2: Doctrine §13 — cycle-2 first-execution learnings

**Description**: Append section §13 to `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md`. Mirror §12's structure: corrections (if any) · what was proven · what was deferred · what surprised · doctrine confidence update (0.90 → 0.95 if green).

**Acceptance Criteria**:
- [ ] §13 added with subsections matching §12 shape
- [ ] §13.X "What was proven this cycle": loader + ManagedRuntime per construct + Tag-identity bridging + sandbox compatible + JWT cached refresh + capability-bounded Layer enforcement
- [ ] §13.X "What's deferred to cycle-3": Kafka transport (KafkaWriter + KafkaConsumer) · vendor/untrusted isolation tiers · per-invocation JWT introspection · construct-creation tooling · cubquests-interface integration · real-LLM AnthropicModelRunner
- [ ] §13.X "Doctrine confidence": 0.90 → 0.95 (or document why not)
- [ ] Frontmatter `updated:` field bumped to current date

**File**: `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md` (modified)
**Operator pair-point**: post-Sprint-7 — review §13 draft

---

### Task 7.3: Memory entry — cycle-2 substrate-runtime SHIPPED

**Description**: Author or extend memory entry at `/Users/zksoju/.claude/projects/-Users-zksoju-bonfire/memory/`. Pattern follows existing `project_substrate_layer_integration_cycle_001_shipped.md`. Add MEMORY.md index entry.

**Acceptance Criteria**:
- [ ] Memory file `project_cycle_2_substrate_runtime_shipped.md` created (or cycle-1 file extended with §cycle-2 subsection)
- [ ] Frontmatter: `name`, `description` (specific 1-line), `type: project`
- [ ] Body covers: 6 PRs merged · src/substrate/ ships · spike GREEN at 14.58ms · cycle-1 doctrine §12 corrections honored · §13 added · what's queued for cycle-3
- [ ] MEMORY.md index entry added (one line under ~200 chars)

**File**: `/Users/zksoju/.claude/projects/-Users-zksoju-bonfire/memory/project_cycle_2_substrate_runtime_shipped.md` (new) + MEMORY.md (modified)

---

## What NOT to Build (BARTH cuts · per build doc §10 · held)

- ❌ No Kafka cluster setup — KafkaWriter Layer + KafkaConsumer = Sprint 8 / cycle-3
- ❌ No `trust:vendor` or `trust:untrusted` isolation tiers — only `trust:internal` (worker_threads + capability-bounded Layer)
- ❌ No per-invocation JWT introspection — load-time RS256 + cached TTL
- ❌ No construct-creation tooling — operators author construct.yaml + entry by hand
- ❌ No cubquests-interface integration — separate cycle (cycle-1 §12.4 deferred)
- ❌ No Real-LLM AnthropicModelRunner — TestModelRunner suffices for Sprint-7 e2e
- ❌ No new Effect-TS adoption in `src/agent/` or `src/hounfour/` — Effect lives in `src/substrate/` only
- ❌ No multi-construct composition recipe — single-construct invocation only (cycle-3+)
- ❌ No registry.constructs.network publishing — substrate-constructs install via filesystem pack OR existing `/loa constructs install`

---

## Verify (success criteria for cycle-2 close)

After Sprint 7 ships, all of these must be true:

- [ ] Loader scans constructs_dir and finds construct-lore-essay-grader
- [ ] Loader validates manifest against just-merged loa-constructs Zod schema · rejects bad manifests
- [ ] Loader validates JWT license · respects grace periods
- [ ] Runtime composes Layer with capability-bounded Tags only
- [ ] ModelRunner Layer correctly wraps cheval-invoker
- [ ] EventWriter Layer correctly wraps src/events/ EventWriter
- [ ] Substrate invocation runs inside worker_threads sandbox (filesystem jail enforced)
- [ ] CLI command `loa-finn substrate-construct invoke <slug>` returns typed verdict
- [ ] Programmatic API `Substrate.invoke()` returns typed verdict
- [ ] End-to-end test loads real construct-lore-essay-grader pack + runs with TestModelRunner + verifies verdict
- [ ] Doctrine §13 cycle-2 first-execution-learnings filled in
- [ ] Memory entry shipped + MEMORY.md index updated
- [ ] Kafka adapter NOT shipped (BARTH cut held — Phase 3)
- [ ] All sprint PRs merged via Bridgebuilder review

---

## Coordination

1. **Sprint cadence**: 7 sprints serial. Each 1-3 hours. Spike already done (Sprint 5 sandbox-bridge is wire-up only).
2. **Operator pair-points** (in addition to pre-Sprint-1 already done):
   - **Mid-Sprint-3**: review Tag identity bridge findings (Task 3.1) before authoring Layer (Task 3.2)
   - **Pre-Sprint-7**: confirm e2e fixture (real pack vs simplified)
   - **Post-Sprint-7**: review doctrine §13 draft before commit
3. **Branches**: `feat/substrate-runtime-sprint-N-<slug>` per sprint
4. **PRs**: One per sprint · Bridgebuilder review gating · merge to `main` after green
5. **Cycle close**: when all 7 sprints merged + verify checklist all green + doctrine §13 + memory entry. Cadence: cycle-3 candidates = Kafka transport · cubquests integration · real-LLM ModelRunner.

---

*Drafted 2026-05-03 PM as the Loa-shaped sprint plan derived from `grimoires/loa/specs/cycle-2-substrate-runtime-build.md`. Spike GREEN. Path drift fixed. Operator can now fire `/run sprint-plan` (or per-sprint `/implement sprint-N`) to dispatch the cycle.*
