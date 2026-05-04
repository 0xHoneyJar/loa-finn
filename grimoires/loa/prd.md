# PRD: Substrate Runtime — Effect Loader + Worker-Thread Sandbox + EventStore Bridge

> **Version**: 1.2.0
> **Date**: 2026-05-03
> **Author**: @zksoju + Claude Opus 4.7 (1M context)
> **Status**: Draft (iteration 3 — applies Codex iteration-2 review: HIGH sandbox-claim narrowing + 4 MEDIUM sharpening)
> **Cycle**: cycle-032 (operator-naming: cycle-2 substrate-runtime)
> **Build Doc** (ground truth): `grimoires/loa/specs/cycle-2-substrate-runtime-build.md` — 639 lines · OSTROM-led architecture + ALEXANDER craft for CLI + BARTH scope cuts
> **Codebase Survey**: `grimoires/loa/specs/cycle-2-substrate-runtime-codebase-survey.md` — 5 load-bearing findings about loa-finn's existing sandbox + worker-pool + EventStore primitives
> **Landscape Report**: `grimoires/loa/specs/cycle-2-substrate-runtime-landscape.md` — Effect-TS ManagedRuntime · Kafka client (CJSK) · 3-tier isolation recommendations
> **Predecessor**: cycle-031 "Adaptive Intelligence" (sprints 124-125, merged to main as PR #92, 2026-02-21)
> **Companion cycle (shipped)**: cycle-1 substrate-integration (2026-05-03 PM · 3 PRs · construct-lore-essay-grader instance-1 published · doctrine §12 written)
> **Doctrine**: `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md` §12 (cycle-1 first-execution corrections + operator's "constructs are agents" reframe)
> **Spike**: `scripts/substrate-spike.mjs` ✅ GREEN at 14.58ms cold-start — worker_threads can dynamic-import absolute file:// URLs, call default exports, await async exports. The load-bearing primitive holds.
> **Cross-model review history**:
> - Iteration 1 (`prd-cycle032-findings-1.json`): 6 MEDIUM + 1 LOW + 1 PRAISE; DECISION_NEEDED resolved as **Option A** (worker-side runtime + parent-bridge proxies) — see FR-5.
> - Iteration 2 (`prd-cycle032-findings-2.json`): 1 HIGH (sandbox-claim overreach) + 4 MEDIUM (Effect placement, lifecycle, serialization contract, JWT cache state-awareness). All applied in this v1.2.0.

---

## 0. Why This Cycle Exists

Cycle-1 (substrate-integration) shipped the **substrate ABI** at the contract layer:
- `@freeside-quests/protocol` — Effect Schema for `SubstrateStepSubmission` / `SubstrateStepVerdict` (contract version 1.0.0, frozen)
- `construct-lore-essay-grader` — instance-1 of `type: substrate-construct` (BORGES persona, 3 grading dimensions, pure Effect program)
- `construct-base/schemas/construct.schema.json` — JSON Schema accepts `type: substrate-construct`
- `loa-constructs/packages/shared/src/validation.ts` — Zod manifest schema with `superRefine`
- `@freeside-quests/engine` — `dispatchEssayQuest` Plane-3 bridging logic (in-process via direct `Effect.runPromise`)

What cycle-1 did NOT ship — and what cycle-1's doctrine §12.1 correction #5 named explicitly: *"the substrate-construct runtime layer is genuinely aspirational at the framework level."*

**Cycle-032 makes the runtime real.** A loader living in loa-finn that takes a construct slug + an input, finds the pack on the filesystem, dynamic-imports the Effect entry, composes the right Layer (with concrete impls for declared Requirements), runs the Effect program **inside a worker_threads sandbox via parent-bridge proxies** (per Option A — see FR-5), and returns the typed verdict to the caller.

This closes the operator-named gap. After cycle-032, substrate-constructs are end-to-end executable inside loa-finn, not aspirational.

---

## 1. Problem Statement

The substrate ABI is defined but unrunnable inside loa-finn. A construct authored as an Effect program (`(input: I) => Effect<O, E, R>` shape, with declared `requirements[].tag` Effect Tags) cannot today be loaded from a filesystem pack and invoked inside loa-finn's existing sandbox. The protocol Schema, the manifest contract, and the first instance pack all exist — but no loader bridges them to execution.

**Operator value**: the gap blocks the operator's own composition pattern (substrate-constructs as deployable agents) from materializing. Until loa-finn can load + run a substrate-construct end-to-end, every new construct stays a paper artifact.

**Engineering value**: the runtime layer is the load-bearing seam between three existing systems (sandbox, hounfour cheval-invoker, EventStore writer). Wiring it correctly is what makes future substrate-constructs (without LLMs, with custom Tags, with Kafka-backed event streams in Phase 3) cheap to ship.

---

## 2. Functional Requirements

### FR-1 · Loader (`src/substrate/loader.ts` + `jwt-validator.ts` + `types.ts`)

**Goal**: at startup, scan `.loa.config.yaml#substrate.constructs_dir` (default `~/.loa/constructs/packs/`) for directories containing `construct.yaml` with `type: substrate-construct`. For each:

1. Read + parse `construct.yaml`
2. Validate against `@loa-constructs/shared` Zod schema (the just-merged loa-constructs#223 `superRefine`)
3. Validate JWT license at `.license.json` (RS256 · per `.claude/protocols/constructs-integration.md` in loa-constructs)
4. Resolve `executable.entry` to absolute path under pack root (realpath canonicalization to prevent traversal)
5. Lazy: defer `import(pathToFileURL(entry))` to first invocation (memoized)
6. Add to in-memory registry

**Failure modes** (all typed):
- `ManifestParseError` — yaml malformed
- `ManifestValidationError` — Zod schema rejected (with issues array)
- `LicenseError` — JWT missing / invalid / expired beyond grace period
- `EntryResolutionError` — `executable.entry` path traversal or missing file

**JWT validation/cache contract** (state-aware · per Codex iteration-2 review #5 · invariant 6):

The cache holds two distinct result states. Cache key for both: `(license.fingerprint, license.kid)`.

| License state | Validation result returned | Cache TTL | Re-check on read |
|---|---|---|---|
| `valid` (now < exp · nbf ≤ now) | `{status: "valid", license}` | `min(exp - now, 1h)` | exp + nbf vs current clock — reject if drift |
| `grace` (exp ≤ now < exp + tier.grace_seconds) | `{status: "validatedWithGrace", license, graceUntil}` | `min((exp + grace) - now, 1h)` | exp + grace vs current clock — reject if beyond grace |
| `expired` (now ≥ exp + tier.grace_seconds) | `LicenseError("expired beyond grace")` | not cached | n/a |
| `not-yet-valid` (nbf > now) | `LicenseError("license not yet valid")` | not cached | n/a |

Tier grace per cycle-1 contract: individual 24h · pro 24h · team 72h · enterprise 168h.

**Required fake-clock test matrix** (gates Sprint 1 close):

| Test | Setup | Expected |
|---|---|---|
| valid | `now < exp` | returns `{status: "valid"}`; cached |
| not-yet-valid | `nbf > now` (license uses `nbf`) | `LicenseError`; not cached |
| expired-within-grace | `exp ≤ now < exp + grace` | returns `{status: "validatedWithGrace"}`; cached with grace TTL |
| expired-beyond-grace | `now ≥ exp + grace` | `LicenseError`; not cached |
| key-rotation | cached entry with old `kid`; license now signed with new `kid` | cache miss → re-validate against new key |
| LOA_OFFLINE cached-key-present cached-result-valid | offline mode, cache populated, result still inside TTL | returns cached `{status: "valid"}`; no resolver call |
| LOA_OFFLINE cached-key-present cached-result-stale | offline mode, cache populated, TTL expired but exp+grace not | re-validates against cached public key (no resolver call); returns `{status: "validatedWithGrace"}` if applicable |
| LOA_OFFLINE no-cached-key | offline mode, public key never fetched | `LicenseError("offline mode: no cached key for kid=X")`; no resolver call |
| LOA_OFFLINE cached-result-beyond-grace | offline mode, cache stale beyond grace | `LicenseError("expired beyond grace")`; no resolver call |

**Reversibility**: loader is pure (returns map · no global state · no side effects beyond fs reads). Replaceable without touching invocation path.

### FR-2 · Runtime composition (`src/substrate/runtime.ts`)

**Goal**: per loaded construct, compose the Effect Layer from declared `requirements[].tag`. Use `ManagedRuntime.make(layer)` to build a runtime. The runtime composition happens **worker-side** (per FR-5 · Option A); FR-2 specifies the composition contract regardless of where it runs.

**Capability rule** (per Codex review #2 · invariant 8 sharpening):

The Layer the runtime composes contains exactly these services:

| Service Tag | Source | Capability classification |
|---|---|---|
| `ModelRunner` | FR-3 layer | **Capability-bound** — MUST appear in `construct.yaml#requirements[].tag` to be provided |
| `EventWriter` | FR-4 layer | **Capability-bound** — MUST appear in `construct.yaml#requirements[].tag` to be provided |
| `Logger` | Effect default | **Ambient (exempt allowlist)** — provided unconditionally; no I/O capability (writes to host stderr, not user-controllable channels) |
| `Clock` | Effect default | **Ambient (exempt allowlist)** — provided unconditionally; pure (read-only wall clock); no capability that could be smuggled |

**Ambient allowlist invariant**: ONLY `Logger` and `Clock` are ambient. Adding any service to the ambient set requires a doctrine-level amendment + re-review of invariant 8. The loader MUST NOT inject any Tag outside `{ModelRunner, EventWriter, Logger, Clock}`. Any unknown Tag declared in `requirements[]` → `UnknownRequirementError` at runtime construction.

**Lifecycle model** (per-worker per-construct cache + dispose-broadcast — per Codex iteration-2 review #3):

- **Cache scope**: each worker_thread maintains its own `Map<slug, ManagedRuntime>`. The interactive lane has 2 workers; on first invoke of construct X in worker N, runtime N composes X's Layer + creates the ManagedRuntime, caches by slug. Subsequent invokes of X in worker N reuse the cached runtime (no Layer reconstruction).
- **Routing**: NO sticky routing by slug. WorkerPool's existing per-session fair scheduling decides which worker handles a given invoke. Either worker may compose any construct's runtime independently. Trade-off: 2× Layer construction cost on first cross-worker invoke; benefit: WorkerPool scheduling stays unchanged.
- **Dispose triggers**: parent broadcasts `{type:"dispose-runtime", slug}` to ALL workers when (a) JWT TTL expires for that construct, OR (b) `.loa.config.yaml` reload removes/changes the construct entry. Each worker drops the cached runtime + calls `runtime.dispose()`.
- **Lifecycle test (gates Sprint 2 close)**: spin up 2 workers, invoke construct X in both, verify each worker built a runtime independently; trigger dispose broadcast, verify both workers dropped their cached runtime; invoke again, verify recomposition.

NOT per-invocation: Layer construction is expensive (cycle-1 doctrine §12).

### FR-3 · ModelRunner Layer (`src/substrate/model-runner-layer.ts`)

**Goal**: build an Effect Layer that provides the `ModelRunner` Tag. The Layer's `complete()` impl, when called inside the worker, sends a parent-bridge message (per FR-5 protocol); the parent invokes `src/hounfour/cheval-invoker.ts` and posts the result back. Worker-side, the Effect program awaits the parent reply transparently.

**Cross-pack Tag identity contract** (per Codex review #6 · the load-bearing integration point):

The construct's Effect program (e.g., `gradeLoreEssay` in `construct-lore-essay-grader/src/grader.ts`) declares its required Tag as `Context.Tag("ModelRunner")<ModelRunner, {...}>()`. The loader's Layer MUST provide a Tag that matches it across the cross-pack boundary. The contract:

| Element | Required value | Notes |
|---|---|---|
| **Context.Tag key string** | `"ModelRunner"` (exact, case-sensitive) | Effect's tag-matching is by string identifier |
| **Service interface** | `{ complete: (params: { systemPrompt: string; userMessage: string }) => Effect.Effect<string, ModelRunnerError> }` | Field names + types must match what the construct declares |
| **Error shape** | `class ModelRunnerError { readonly _tag = "ModelRunnerError"; constructor(readonly reason: string, readonly cause?: unknown) {} }` | `_tag` discriminator MUST be `"ModelRunnerError"` to match construct's pattern-matching |

**Required Sprint 3 integration test** (gates Sprint 3 close):
- Import `gradeLoreEssay` from local file path resolution to `~/Documents/GitHub/construct-lore-essay-grader/src/grader.ts`
- Provide loader-built `ModelRunner` Layer with mocked cheval response
- Verify the Effect resolves to a typed `LoreEssayOutput` (no Tag-not-provided errors)
- Verify error path: when cheval throws, the Effect fails with the construct's expected `ModelRunnerError` shape

### FR-4 · EventWriter Layer (`src/substrate/event-writer-layer.ts`)

**Goal**: build an Effect Layer that provides the `EventWriter` Tag. The Layer's `publish()` impl, when called inside the worker, sends a parent-bridge message (per FR-5 protocol); the parent invokes the existing EventStore append-only writer (`src/events/writer.ts`) and posts the result back. Subject naming follows `{aggregate}.{noun}.{verb}` convention. Envelope fields per `src/events/types.ts` (event_id, event_type, timestamp, correlation_id, sequence, checksum, schema_version, payload).

**Tag identity contract** (same shape as FR-3):
- Context.Tag key string: `"EventWriter"` (exact)
- Service interface: `{ publish: (subject: string, payload: unknown) => Effect.Effect<void, EventWriterError> }`
- Error shape: `class EventWriterError { readonly _tag = "EventWriterError"; constructor(readonly reason: string, readonly cause?: unknown) {} }`

**Cycle-032 ships ONLY the EventStore impl.** Per Codex review #4 + §4 BARTH cut:
- NO `kafka.enabled` config branch in the loader
- NO `KafkaWriter` factory or class shipped
- NO Kafka consumer
- NO `@confluentinc/kafka-javascript` (or kafkajs) dependency added in this cycle
- The Layer interface stays transport-agnostic so Phase 3 can swap implementations without changing consumers — but Phase 3 work is its own cycle

### FR-5 · Sandbox bridge (`src/substrate/sandbox-bridge.ts` + `src/substrate/worker-runtime.ts` (NEW) + minor `src/agent/sandbox-worker.ts` envelope-handling additions)

**Architectural decision (resolved)**: **Option A — worker-side runtime + parent-bridge proxies for capability-bound services.** This matches build doc §7 data-flow diagram. Sprint plan Task 5.2 OPEN QUESTION is closed by this PRD.

**Module ownership** (per Codex iteration-2 review #2 · respects §4 BARTH cut "no Effect-TS adoption in src/agent"):

| File | Imports Effect? | Responsibility |
|---|---|---|
| `src/agent/sandbox-worker.ts` (modified) | ❌ NO | Receives `{type:"substrate-invoke", ...}` envelope. Validates `modPath` against jail. Validates envelope shape. Delegates to `src/substrate/worker-runtime.ts` for everything else. |
| `src/substrate/worker-runtime.ts` (NEW) | ✅ YES (Effect lives here) | Imports the construct's Effect entry. Composes Layer (FR-2 capability rule). Creates ManagedRuntime + holds the per-worker per-construct cache (FR-2 lifecycle). Runs `runtime.runPromise(program(input))`. Marshals result envelope back. |
| `src/substrate/sandbox-bridge.ts` (NEW) | ❌ NO Effect (parent uses Promise-based runtime) | Parent-side dispatcher. Maps WorkerPool messages → cheval-invoker / EventStore calls → posts results back. |

This containment satisfies §4 BARTH cut: Effect-TS lives in `src/substrate/` only. `src/agent/sandbox-worker.ts` stays Effect-free.

**Execution model**:

```
Parent process                              Worker thread (sandboxed)
─────────────                               ─────────────────────────
sandbox-bridge.ts (NEW · no Effect):        sandbox-worker.ts (modified · no Effect):
  bridgeInvoke(loaded, runtimeOpts, input)    1. Receive {type:"substrate-invoke", ...}
    → WorkerPool.exec({                       2. Validate modPath against jail
         type: "substrate-invoke",                + envelope shape
         modPath: loaded.entryPath,           3. Delegate to worker-runtime.ts:
         exportName: ...,                            ↓
         input,                              worker-runtime.ts (NEW · Effect lives here):
         runtimeOpts: {agentId, ...}          4. import(pathToFileURL(modPath))
       }, "interactive")                      5. Compose Layer worker-side:
                                                   - ModelRunner Layer →
  ← {type:"result", jobId, result}                  proxies via postMessage(modelrunner.req)
                                                 - EventWriter Layer →
                                                   proxies via postMessage(eventwriter.req)
                                                 - Logger / Clock: Effect defaults
                                              6. ManagedRuntime.make(layer) + cache by slug
                                              7. runtime.runPromise(program(input))
                                              8. postMessage({type:"result", jobId, result})

Parent handles bridge requests:
  on(modelrunner.req):
    → chevalInvoke(req.completionRequest)
    → postMessage(modelrunner.res, jobId, ...)
  on(eventwriter.req):
    → eventStore.append(req.envelope)
    → postMessage(eventwriter.res, jobId, ...)
```

**Bridge serialization contract** (structured-clone-safe · per Codex iteration-2 review #4):

Worker messages cross the parent↔worker boundary via Node's `postMessage`, which uses the HTML structured-clone algorithm — NOT JSON serialization. The bridge contract:

| Field | Allowed types | Schema |
|---|---|---|
| Envelope `type` | string discriminator | `Schema.Literal("substrate-invoke" \| "result" \| "modelrunner.req" \| "modelrunner.res" \| "eventwriter.req" \| "eventwriter.res" \| "dispose-runtime")` |
| Envelope `jobId` | string (UUID) | `Schema.UUID` |
| Envelope `payload` | structured-clone-safe data: plain objects, arrays, strings, numbers, booleans, null, undefined, Date, RegExp, Map, Set, ArrayBuffer, typed arrays | `Schema.Unknown` validated per `type` discriminant (see schemas below) |

**Forbidden in messages** (rejected at envelope-validation):
- Function objects (closures cannot cross worker boundary)
- Live Effect services or Layers (Effect runtime is worker-local; no live runtime crosses)
- Live Promises (use jobId-based async correlation instead)
- DOM nodes
- New MessagePort or MessageChannel transferred (only the implicit parent↔worker channel is allowed; any additional MessagePort → reject)

**Type-specific payload schemas** (gates Sprint 5 close):
- `substrate-invoke.payload`: `{modPath: string, exportName: string, input: unknown, runtimeOpts: {agentId, tenantId, poolId, modelId, tier}}`
- `result.payload`: validated against `SubstrateStepVerdict` (cycle-1 protocol contract version 1.0.0)
- `modelrunner.req.payload`: `{completionRequest: <CompletionRequest TypeBox>}`
- `modelrunner.res.payload`: `{text: string} | {error: ModelRunnerError}`
- `eventwriter.req.payload`: `{envelope: <EventEnvelope per src/events/types.ts>}`
- `eventwriter.res.payload`: `{ok: true} | {error: EventWriterError}`
- `dispose-runtime.payload`: `{slug: string}`

**Note**: Effect Schema's `Schema.Date`, `Schema.MapFromSelf`, `Schema.SetFromSelf`, etc. handle structured-clone-safe types in payload schemas. JSON-serialization is NOT the contract; the worker thread's runtime is Node, and structured-clone is the native channel.

**Acceptance tests** (per FR-5 + iteration-2 HIGH narrowing):
- `sandbox-bridge.integration.test.ts`: substrate invocation runs in interactive lane (worker 1 or 2 occupied during invoke)
- **modPath jail enforced**: loader/sandbox-worker rejects `substrate-invoke` envelope with `modPath` outside the realpath-canonicalized packs dir → `EntryResolutionError` / envelope-validation error
- **Bridge capability bounds enforced**: a construct that did NOT declare `EventWriter` in its `requirements[]` cannot trigger an `eventwriter.req` from inside its Effect program — the runtime's Layer composition (FR-2 capability rule) makes the Tag literally unavailable
- Worker survives + accepts next invocation after first completes
- Structured-clone enforcement: attempt to send a function in a bridge envelope → envelope validation fails
- ModelRunner parent-bridge round-trip: worker calls `runner.complete(...)`, parent receives proxy request, returns mocked response, worker resolves Effect

**What `trust:internal` does NOT enforce** (HONEST SCOPE per iteration-2 HIGH finding):

`trust:internal` (this cycle's only tier) protects two things:
1. **modPath realpath containment** — a construct can only be loaded from inside the configured packs dir
2. **Bridge capability bounds** — a construct's Effect program can only call services declared in its `requirements[]`

`trust:internal` does NOT block direct Node built-in access from inside imported construct code. A construct that imports `node:fs` and calls `fs.readFileSync('/etc/hosts')` will succeed — Node `worker_threads` share the host's permissions; `worker_threads` is a thread-isolation primitive, not an OS-level sandbox. **The mitigation at `trust:internal` is build-time trust, not runtime isolation**: substrate-constructs at this tier are first-party / vetted; misbehavior is a build-time review failure, not a runtime defense failure.

Hardening this gap (process-level isolation, `node --experimental-permission`, `isolated-vm`, subprocess+microVM) is `trust:vendor` and `trust:untrusted` work — explicitly deferred per §4 BARTH cut.

**Pre-Sprint-5 operator pair-point**: ✅ **RESOLVED** by this PRD revision (Option A — worker-side runtime + parent-bridge proxies, per the module ownership table above + the structured-clone-safe bridge contract above). Sprint 5 author proceeds with this protocol; further changes require re-review.

### FR-6 · CLI surface + programmatic API (`src/substrate/cli.ts` + `index.ts`)

**Goal**: expose `loa-finn substrate-construct invoke <slug> --input <file>` for operator dev/debug, and `Substrate.invoke(slug, input)` programmatic API for cycle-3 freeside-quests/apps/api consumers.

**ALEXANDER craft (CLI surface only)**:
- **stdout**: JSON only, machine-parseable, matches `SubstrateStepVerdict` Effect Schema
- **stderr**: human progress (≤80 char width, `Loading...` / `Composing...` / `Invoking...` prefixes)
- **color-as-information**: ONLY status. APPROVED green, REJECTED red, NEEDS_HUMAN yellow. Confidence numerics stay default-foreground.
- **monospace numerics**: `tabular-nums` (terminal-equivalent: align right)
- **silence**: NO emoji, NO progress bars, NO decorative animation
- **exit codes**: 0 APPROVED · 1 REJECTED · 2 NEEDS_HUMAN · 3+ system error

For the `Substrate.invoke()` programmatic API: NO craft applies. The TYPES are the API.

### FR-7 · End-to-end test + doctrine update

**Goal**: prove cycle-032 ships green with a real construct + mocked LLM.

**Test**: `src/substrate/__tests__/e2e.test.ts`:
1. Loader scans a fixture packs dir
2. Finds `construct-lore-essay-grader` (symlinked or copied to fixture)
3. Builds runtime with `TestModelRunner` Layer (canned response — replaces parent-bridge cheval-invoker proxy in test mode)
4. CLI invokes with a sample essay
5. Verdict returned · matches expected

**Doctrine §13**: write to `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md` §13 "Cycle-2 substrate-runtime first execution learnings". What was proven (loader · ManagedRuntime per construct worker-side · Tag-identity bridging · parent-bridge proxy pattern · sandbox compatible). What was deferred (Kafka transport · vendor/untrusted tiers · per-invocation introspection).

**Memory entry**: extend cycle-1 memory entry with cycle-2 sub-section OR write new memory file under `grimoires/loa/memory/`.

---

## 3. Non-Functional Requirements (Invariants — OSTROM)

These MUST NOT change during cycle-032. Cycle-1 sealed several at the contract layer; cycle-032 must respect them:

1. **Effect-program construct contract**: `(input: I) => Effect<O, E, R>` where `I` and `O` are Effect Schemas declared in `executable.protocol.input/output` and `R` is the union of declared `requirements[].tag` Effect Tags. *Cycle-1 sealed; cycle-032 must not change.*

2. **`construct.yaml` manifest schema**: `type: substrate-construct` requires `executable.entry`, `executable.export`, `executable.protocol.input`, `executable.protocol.output`, `runtime.engine`. *Loader trusts the schema; doesn't add new required fields without amendment to construct-base + loa-constructs.*

3. **Hounfour CompletionRequest/Result contract** (TypeBox): agent-network wire format. *Loader's ModelRunner parent-bridge handler wraps `cheval-invoker.ts` — does NOT modify the wire format.*

4. **Sandbox + worker-pool isolation** (HONEST SCOPE per Codex iteration-2 review HIGH): `ToolSandbox.execute()` + worker_threads + realpath-canonicalized modPath jail (loader-level) + bridge capability bounds (runtime-level). *Substrate-constructs RIDE this; loader does NOT bypass. Per FR-5 Option A: runtime + Layer composition + Effect program execution all happen worker-side; only structured-clone-safe data crosses the worker boundary via the typed bridge.* **What this cycle's `trust:internal` tier does NOT enforce**: direct Node built-in access (e.g., `import("node:fs")`) from inside imported construct code. `worker_threads` is a thread-isolation primitive, not an OS-level sandbox. Mitigation at `trust:internal` is build-time vetting (constructs are first-party); runtime isolation against built-ins is `trust:vendor`/`trust:untrusted` work, deferred per §4. See FR-5 "What `trust:internal` does NOT enforce" for the full scope statement.

5. **EventStore append-only contract** (`src/events/writer.ts` + `src/events/types.ts` · per codebase survey §4 · NOT `src/persistence/` which holds WAL+r2-sync+git-sync): substrate-constructs publish via the existing EventWriter interface (parent-bridged from worker per FR-5). *Kafka becomes a parallel adapter (Phase 3); EventStore stays as fallback / dev impl.*

6. **JWT licensing** (per `.claude/protocols/constructs-integration.md` in loa-constructs): RS256 validation at load-time, cached refresh per FR-1 contract (cache by `(fingerprint, kid)`, TTL `min(exp-now, 1h)`, recheck exp/nbf on cached read, reject beyond tier grace). *Loader uses the SAME validation flow as existing skill-pack loader.*

7. **Substrate-step protocol contract version 1.0.0**: `SubstrateStepSubmission/Verdict` shapes are frozen. *Loader does NOT extend or wrap them; it transports them.*

8. **Capability-bounded Layer principle** (sharpened per FR-2 capability rule): a construct can only do what its declared Requirements allow. The Tag set IS the capability set, with one exception: `Logger` and `Clock` are ambient (exempt allowlist) because they have no I/O capability and are required for Effect to function. **No other Tag may be added to the ambient set without doctrine amendment + invariant-8 re-review.** Loader MUST NOT inject Tags the construct didn't declare beyond `{Logger, Clock}`.

---

## 4. Out of Scope (BARTH cuts — explicit)

Each of these is deferred. Naming them prevents scope creep mid-cycle:

- ❌ **Kafka cluster setup, KafkaWriter Layer, Kafka consumer, kafka.enabled config branch, `@confluentinc/kafka-javascript` dependency** — `event-writer-layer.ts` ships ONLY the EventStore impl. Kafka work is Optional Sprint 8 / Phase 3 (its own cycle).
- ❌ **OS-level / process-level isolation of construct code from Node built-ins** (per Codex iteration-2 review HIGH) — substrate-constructs at `trust:internal` can directly `import("node:fs")` etc. The mitigation is build-time trust (constructs are first-party / vetted), NOT runtime isolation. Hardening this requires `node --experimental-permission`, `isolated-vm`, or subprocess+microVM — all `trust:vendor`/`trust:untrusted` work.
- ❌ **`trust:vendor` and `trust:untrusted` isolation tiers** — only `trust:internal` ships (worker_threads + capability-bounded Layer + parent-bridge proxies). isolated-vm + subprocess+microVM are Phase 3.
- ❌ **Per-invocation JWT introspection** — load-time RS256 + cached TTL (per FR-1 contract) is sufficient. Threat model justification gates the upgrade.
- ❌ **Construct-creation tooling** — operators author `construct.yaml` + `src/grader.ts` by hand. Templating is its own cycle.
- ❌ **cubquests-interface integration** — separate cycle (cycle-1 §12.4 deferred work).
- ❌ **Real-LLM ModelRunner** — `TestModelRunner` suffices for sprint 7 e2e. `AnthropicModelRunner` is its own micro-cycle (1-2hr).
- ❌ **No new Effect-TS adoption in `src/agent` or `src/hounfour`** — Effect lives in `src/substrate/` only. Promise-based runtime stays.
- ❌ **No multi-construct composition recipe** — single-construct invocation only. loa-compositions YAML chaining is operator's §10b four-tier "composition" layer · its own future work.
- ❌ **No `registry.constructs.network` publishing** — substrate-constructs install via filesystem pack OR via the existing `/loa constructs install` command (unchanged for this cycle).
- ❌ **No additional ambient Effect services beyond Logger and Clock** — adding any Tag to the ambient allowlist is a doctrine amendment, not in-cycle work.

---

## 5. Success Criteria (Verify checklist for cycle-032 close)

After Sprint 7 ships, each item must be verifiable by the named test or artifact (per Codex review #7):

| # | Criterion | Verifying test/artifact |
|---|---|---|
| 5.1 | Loader scans `.loa.config.yaml#substrate.constructs_dir` and finds `construct-lore-essay-grader` | `loader.test.ts` — fixture packs dir + assert registry contains slug |
| 5.2 | Loader validates manifest against just-merged loa-constructs Zod schema · rejects bad manifests | `loader.test.ts` — bad-manifest fixtures (missing `executable.entry`, missing `runtime.engine`, etc.) → assert `ManifestValidationError` |
| 5.3 | Loader validates JWT license · respects grace periods (FR-1 cache contract) | `jwt-validator.test.ts` — fake-clock test matrix (valid, not-yet-valid, expired-within-grace, expired-beyond-grace, key-rotation, LOA_OFFLINE=1) |
| 5.4 | Runtime composes Layer with capability-bounded Tags only (FR-2 capability rule) | `runtime.test.ts` — assert undeclared Tag throws `UnknownRequirementError`; assert ambient set is `{Logger, Clock}` only |
| 5.5 | ModelRunner Layer correctly wraps cheval-invoker via parent-bridge | `model-runner-layer.test.ts` (unit, mocked bridge) + Sprint 3 integration test importing `gradeLoreEssay` |
| 5.6 | EventWriter Layer correctly wraps EventStore via parent-bridge | `event-writer-layer.test.ts` — assert envelope matches `src/events/types.ts` shape (event_id/event_type/timestamp/correlation_id/sequence/checksum/schema_version/payload) |
| 5.7 | Substrate invocation runs inside worker_threads sandbox (filesystem jail enforced) | `sandbox-bridge.integration.test.ts` — fixture construct attempts `fs.readFileSync('/etc/hosts')` → assert error |
| 5.8 | Structured-clone invariant enforced (FR-5) | `sandbox-bridge.test.ts` — attempt to send Function in bridge message → assertion fires; envelope schema validation passes/fails as expected |
| 5.9 | CLI command `loa-finn substrate-construct invoke <slug>` returns typed verdict | `cli.test.ts` — exec subprocess, capture stdout JSON, parse against `SubstrateStepVerdict` schema; assert exit codes (0/1/2/3+) per status |
| 5.10 | Programmatic API `Substrate.invoke()` returns typed verdict | covered by `e2e.test.ts` |
| 5.11 | End-to-end test: real `construct-lore-essay-grader` pack + `TestModelRunner` + verdict matches expected | `e2e.test.ts` — see FR-7 |
| 5.12 | Doctrine §13 cycle-2 first-execution-learnings filled in | File assertion: `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md` contains heading `## §13 · Cycle-2 substrate-runtime first execution learnings` with content (not just placeholder) |
| 5.13 | Memory entry shipped | File assertion: new file under `grimoires/loa/memory/` named `project_substrate_layer_runtime_cycle_002_shipped.md` (or similar) exists with non-empty content |
| 5.14 | Kafka adapter NOT shipped (BARTH cut held — Phase 3) | `git diff main..HEAD -- src/substrate/` does NOT contain `KafkaWriter`, `kafka.enabled`, `kafkajs`, `@confluentinc/kafka-javascript`; `package.json` does NOT add Kafka deps |

**Optional V1.5 deferred**:
- Kafka adapter + consumer (`@confluentinc/kafka-javascript`)
- `AnthropicModelRunner` Layer (real LLM smoke)
- cubquests-interface `OffchainStepConfig.verificationType` `"construct"` integration
- `trust:vendor` isolation tier

---

## 6. Coordination & Operator Pair-Points

**Persona**: OSTROM leads (substrate runtime is structural, not visual). ALEXANDER on standby for CLI craft (§5.6 / FR-6 only). BARTH on standby for scope cuts.

**Sprint cadence**: 7 sprints serial. Each 1-3 hours. Sprint 5 sandbox spike was the load-bearing gate — already GREEN (`scripts/substrate-spike.mjs`).

**Operator pair-points** (per build doc §13 + Codex review #1 addition):

| Gate | Status | Description |
|------|--------|-------------|
| Pre-Sprint-1 | ✅ resolved | Loader directory location confirmed: `src/substrate/` |
| Mid-Sprint-3 | 🟡 PAIR-POINT | ModelRunner Tag identity bridge (cross-pack Tag matching) — review the integration test importing real `gradeLoreEssay` before merging Sprint 3 |
| **Pre-Sprint-5** | ✅ **resolved by this PRD** | Runtime placement decided: **Option A — worker-side runtime + parent-bridge proxies**. See FR-5 for protocol. Further changes require re-review. |
| Pre-Sprint-7 | 🟡 PAIR-POINT | E2E test fixture choice (real `construct-lore-essay-grader` OR simplified test pack) |
| Post-Sprint-7 | 🟡 PAIR-POINT | Doctrine §13 draft review |

**Branches**: feature branch per sprint (`feat/substrate-runtime-sprint-N-<slug>`). PRs gated on tests + Bridgebuilder review.

**No merge to main without**: loader + runtime + ModelRunner + EventWriter + sandbox-bridge + CLI all green individually + e2e green.

**Cross-repo (read-only this cycle)**:
- `loa-constructs` — for `construct.yaml` schema validation reference
- `construct-lore-essay-grader` — the e2e test fixture (instance-1)
- `construct-base` — JSON Schema reference

---

*Drafted 2026-05-03 PM (v1.0.0). Iteration 2 (v1.1.0) applies cross-model review findings: Option A architectural decision for runtime placement, JWT cache contract pinning, Tag-identity precision, structured-clone invariant, ambient-allowlist clarification, Kafka scope discipline, observable success criteria. Build doc remains canonical for code samples and detailed component specs.*
