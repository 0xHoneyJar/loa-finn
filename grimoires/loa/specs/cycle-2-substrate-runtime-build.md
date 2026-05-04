# Cycle-2 Substrate Runtime — Finn Loader + Effect Bridge + Kafka Path

> **Mode**: ARCH (OSTROM) + craft lens (ALEXANDER · for operator-facing surfaces) + SHIP discipline (BARTH · scope cut at end)
> **Date**: 2026-05-03
> **Cycle**: cycle-2 substrate-runtime
> **Prior cycle**: cycle-1 substrate-integration shipped 2026-05-03 (3 PRs merged · doctrine §12 · construct-lore-essay-grader instance-1 published)
> **Target repo**: loa-finn (where the loader lives)
> **Companion repos** (read-only this cycle): loa-constructs (for construct.yaml schema validation), construct-lore-essay-grader (the test fixture · instance-1)

> **One-line context**: cycle-1 shipped the substrate ABI + manifest contract + first instance + in-process pipeline. cycle-2 ships the *runtime* — the bridge that loads an Effect-program construct from a filesystem pack, composes its declared Requirements via ManagedRuntime, runs it inside the existing Finn worker-thread sandbox, and routes inputs/outputs through the EventStore (with Kafka as a Phase-3 adapter on the same EventWriter interface).

---

## §1 · Context

### What cycle-1 shipped (read this section · the sealed boundaries)

- **`@freeside-quests/protocol`** — Effect Schema for `SubstrateStepSubmission` (gateway → construct envelope) and `SubstrateStepVerdict` (construct → listener envelope). Contract version 1.0.0. Discriminated payload union (`essay | url | structured`).
- **`construct-lore-essay-grader`** (repo) — instance-1 of `type: substrate-construct`. Pure Effect program `gradeLoreEssay(input): Effect<LoreEssayOutput, GraderParseError | ModelRunnerError, ModelRunner>`. BORGES persona. 3 grading dimensions.
- **construct-base/schemas/construct.schema.json** — JSON Schema accepts `type: substrate-construct` + `runtime/executable/requirements/streams` fields with `oneOf` admitting cycle-002 string-shape AND substrate object-shape on streams.
- **loa-constructs/packages/shared/src/validation.ts** — Zod manifest schema with `superRefine` enforcing `executable + runtime + runtime.engine + executable.protocol.input + executable.protocol.output` when `type === 'substrate-construct'`.
- **`@freeside-quests/engine`** — `dispatchEssayQuest` Plane-3 bridging logic. **In-process** this cycle (`Effect.runPromise` direct call). Construct OPENED via parameter — freeside-quests doesn't bind to a specific grader.

### What cycle-2 must ship

The **substrate-construct runtime layer**: a loader living in loa-finn that takes a construct slug + an input, finds the pack on the filesystem, dynamic-imports the Effect entry, composes the right Layer (with concrete impls for declared Requirements), runs the Effect program inside the existing sandbox, and returns the typed verdict to the caller.

This closes the operator-named gap from cycle-1's doctrine §12.1 correction #5: *"the substrate-construct runtime layer is genuinely aspirational at the framework level"*. Cycle-2 makes it real.

### What cycle-2 explicitly does NOT ship (BARTH discipline · §11 below)

- Kafka deployment (the adapter ships behind a flag · actual Kafka cluster + topic provisioning is Phase 3 of cycle-2)
- `trust:vendor` and `trust:untrusted` isolation tiers (only `trust:internal` ships — worker_threads + capability-bounded Layer)
- Per-invocation JWT introspection (load-time RS256 + cached TTL is sufficient)
- Construct-creation tooling (operators create constructs by hand · automation is its own cycle)
- cubquests-interface integration (separate cycle · cycle-1 §12.4 deferred work)
- Real-LLM AnthropicModelRunner impl (separate cycle · would gate on this loader being live)

---

## §2 · Invariants (OSTROM · these MUST NOT CHANGE during cycle-2)

1. **Effect-program construct contract**: `(input: I) => Effect<O, E, R>` where `I` and `O` are Effect Schemas declared in the construct's `executable.protocol.input/output` and `R` is the union of declared `requirements[].tag` Effect Tags. Cycle-1 sealed this; cycle-2 must not change it.

2. **construct.yaml manifest schema** (just merged): `type: substrate-construct` requires `executable.entry`, `executable.export`, `executable.protocol.input`, `executable.protocol.output`, `runtime.engine`. Loader trusts the schema; doesn't add new required fields without amendment to construct-base + loa-constructs.

3. **Hounfour CompletionRequest/Result contract**: agent-network wire format (TypeBox). Loader's ModelRunner Layer wraps `cheval-invoker.ts` — does NOT modify the wire format.

4. **Sandbox + worker-pool isolation** (per cycle-002 surveys): `ToolSandbox.execute()` + filesystem jail (realpath canonicalization) + command allowlist + worker_threads. Substrate-constructs RIDE this; loader does NOT bypass the sandbox.

5. **EventStore append-only contract** (`src/events/writer.ts` + `src/events/types.ts` · per codebase survey §4 · NOT `src/persistence/` which holds WAL+r2-sync+git-sync): substrate-constructs publish via the existing EventWriter interface. Kafka becomes a parallel adapter (Phase 3); EventStore stays as fallback / dev impl.

6. **JWT licensing** (per `.claude/protocols/constructs-integration.md` in loa-constructs): RS256 validation at load-time, cached refresh per invocation, grace periods per tier (individual 24h · pro 24h · team 72h · enterprise 168h). Loader uses the SAME validation flow as existing skill-pack loader.

7. **Substrate-step protocol contract version** (1.0.0): `SubstrateStepSubmission/Verdict` shapes are frozen. Loader does NOT extend or wrap them; it transports them.

8. **Capability-bounded Layer principle**: a construct can only do what its declared Requirements allow. If `FileSystem` Tag isn't in the loader-built Layer, the Effect program literally cannot do filesystem I/O. The Tag set IS the capability set. Loader MUST NOT inject Tags the construct didn't declare.

---

## §3 · Persona (load these in fresh session)

```
.claude/constructs/packs/the-arcade/identity/OSTROM.md     # ARCH lead
.claude/constructs/packs/artisan/identity/ALEXANDER.md     # craft lens (CLI surface)
.claude/constructs/packs/the-arcade/identity/BARTH.md      # ship discipline (V1 vs V2)
```

Read each before authoring. **OSTROM leads** — the substrate runtime is structural, not visual. ALEXANDER applies only to the operator-facing CLI command output (terse · scannable · cite-specifics). BARTH on standby for scope cuts.

---

## §4 · Load Order (read in this order before authoring)

| # | File | Why |
|---|---|---|
| 1 | `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md` §12 | Cycle-1 first-execution learnings · the 5 doctrine corrections + operator's "constructs are agents" reframe |
| 2 | `grimoires/loa/specs/cycle-2-substrate-runtime-codebase-survey.md` (this repo) | What exists in loa-finn today · 5 load-bearing findings |
| 3 | `grimoires/loa/specs/cycle-2-substrate-runtime-landscape.md` (this repo) | Effect-TS pattern (ManagedRuntime) · Kafka client (CJSK) · isolation model (3-tier opt-in) recommendations |
| 4 | `src/agent/sandbox.ts` + `src/agent/worker-pool.ts` | Sandbox primitives substrate-constructs ride |
| 5 | `src/hounfour/cheval-invoker.ts` | Model invocation entry — ModelRunner Layer wraps this |
| 6 | `src/events/writer.ts` + `src/events/types.ts` (per codebase survey §4 — EventWriter API + EventEnvelope shape) | EventWriter interface — KafkaWriter adapter wraps this |
| 7 | `~/Documents/GitHub/construct-lore-essay-grader/construct.yaml` | The first instance manifest — loader must parse + load + invoke this end-to-end |
| 8 | `~/Documents/GitHub/construct-lore-essay-grader/src/grader.ts` | The Effect program shape (Tag/Layer/Effect.gen patterns) |
| 9 | `~/Documents/GitHub/loa-constructs/.claude/protocols/constructs-integration.md` | JWT licensing flow (RS256 · grace periods) — loader reuses this |
| 10 | `~/Documents/GitHub/loa-constructs/packages/shared/src/validation.ts` | Zod manifest schema · loader validates against this |

---

## §5 · Architecture · Component Specifications

### §5.1 · `src/substrate/` (NEW directory)

The loader's home. Co-locates substrate-specific code so substrate concerns don't leak into `src/agent/` (skill-pack-shaped) or `src/hounfour/` (model invocation). Matches OSTROM's "isolation is the architecture" principle.

```
src/substrate/
├── loader.ts                # filesystem scan + manifest validation + dynamic import
├── registry.ts              # in-memory map: slug → manifest + entry-import-promise
├── runtime.ts               # per-construct ManagedRuntime composition
├── model-runner-layer.ts    # Effect Layer wrapping cheval-invoker
├── event-writer-layer.ts    # Effect Layer wrapping EventStore (KafkaWriter adapter Phase 3)
├── jwt-validator.ts         # reuses constructs-integration.md flow
├── cli.ts                   # `substrate-construct invoke` command
├── types.ts                 # internal types (manifest decoded · entry signature)
└── __tests__/
    ├── loader.test.ts
    ├── runtime.test.ts
    ├── model-runner-layer.test.ts
    └── event-writer-layer.test.ts
```

### §5.2 · `loader.ts`

**Responsibility**: at startup, scan `.loa.config.yaml#substrate.constructs_dir` (default `~/.loa/constructs/packs/`) for directories containing `construct.yaml` with `type: substrate-construct`. For each:
1. Read + parse construct.yaml
2. Validate against `@loa-constructs/shared` Zod schema (the just-merged loa-constructs#223 superRefine)
3. Validate JWT license at `.license.json` (RS256 · per constructs-integration.md)
4. Resolve `executable.entry` to absolute path (under pack root)
5. Lazy: defer dynamic `import(pathToFileURL(entry))` to first invocation
6. Add to in-memory registry

**Interface**:
```typescript
// src/substrate/loader.ts
export interface LoadedConstruct {
  slug: string;
  manifest: ValidatedPackManifest;  // from @loa-constructs/shared
  entryPath: string;                 // absolute path
  loadModule: () => Promise<Record<string, unknown>>;  // memoized dynamic import
  license: ValidatedLicense;         // from JWT validator
}

export async function loadConstructsFromFilesystem(opts: {
  packsDir: string;
  jwtPublicKeyResolver: (kid: string) => Promise<string>;
}): Promise<Map<string, LoadedConstruct>>;
```

**Failure modes** (typed):
- `ManifestParseError` — yaml malformed
- `ManifestValidationError` — schema rejected (with Zod issues array)
- `LicenseError` — JWT missing / invalid / expired beyond grace
- `EntryResolutionError` — `executable.entry` path traversal or missing file

**Reversibility**: loader is pure (returns map · no global state · no side effects beyond fs reads). Tests provide mock filesystem + mock JWT resolver. Loader can be replaced without touching invocation path.

### §5.3 · `runtime.ts`

**Responsibility**: per loaded construct, compose the Effect Layer from declared `requirements[].tag`. Use `ManagedRuntime.make(layer)` to build a runtime that:
- Provides ModelRunner Tag (via `model-runner-layer.ts`)
- Provides EventWriter Tag (via `event-writer-layer.ts`)
- Provides Logger Tag (Effect's default Logger)
- Provides Clock Tag (Effect's default Clock)
- Refuses to provide any Tag NOT in the construct's declared requirements (capability-bounded — invariant 8)

**Interface**:
```typescript
// src/substrate/runtime.ts
import { Effect, ManagedRuntime, Layer } from "effect";
import type { LoadedConstruct } from "./loader.js";

export interface ConstructRuntime {
  slug: string;
  invoke: <I, O>(input: I) => Promise<O>;
  dispose: () => Promise<void>;
}

export async function createConstructRuntime(
  loaded: LoadedConstruct,
  opts: {
    modelRunnerLayer: Layer.Layer<unknown>;
    eventWriterLayer: Layer.Layer<unknown>;
  },
): Promise<ConstructRuntime>;
```

**Lifetime**: ManagedRuntime per construct. Created on first invoke. Disposed on unload (config reload OR JWT TTL expiry). NOT per-invocation (Layer construction is expensive).

**Capability check** (invariant 8 enforcement):
- Walk construct.yaml `requirements[].tag` array
- For each, verify the loader has a matching Layer registered
- If construct declares a Tag the loader doesn't recognize → `UnknownRequirementError` at runtime construction
- If construct does NOT declare a Tag the loader would otherwise inject → still inject ONLY what's declared (don't widen the capability set)

### §5.4 · `model-runner-layer.ts`

**Responsibility**: build an Effect Layer that provides `ModelRunner` Tag. The Layer's `complete()` impl wraps `src/hounfour/cheval-invoker.ts`:
1. Build a Hounfour `CompletionRequest` (TypeBox-validated) from the construct's input (system prompt + user message + model_id from the construct's pool tier)
2. Call cheval-invoker (Promise-based)
3. Return the model's text response back to the Effect program

**Bridge shape**:
```typescript
// src/substrate/model-runner-layer.ts
import { Layer, Effect, Context } from "effect";
import { invoke as chevalInvoke } from "../hounfour/cheval-invoker.js";

// Re-declare the Tag on the Finn side that mirrors the construct's expected shape.
// MUST stay in sync with what substrate-constructs declare in their src/grader.ts.
export class ModelRunner extends Context.Tag("ModelRunner")<
  ModelRunner,
  {
    complete: (params: {
      systemPrompt: string;
      userMessage: string;
    }) => Effect.Effect<string, ModelRunnerError>;
  }
>() {}

export class ModelRunnerError {
  readonly _tag = "ModelRunnerError";
  constructor(readonly reason: string, readonly cause?: unknown) {}
}

export const buildModelRunnerLayer = (opts: {
  poolId: string;
  modelId: string;
  agentId: string;
  tenantId: string;
}) =>
  Layer.succeed(ModelRunner, {
    complete: ({ systemPrompt, userMessage }) =>
      Effect.tryPromise({
        try: async () => {
          const result = await chevalInvoke({
            request_id: crypto.randomUUID(),
            agent_id: opts.agentId,
            tenant_id: opts.tenantId,
            model: opts.modelId,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
            contract_version: "1.0.0",
          });
          return result.text;
        },
        catch: (cause) => new ModelRunnerError("hounfour invocation failed", cause),
      }),
  });
```

**Note**: the `ModelRunner` Tag identifier must MATCH what the construct declares (case-sensitive · same module export). If the construct's Tag is identified by `Context.Tag("ModelRunner")` and the Layer's is identified by `Context.Tag("ModelRunner")`, Effect's tag-matching makes them equivalent. Verify this in tests with the actual construct module imported.

### §5.5 · `event-writer-layer.ts`

**Responsibility**: build an Effect Layer that provides `EventWriter` Tag. Wraps the existing EventStore append-only writer (per codebase survey · §3 finding #4). Phase 3 of cycle-2 swaps in a `KafkaWriter` adapter; consumers of the Tag don't change.

**Bridge shape**:
```typescript
// src/substrate/event-writer-layer.ts
import { Layer, Effect, Context } from "effect";
import { EventStore } from "../events/writer.js";  // NOTE: actual public export is `EventWriter` interface; EventEnvelope shape (event_id/event_type/timestamp/correlation_id/sequence/checksum/schema_version/payload) lives in ../events/types.ts. Sprint 4 author binds to those exact names + envelope fields.

export class EventWriter extends Context.Tag("EventWriter")<
  EventWriter,
  {
    publish: (subject: string, payload: unknown) => Effect.Effect<void, EventWriterError>;
  }
>() {}

export class EventWriterError {
  readonly _tag = "EventWriterError";
  constructor(readonly reason: string, readonly cause?: unknown) {}
}

export const buildEventWriterLayer = (eventStore: EventStore) =>
  Layer.succeed(EventWriter, {
    publish: (subject, payload) =>
      Effect.tryPromise({
        try: async () => {
          await eventStore.append({
            stream: subject,        // three-segment dotted subject
            type: "substrate.invocation.result",
            payload,
            occurred_at: new Date().toISOString(),
          });
        },
        catch: (cause) => new EventWriterError("eventstore append failed", cause),
      }),
  });
```

**Phase 3** (deferred): a parallel `buildKafkaWriterLayer(kafkaProducer)` wraps `@confluentinc/kafka-javascript` (or kafkajs fallback). Same Tag, different Layer impl. Loader picks based on `.loa.config.yaml#substrate.kafka.enabled` flag.

### §5.6 · `cli.ts` (operator-facing surface · ALEXANDER craft applies)

**Responsibility**: expose `loa-finn substrate-construct invoke <slug> --input <file>` for operator dev/debug.

**ALEXANDER craft specifications**:
- **Material**: monospace + tabular numerics for verdict.confidence display. No emoji unless operator's terminal config opts in.
- **Rhythm**: 3 sections (input · grading · verdict) with `48px`-equivalent space (4 blank lines) between unrelated · `16px`-equivalent (1 blank line) between related lines.
- **Color-as-information**: ONLY status. APPROVED = green. REJECTED = red. NEEDS_HUMAN = yellow. Confidence numerics stay default-foreground (information density).
- **Output discipline**: Nakamoto protocol — stdout is JSON (parseable), stderr is human progress (`Loading construct lore-essay-grader...`).

```bash
$ loa-finn substrate-construct invoke lore-essay-grader --input ./essay.json
# stderr:
Loading construct lore-essay-grader (license expires 2027-01-15 · pro tier)...
Composing runtime (ModelRunner=hounfour-pool-essay · EventWriter=eventstore)...
Invoking gradeLoreEssay in interactive worker lane (worker 1/2)...
# stdout (JSON):
{
  "submissionId": "01HW7SAMPLE",
  "traceId": "trace-01HW7SAMPLE",
  "status": "APPROVED",
  "confidence": 0.83,
  "reasoning": "...",
  "graderConstructSlug": "lore-essay-grader",
  "gradedAt": "2026-05-04T15:30:42.123Z",
  "dimensions": { "loreFit": 0.85, "voiceMatch": 0.82, "specificity": 0.80 },
  "contractVersion": "1.0.0"
}
# exit code 0 = APPROVED, 1 = REJECTED, 2 = NEEDS_HUMAN, >2 = system error
```

**Programmatic API** (parallel · for freeside-quests/apps/api consumers in cycle-3):
```typescript
import { Substrate } from "@loa-finn/substrate";
const verdict: SubstrateStepVerdict = await Substrate.invoke("lore-essay-grader", input);
```

---

## §6 · Blast Radius (OSTROM · per-feature)

### §6.1 · Loader · Registry · Runtime composition

| Artifact | Change | Risk | Mitigation |
|---|---|---|---|
| `src/substrate/` (NEW) | Entire directory | low (new code) | Isolated from existing src/agent + src/hounfour |
| `src/substrate/loader.ts` | NEW | medium | Defense-in-depth: realpath canonicalization on entry path · JWT validation · Zod schema validation · all failure modes typed |
| `src/substrate/registry.ts` | NEW | low | In-memory only · no global state leaks (factory-built per loader instance) |
| `src/substrate/runtime.ts` | NEW · ManagedRuntime per construct | medium | Capability-bounded Layer · explicit dispose on unload · tested with leak detection |
| `src/substrate/model-runner-layer.ts` | NEW | medium | Wraps existing `cheval-invoker` (no modification to the wrapped function) |
| `src/substrate/event-writer-layer.ts` | NEW | medium | Wraps existing EventStore (no modification) |
| `src/substrate/cli.ts` | NEW · new CLI subcommand | low | Additive command, doesn't change existing CLI surface |
| `package.json` | MODIFIED · add `effect@^3.10.0` peer dep | low | Effect-TS only used in src/substrate · no Finn-wide refactor |
| `.loa.config.yaml` | MODIFIED · add `substrate.constructs_dir`, `substrate.kafka.enabled` | low | Both fields optional with sensible defaults |

### §6.2 · Boundaries crossed (where loader interacts with existing code)

| Boundary | Direction | Risk |
|---|---|---|
| `src/hounfour/cheval-invoker.ts` | loader → cheval | medium (reads its public API · doesn't modify) |
| `src/events/writer.ts` (EventWriter API + types.ts EventEnvelope) | loader → eventstore | low (uses public append API) |
| `src/agent/sandbox.ts` + `worker-pool.ts` | loader → sandbox | medium (substrate-construct invocations route through `ToolSandbox.execute()` · need to validate the worker can dynamic-import) |
| `src/hounfour/pool-registry.ts` | loader reads | low (read-only · matches construct's `model_tier` to pool) |

**The load-bearing boundary** (highest risk): worker_threads + dynamic-import. Spike this FIRST in §10 build sequence. Some sandbox configurations restrict dynamic-import; if the existing worker-pool does, the loader needs to either (a) extend the worker's import allowlist for substrate-construct entries OR (b) compose the Effect program in the parent thread and only execute the Effect in the worker. Phase 3 of cycle-2 may introduce isolated-vm if (a) isn't viable.

### §6.3 · What breaks if cycle-2 ships wrong

- If loader bypasses the sandbox: substrate-constructs can read/write outside their pack dir. Reversibility: detect via integration tests checking realpath enforcement.
- If ManagedRuntime leaks: per-construct memory grows unbounded over many invocations. Reversibility: dispose-on-unload + per-process memory ceiling check.
- If JWT validation is per-invocation: loader becomes a request-amplifier for the JWT public-key resolver. Reversibility: cached refresh per construct (TTL = min(license.exp, 1h)).
- If Tag identity mismatches: loader builds a Layer with `Context.Tag("ModelRunner")` but construct declared `Context.Tag("LLMRunner")` — the Effect program fails at runtime with "Tag not provided". Reversibility: integration test that loads the actual construct-lore-essay-grader pack and verifies the Tag resolves.

---

## §7 · Data Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Operator / API Consumer                                            │
│  loa-finn substrate-construct invoke lore-essay-grader --input ...  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  src/substrate/cli.ts                                               │
│  parses args · reads input JSON · emits stderr progress             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  src/substrate/registry.ts                                          │
│  lookup slug → LoadedConstruct (manifest · entry path · license)    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  src/substrate/runtime.ts                                           │
│  - lazy: dynamic import(pathToFileURL(entry)) (memoized)            │
│  - resolve `executable.export` → callable Effect program            │
│  - compose Layer with declared Tags only:                           │
│      - ModelRunner ← buildModelRunnerLayer(pool, model)             │
│      - EventWriter ← buildEventWriterLayer(eventstore)              │
│      - Logger      ← Effect default                                  │
│      - Clock       ← Effect default                                  │
│  - ManagedRuntime.make(layer) (memoized · disposed on unload)       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  src/agent/worker-pool.ts (interactive lane)                        │
│  enqueue substrate-invocation work · 2 workers · per-session fair   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  worker_thread (sandboxed)                                          │
│  runtime.runPromise(program(input))                                 │
│    Effect.gen(function* () {                                        │
│      const runner = yield* ModelRunner;                             │
│      const raw = yield* runner.complete({ systemPrompt, ... });     │
│      // Schema.decodeUnknown(LoreEssayOutput)(JSON.parse(raw))       │
│      return verdict;                                                │
│    })                                                               │
└─────────────────────────────────────────────────────────────────────┘
                  │                              │
                  ▼ ModelRunner.complete         ▼ EventWriter.publish
┌──────────────────────────────────────┐  ┌──────────────────────────┐
│ src/hounfour/cheval-invoker.ts        │  │ EventStore append         │
│ (TypeBox CompletionRequest → Result)  │  │ (Phase 3 → Kafka adapter) │
└──────────────────────────────────────┘  └──────────────────────────┘
                  │                              │
                  └──────────┬───────────────────┘
                             ▼
                    Verdict returned to caller (CLI stdout / API consumer)
```

**Three Tags · three boundaries · one data flow**. The loader's single job is wiring these correctly.

---

## §8 · Build Sequence (dependency-ordered · 7 sprints)

Each sprint is a distinct PR on a feature branch. Author serially. Each sprint should land in 1-3 hours.

### Sprint 1 — `src/substrate/` scaffolding + loader

**Files to create**:
- `src/substrate/types.ts` — internal types for LoadedConstruct, ValidatedLicense
- `src/substrate/loader.ts` — filesystem scan + manifest validation + JWT validation
- `src/substrate/jwt-validator.ts` — extract from existing skill-pack JWT flow OR use shared util if one exists (per `.claude/protocols/constructs-integration.md`)
- `src/substrate/__tests__/loader.test.ts` — unit tests with mock filesystem + mock JWT resolver

**Pattern to follow**: Look at how `src/agent/resource-loader.ts` resolves filesystem paths (per codebase survey).

**Verify**:
- `pnpm test src/substrate/loader.test.ts` passes
- Loader correctly rejects manifest without `executable.entry`
- Loader correctly rejects path-traversal in `executable.entry`
- Loader memoizes dynamic-import (called twice, returns same module instance)

### Sprint 2 — `runtime.ts` + ManagedRuntime composition

**Files to create**:
- `src/substrate/runtime.ts` — ManagedRuntime composition · capability check
- `src/substrate/__tests__/runtime.test.ts` — tests with mock construct + mock Layers

**Pattern to follow**: Effect's `ManagedRuntime.make(layer)` per the landscape report. `Layer.merge` to combine ModelRunner + EventWriter + Logger + Clock.

**Verify**:
- Runtime created from a mock LoadedConstruct yields a callable `invoke`
- Runtime refuses to invoke if construct declares an unknown Tag
- Runtime properly disposes on `unload()` (no zombie Layers)

### Sprint 3 — `model-runner-layer.ts`

**Files to create**:
- `src/substrate/model-runner-layer.ts` — Effect Layer wrapping cheval-invoker
- `src/substrate/__tests__/model-runner-layer.test.ts` — test with mock cheval

**Critical test**: import the actual `gradeLoreEssay` from `~/Documents/GitHub/construct-lore-essay-grader/src/grader.ts` (via local file path resolution), provide the Layer, run with a mocked CompletionRequest response — verify the Effect resolves to LoreEssayOutput correctly. **This is the integration test that proves Tag identity matches across the cross-pack boundary.**

**Verify**:
- Layer composes with ModelRunner Tag from a real construct
- complete() correctly translates Effect → CompletionRequest → Effect

### Sprint 4 — `event-writer-layer.ts` + EventStore bridge

**Files to create**:
- `src/substrate/event-writer-layer.ts` — Effect Layer wrapping EventStore
- `src/substrate/__tests__/event-writer-layer.test.ts`

**Verify**:
- publish() correctly appends to EventStore
- subject naming follows `{aggregate}.{noun}.{verb}` convention

### Sprint 5 — Sandbox integration (the load-bearing boundary)

**Goal**: ensure substrate-construct invocations route through `ToolSandbox.execute()` and run inside the worker_threads pool. SPIKE FIRST: verify dynamic-import works inside the existing worker.

**Files to create**:
- `src/substrate/sandbox-bridge.ts` — wires runtime.invoke to ToolSandbox.execute (worker dispatch)
- `src/substrate/__tests__/sandbox-bridge.test.ts`

**Spike**: simple worker_thread that does `import("/some/abs/path.js")` and returns a value. If this works, sprint 5 is straightforward. If not, document the constraint (Phase 3 isolated-vm path).

**Verify**:
- Substrate invocation runs in interactive lane (worker 1 or 2 occupied during invoke)
- Filesystem jail enforced: construct can't read outside pack dir
- Worker survives + accepts next invocation

### Sprint 6 — `cli.ts` + programmatic API

**Files to create**:
- `src/substrate/cli.ts` — `substrate-construct invoke` subcommand
- `src/substrate/index.ts` — barrel export with `Substrate.invoke()` programmatic API
- `src/substrate/__tests__/cli.test.ts`

**ALEXANDER craft check** for CLI output (per §5.6 spec):
- stderr human · stdout JSON
- color only on status
- monospace + tabular numerics for confidence

**Verify**:
- `loa-finn substrate-construct invoke lore-essay-grader --input ./essay.json` runs end-to-end against the published construct-lore-essay-grader pack
- Exit codes match status (0 APPROVED · 1 REJECTED · 2 NEEDS_HUMAN · 3+ system error)

### Sprint 7 — End-to-end smoke + doctrine update

**Goal**: prove cycle-2 with a real LLM call (or operator-mocked one).

**Files to create**:
- `src/substrate/__tests__/e2e.test.ts` — end-to-end test:
  1. Loader scans a fixture packs dir
  2. Finds construct-lore-essay-grader (symlinked or copied to fixture)
  3. Builds runtime with TestModelRunner Layer (canned response)
  4. CLI invokes with a sample essay
  5. Verdict returned · matches expected

**Doctrine update**:
- `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md` §13 "Cycle-2 substrate-runtime first execution learnings"
- What was proven (loader · ManagedRuntime per construct · Tag-identity bridging · sandbox compatible)
- What was deferred (Kafka transport · vendor/untrusted tiers · per-invocation introspection)

**Memory entry**: extend cycle-1 memory entry with cycle-2 sub-section OR write new memory file.

### Optional Sprint 8 — Kafka adapter (Phase 3 of cycle-2)

**Defer to follow-up cycle UNLESS operator explicitly asks for Phase 3 in this kickoff session.**

**Files to create**:
- `src/substrate/kafka-writer-layer.ts` — KafkaWriter Layer using `@confluentinc/kafka-javascript`
- `src/substrate/kafka-consumer.ts` — subscribes to `streams.reads.subject` Kafka topics, dispatches to runtime
- `src/substrate/__tests__/kafka-*.test.ts`

**Config**: `.loa.config.yaml#substrate.kafka.enabled` flag toggles KafkaWriter vs EventStoreWriter.

---

## §9 · Design Rules (ALEXANDER · for the CLI surface only · per §5.6)

| Rule | Spec |
|---|---|
| **stdout discipline** | JSON only · machine-parseable · matches `SubstrateStepVerdict` Effect Schema |
| **stderr discipline** | Human progress · ≤80 char width · prefix with `Loading...` `Composing...` `Invoking...` |
| **color-as-information** | ONLY status: APPROVED=`oklch(0.65 0.18 145)` (green) · REJECTED=`oklch(0.62 0.22 25)` (red) · NEEDS_HUMAN=`oklch(0.78 0.18 90)` (yellow) |
| **monospace numerics** | confidence + dimensions use `tabular-nums` (terminal-equivalent: just align right) |
| **rhythm** | 4 blank lines between sections · 1 blank line between related lines |
| **silence** | NO emoji · NO decorative animation · NO progress bars (operator's terminal can't reliably render) |
| **exit codes** | 0=APPROVED · 1=REJECTED · 2=NEEDS_HUMAN · 3+=system error (with stderr trace) |

For the `Substrate.invoke()` programmatic API, NO craft applies — it returns a typed verdict. The TYPES are the API.

---

## §10 · What NOT to Build (BARTH · explicit cuts)

- ❌ **No Kafka cluster setup** — `event-writer-layer.ts` ships with EventStore impl. Kafka adapter is Sprint 8 / Phase 3, deferred unless operator picks it up in this kickoff session.
- ❌ **No `trust:vendor` or `trust:untrusted` isolation** — only `trust:internal` (worker_threads + capability-bounded Layer). isolated-vm + subprocess+microVM are Phase 3.
- ❌ **No per-invocation JWT introspection** — load-time RS256 + cached TTL is enough. Threat model justification gates the upgrade.
- ❌ **No construct-creation tooling** — operators author construct.yaml + src/grader.ts by hand. Templating is its own cycle.
- ❌ **No cubquests-interface integration** — separate cycle. The loader exposes a programmatic API; cubquests consumes it later.
- ❌ **No Real-LLM ModelRunner** — TestModelRunner suffices for sprint 7 e2e. AnthropicModelRunner is its own micro-cycle (1-2hr).
- ❌ **No new Effect-TS adoption in src/agent or src/hounfour** — Effect lives in `src/substrate/` only. Promise-based runtime stays.
- ❌ **No multi-construct composition recipe** — single-construct invocation only. loa-compositions YAML chaining is operator's §10b four-tier "composition" layer · its own future work.
- ❌ **No registry.constructs.network publishing** — substrate-constructs install via filesystem pack OR via the existing `/loa constructs install` command (unchanged for this cycle).

---

## §11 · Verify (success criteria for cycle-2 close)

After sprint 7 ships:

- [ ] Loader scans `.loa.config.yaml#substrate.constructs_dir` and finds construct-lore-essay-grader
- [ ] Loader validates manifest against just-merged loa-constructs Zod schema · rejects bad manifests
- [ ] Loader validates JWT license · respects grace periods
- [ ] Runtime composes Layer with capability-bounded Tags only
- [ ] ModelRunner Layer correctly wraps cheval-invoker
- [ ] EventWriter Layer correctly wraps EventStore
- [ ] Substrate invocation runs inside worker_threads sandbox (filesystem jail enforced)
- [ ] CLI command `loa-finn substrate-construct invoke <slug>` returns typed verdict
- [ ] Programmatic API `Substrate.invoke()` returns typed verdict
- [ ] End-to-end test loads real construct-lore-essay-grader pack + runs with TestModelRunner + verifies verdict
- [ ] Doctrine §13 cycle-2 first-execution-learnings filled in
- [ ] Memory entry shipped
- [ ] Kafka adapter NOT shipped (BARTH cut held — Phase 3)

**Optional V1.5 deferred**:
- Kafka adapter + consumer · `@confluentinc/kafka-javascript`
- AnthropicModelRunner Layer · real LLM smoke
- cubquests-interface OffchainStepConfig.verificationType `"construct"` integration
- `trust:vendor` isolation tier

---

## §12 · Key References

| Topic | Path |
|---|---|
| Cycle-1 doctrine §12 (5 corrections + reframe) | `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md` |
| Cycle-2 codebase survey (loa-finn current state) | `grimoires/loa/specs/cycle-2-substrate-runtime-codebase-survey.md` |
| Cycle-2 landscape (Effect-TS · Kafka · isolation) | `grimoires/loa/specs/cycle-2-substrate-runtime-landscape.md` |
| Manifest schema (Zod) | `~/Documents/GitHub/loa-constructs/packages/shared/src/validation.ts` (substrateRuntimeSchema, substrateExecutableSchema, substrateRequirementSchema, substrateStreamEntrySchema, substrateStreamsSchema) |
| Manifest schema (JSON Schema) | `~/Documents/GitHub/construct-base/schemas/construct.schema.json` |
| Substrate-step protocol | `~/Documents/GitHub/freeside-quests/packages/protocol/src/substrate-step.ts` |
| Instance-1 construct | `~/Documents/GitHub/construct-lore-essay-grader/` |
| JWT licensing flow | `~/Documents/GitHub/loa-constructs/.claude/protocols/constructs-integration.md` |
| Sandbox primitives | `src/agent/sandbox.ts` · `src/agent/worker-pool.ts` |
| Hounfour invocation | `src/hounfour/cheval-invoker.ts` |
| EventStore | `src/events/writer.ts` + `src/events/types.ts` (per codebase survey §4 · NOT `src/persistence/` which is WAL+r2-sync+git-sync) |
| OSTROM persona | `.claude/constructs/packs/the-arcade/identity/OSTROM.md` |
| ALEXANDER persona | `.claude/constructs/packs/artisan/identity/ALEXANDER.md` |
| BARTH persona | `.claude/constructs/packs/the-arcade/identity/BARTH.md` |

---

## §13 · Coordination

1. **Read first**: cycle-1 doctrine §12 + this build doc + the two grimoire reports (codebase + landscape). All four are required pre-flight.
2. **Persona**: OSTROM leads · ALEXANDER on standby for CLI craft · BARTH on standby for scope cuts.
3. **Sprint cadence**: 7 sprints serial. Each 1-3 hours. Sprint 5 (sandbox spike) FIRST if any uncertainty about worker_threads + dynamic-import.
4. **Operator pair-points**:
   - Pre-Sprint-1: confirm loader directory location (`src/substrate/` recommended)
   - Mid-Sprint-3: review ModelRunner Tag identity bridge (cross-pack Tag matching)
   - Pre-Sprint-7: confirm e2e test fixture (use real construct-lore-essay-grader OR simplified test pack)
   - Post-Sprint-7: review doctrine §13 draft
5. **Branches**: feature branch per sprint (`feat/substrate-runtime-sprint-N-<slug>`). PRs gated on tests + Bridgebuilder review.
6. **No merge to main without**: loader + runtime + ModelRunner + EventWriter + sandbox-bridge + CLI all green individually + e2e green.
7. **Cadence rule update post-cycle**: if substrate-runtime work is one-shot (likely), name it. If recurring (per new construct), name the cadence.

---

*Drafted 2026-05-03 PM as the cycle-2 substrate-runtime kickoff. Operator fires when ready. Pre-flight = read doctrine §12 + the two grimoire reports + this doc. Sprint 5 sandbox spike first if uncertain about worker_threads + dynamic-import. Half-day to full-day budget; serial sprints.*
