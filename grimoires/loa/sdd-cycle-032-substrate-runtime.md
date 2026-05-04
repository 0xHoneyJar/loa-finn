# SDD: Substrate Runtime — Effect Loader + Worker-Thread Sandbox + EventStore Bridge

> **Version**: 1.0.0
> **Date**: 2026-05-03
> **Author**: @zksoju + Claude Opus 4.7 (1M context)
> **Status**: Draft (paired with PRD v1.2.0 — incorporates Codex iteration-1 + iteration-2 findings)
> **Cycle**: cycle-032
> **PRD Reference**: `grimoires/loa/prd.md` v1.2.0
> **Build Doc** (canonical for code samples + deep architecture): `grimoires/loa/specs/cycle-2-substrate-runtime-build.md` (639 lines)
> **Codebase Survey**: `grimoires/loa/specs/cycle-2-substrate-runtime-codebase-survey.md` (416 lines · 5 load-bearing findings)
> **Landscape Report**: `grimoires/loa/specs/cycle-2-substrate-runtime-landscape.md` (572 lines · Effect-TS + Kafka + isolation recommendations)
> **Spike (validated)**: `scripts/substrate-spike.mjs` ✅ GREEN at 14.58ms cold-start (worker_threads + dynamic-import primitive)

---

## 1. Executive Summary

### 1.1 What This Cycle Does

Cycle-1 (substrate-integration, shipped 2026-05-03 PM, 3 PRs) sealed the substrate ABI at the contract layer: protocol Effect Schema, manifest contract (Zod + JSON Schema), instance-1 construct (`construct-lore-essay-grader`), and in-process `dispatchEssayQuest` engine. What it left aspirational was the **runtime layer** — the loader + Layer composition + sandbox bridge that makes substrate-constructs actually invokable inside loa-finn.

This SDD designs that runtime layer. Per PRD §0: a loader living in `src/substrate/` that takes a construct slug + an input, finds the pack on the filesystem, dynamic-imports the Effect entry, composes the right Layer (capability-bounded, with concrete impls for declared Requirements), runs the Effect program **inside a worker_threads sandbox via parent-bridge proxies** (Option A — see PRD FR-5), and returns the typed verdict to the caller.

### 1.2 What Already Exists (Grounding · per codebase survey §1-§5)

| Component | Location | Used by cycle-032 as |
|---|---|---|
| `ToolSandbox.execute()` + worker-pool | `src/agent/sandbox.ts` + `src/agent/worker-pool.ts` | The execution surface substrate-constructs ride |
| `sandbox-worker.ts` (handles exec messages, validates cwd against jailRoot) | `src/agent/sandbox-worker.ts` | Modified to handle `substrate-invoke` envelope (validate + delegate; NO Effect imports) |
| `chevalInvoke()` (TypeBox CompletionRequest → Result) | `src/hounfour/cheval-invoker.ts` | Wrapped by parent-side `sandbox-bridge.ts` for ModelRunner proxy responses |
| `EventWriter` interface + `EventEnvelope` types | `src/events/writer.ts` + `src/events/types.ts` | Wrapped by parent-side `sandbox-bridge.ts` for EventWriter proxy responses |
| Pool registry (model_tier → pool_id) | `src/hounfour/pool-registry.ts` | Read-only — loader reads to set runtime opts |
| Skill-pack JWT validator flow | per `.claude/protocols/constructs-integration.md` (loa-constructs) | Reused pattern for substrate-construct license validation |
| Loa-constructs Zod manifest schema (`superRefine` for `type: substrate-construct`) | `loa-constructs/packages/shared/src/validation.ts` (just-merged loa-constructs#223) | Loader validates parsed manifests against this |
| Construct-base JSON Schema | `construct-base/schemas/construct.schema.json` | Reference (non-runtime use) |
| Substrate-step protocol (`SubstrateStepSubmission` / `SubstrateStepVerdict`) | `freeside-quests/packages/protocol/src/substrate-step.ts` (cycle-1 shipped) | Result envelope shape — frozen at 1.0.0 |
| Instance-1 construct (`gradeLoreEssay` Effect program) | `~/Documents/GitHub/construct-lore-essay-grader/src/grader.ts` | E2E test fixture (FR-7) |

### 1.3 What This SDD Designs

| New file/module | PRD ref | Imports Effect? |
|---|---|---|
| `src/substrate/types.ts` | FR-1 | yes (typed manifest + license shapes) |
| `src/substrate/loader.ts` | FR-1 | no (parent-side, Promise-based; no Effect runtime) |
| `src/substrate/jwt-validator.ts` | FR-1 | no |
| `src/substrate/runtime.ts` | FR-2 | yes (Effect Layer types) |
| `src/substrate/model-runner-layer.ts` | FR-3 | yes (Layer factory) |
| `src/substrate/event-writer-layer.ts` | FR-4 | yes (Layer factory) |
| `src/substrate/sandbox-bridge.ts` (NEW) | FR-5 | no (parent-side dispatcher; Promise-based) |
| `src/substrate/worker-runtime.ts` (NEW) | FR-5 | yes (Effect lives here — composition + ManagedRuntime + run) |
| `src/agent/sandbox-worker.ts` (modified) | FR-5 | no (validate envelope + delegate; stays Effect-free) |
| `src/substrate/cli.ts` | FR-6 | no (CLI shell; uses Promise-based `Substrate.invoke()`) |
| `src/substrate/index.ts` | FR-6 | no (barrel export; programmatic API) |
| `src/substrate/__tests__/*` | various | mixed (test-side imports per file under test) |

Effect-TS is contained to `src/substrate/`. Per PRD §4 BARTH cut: NO Effect adoption in `src/agent/` or `src/hounfour/`. The new `src/substrate/worker-runtime.ts` (which DOES import Effect) is logically part of the substrate module — `src/agent/sandbox-worker.ts` only delegates to it via dynamic import (Effect-free in the agent module itself).

---

## 2. System Architecture

### 2.1 Three-process-zone view

```
┌──────────────────────────────────────────────────────────────────────┐
│  Operator (CLI) / API consumer (programmatic)                        │
│    cli.ts: parses args, reads input JSON, emits stderr progress      │
│    index.ts: Substrate.invoke(slug, input) → Promise<verdict>        │
└──────────────────────────────────────────────────────────────────────┘
                                ↓ (Promise-based)
┌──────────────────────────────────────────────────────────────────────┐
│  Parent process (loa-finn main thread · NO Effect runtime)           │
│    loader.ts: filesystem scan + manifest validation + JWT validation │
│    runtime.ts: composition contract (types only; runs in worker)     │
│    sandbox-bridge.ts: WorkerPool.exec() + bridge response handlers   │
│      ├── on(modelrunner.req): chevalInvoke(req) → modelrunner.res    │
│      └── on(eventwriter.req): eventStore.append(req) → eventwriter.res│
└──────────────────────────────────────────────────────────────────────┘
                                ↓ (structured-clone-safe envelopes)
┌──────────────────────────────────────────────────────────────────────┐
│  Worker thread (sandboxed · interactive lane · 2 workers)            │
│    sandbox-worker.ts (modified · NO Effect):                         │
│      receives substrate-invoke envelope                              │
│      validates modPath against jail                                  │
│      delegates to worker-runtime.ts                                  │
│    worker-runtime.ts (NEW · Effect lives here):                      │
│      import(pathToFileURL(modPath))                                  │
│      compose Layer (ModelRunner+EventWriter+Logger+Clock)            │
│      ManagedRuntime.make(layer) + cache by slug                      │
│      runtime.runPromise(program(input))                              │
│      postMessage({type:"result", jobId, result: verdict})            │
│                                                                      │
│    Inside the Effect program (per cycle-1 contract):                 │
│      yield* ModelRunner → bridges to parent via postMessage          │
│      yield* EventWriter → bridges to parent via postMessage          │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Trust model (HONEST SCOPE per PRD invariant 4)

| Tier | Status this cycle | Mechanism | Threat blocked |
|---|---|---|---|
| `trust:internal` | ✅ ships | worker_threads + modPath realpath jail + bridge capability bounds | construct can't load from outside packs dir; construct can't call services outside its declared `requirements[]` |
| `trust:vendor` | ❌ deferred | (Phase 3 candidates: `node --experimental-permission`, `isolated-vm`) | direct Node built-in access (`node:fs`, `node:process`, etc.) from inside imported construct code |
| `trust:untrusted` | ❌ deferred | (Phase 3 candidates: subprocess + microVM, gVisor, Firecracker) | full process-level isolation including kernel surface |

This cycle's substrate-constructs are first-party / vetted. Misbehavior at `trust:internal` is a build-time review failure, not a runtime defense failure.

---

## 3. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (Node.js 22+) | matches loa-finn baseline |
| Runtime (parent) | existing loa-finn worker-pool + ToolSandbox | cycle-002 refactor; per codebase survey |
| Runtime (worker · substrate Effect programs) | `effect@^3.10.0` peer dep + `ManagedRuntime` | per landscape report |
| Manifest validation | `@loa-constructs/shared` Zod schema (loa-constructs#223 just-merged) | parent-side |
| JWT validation | RS256 via existing skill-pack JWT flow | reused per `.claude/protocols/constructs-integration.md` |
| Bridge serialization | structured-clone (Node `worker_threads` native) | NOT JSON; Schema.Date / Schema.MapFromSelf etc. |
| Test runner | vitest (existing) | pattern matches `src/agent/__tests__/*.test.ts` |
| LLM invocation (parent-side) | `chevalInvoke()` (TypeBox CompletionRequest) | unchanged wire format |
| Event publishing (parent-side) | `EventWriter` from `src/events/writer.ts` | append-only EventStore (cycle-021 abstraction) |

**Dependencies added by cycle-032**: `effect@^3.10.0` only. NOT shipped: `@confluentinc/kafka-javascript`, `kafkajs`, `isolated-vm`, `vm2`. Per PRD §4 BARTH cuts.

---

## 4. Component Design

### 4.1 `src/substrate/types.ts` (Sprint 1)

Internal types shared across substrate modules. NO runtime behavior.

```typescript
import type { ValidatedPackManifest } from "@loa-constructs/shared";

export interface ValidatedLicense {
  fingerprint: string;
  kid: string;
  issuedAt: Date;
  expiresAt: Date;
  graceUntil: Date;
  tier: "individual" | "pro" | "team" | "enterprise";
  status: "valid" | "validatedWithGrace";
}

export interface LoadedConstruct {
  slug: string;
  manifest: ValidatedPackManifest;
  entryPath: string;             // realpath-canonicalized absolute path
  loadModule: () => Promise<Record<string, unknown>>;  // memoized dynamic import (parent-side metadata; actual import happens worker-side)
  license: ValidatedLicense;
}

// Bridge envelope discriminated union — see PRD FR-5 bridge serialization contract
export type BridgeEnvelope =
  | { type: "substrate-invoke"; jobId: string; payload: SubstrateInvokePayload }
  | { type: "result"; jobId: string; payload: SubstrateStepVerdict }   // from cycle-1 protocol
  | { type: "modelrunner.req"; jobId: string; payload: { completionRequest: CompletionRequest } }
  | { type: "modelrunner.res"; jobId: string; payload: { text: string } | { error: ModelRunnerErrorWire } }
  | { type: "eventwriter.req"; jobId: string; payload: { envelope: EventEnvelope } }   // from src/events/types.ts
  | { type: "eventwriter.res"; jobId: string; payload: { ok: true } | { error: EventWriterErrorWire } }
  | { type: "dispose-runtime"; jobId: string; payload: { slug: string } };

export interface SubstrateInvokePayload {
  modPath: string;        // realpath-canonicalized
  exportName: string;     // construct.yaml#executable.export
  input: unknown;         // construct's I (validated against executable.protocol.input on worker side)
  runtimeOpts: { agentId: string; tenantId: string; poolId: string; modelId: string; tier: string };
}
```

**Failure modes** (all typed at module boundaries):
- `ManifestParseError`, `ManifestValidationError`, `LicenseError`, `EntryResolutionError`, `UnknownRequirementError`, `EnvelopeValidationError`

### 4.2 `src/substrate/loader.ts` (Sprint 1)

Parent-side · NO Effect imports. Per PRD FR-1.

```typescript
export interface LoadOptions {
  packsDir: string;                                              // from .loa.config.yaml#substrate.constructs_dir
  jwtPublicKeyResolver: (kid: string) => Promise<string>;        // honors LOA_OFFLINE=1
}

export async function loadConstructsFromFilesystem(
  opts: LoadOptions,
): Promise<Map<string, LoadedConstruct>>;

// Internal helpers (testable):
async function scanPacksDir(packsDir: string): Promise<string[]>;
async function loadOneConstruct(packDir: string, jwtResolver: LoadOptions["jwtPublicKeyResolver"]): Promise<LoadedConstruct>;
function resolveEntryPath(packRoot: string, entryRelative: string): string;  // realpath canonicalization
```

**Tests** (`src/substrate/__tests__/loader.test.ts`):
- Fixture packs dir with valid construct → registry populated
- Bad manifest (missing `executable.entry`) → `ManifestValidationError`
- Path-traversal in `executable.entry` (e.g., `../../etc/hosts`) → `EntryResolutionError`
- Memoized load: `loaded.loadModule()` called twice → same module instance (no re-import)

### 4.3 `src/substrate/jwt-validator.ts` (Sprint 1)

State-aware cache per PRD FR-1 contract.

```typescript
export interface ValidationResult {
  status: "valid" | "validatedWithGrace";
  license: ValidatedLicense;
}

export interface JwtValidator {
  validate(licenseJwt: string, kid: string): Promise<ValidationResult>;  // throws LicenseError on expired-beyond-grace, not-yet-valid
  invalidate(fingerprint: string, kid: string): void;                    // for dispose path
}

export function makeJwtValidator(opts: {
  publicKeyResolver: (kid: string) => Promise<string>;     // returns PEM
  clock: () => Date;                                       // injectable for tests
  tierGracePeriods: Record<string, number>;                // seconds, per cycle-1 contract
}): JwtValidator;
```

**Cache strategy** (per PRD FR-1 table):
- Cache key: `(license.fingerprint, license.kid)`
- For `valid` results: TTL = `min(exp - now, 1h)`
- For `validatedWithGrace` results: TTL = `min(exp + grace - now, 1h)`
- For `expired-beyond-grace` and `not-yet-valid`: NOT cached (always re-evaluated)
- On every cached read: re-check `exp` (and `nbf` if present) against current clock
- Public key cache: separate; persists across `LOA_OFFLINE=1` sessions

**Tests** (`src/substrate/__tests__/jwt-validator.test.ts` · gates Sprint 1):
- Fake-clock matrix from PRD §5 criterion 5.3 (10 cases)
- Fake-clock injected via `clock` opt; no real-time dependence

### 4.4 `src/substrate/runtime.ts` (Sprint 2)

Layer composition contract + capability rule. Effect-imports stay here (substrate module).

```typescript
import { Layer, Effect, Context } from "effect";
import type { LoadedConstruct } from "./types.js";

export interface ConstructRuntime {
  slug: string;
  invoke: <I, O>(input: I) => Promise<O>;
  dispose: () => Promise<void>;
}

// Builds the Layer per PRD FR-2 capability rule
export function composeLayer(
  loaded: LoadedConstruct,
  layers: { modelRunnerLayer: Layer.Layer<unknown>; eventWriterLayer: Layer.Layer<unknown> },
): Layer.Layer<unknown, never, never>;

// AmBient services (PRD FR-2 ambient allowlist invariant)
export const AMBIENT_TAG_KEYS = ["Logger", "Clock"] as const;
```

**Capability check** (per PRD FR-2):
- Walk `loaded.manifest.requirements[].tag`
- Each must be in `{"ModelRunner", "EventWriter"} ∪ AMBIENT_TAG_KEYS`
- Unknown Tag → throw `UnknownRequirementError(tag)` BEFORE Layer construction

**Tests** (`src/substrate/__tests__/runtime.test.ts` · gates Sprint 2):
- Mock construct declares `["ModelRunner"]` → composed Layer provides ModelRunner + Logger + Clock; NOT EventWriter
- Mock construct declares `["UnknownTag"]` → `UnknownRequirementError` thrown
- Lifecycle: 2 workers, each composes runtime independently; dispose broadcast drops both caches

### 4.5 `src/substrate/model-runner-layer.ts` (Sprint 3)

Effect Layer factory. Used worker-side; bridges to parent via postMessage.

```typescript
import { Layer, Effect, Context } from "effect";

export class ModelRunner extends Context.Tag("ModelRunner")<
  ModelRunner,
  {
    complete: (params: { systemPrompt: string; userMessage: string }) => Effect.Effect<string, ModelRunnerError>;
  }
>() {}

export class ModelRunnerError {
  readonly _tag = "ModelRunnerError";
  constructor(readonly reason: string, readonly cause?: unknown) {}
}

// Worker-side factory: takes the bridge postMessage + jobId-correlation map
export const buildModelRunnerLayer = (bridge: WorkerBridge, runtimeOpts: RuntimeOpts) =>
  Layer.succeed(ModelRunner, {
    complete: ({ systemPrompt, userMessage }) =>
      Effect.tryPromise({
        try: async () => {
          const jobId = crypto.randomUUID();
          const completionRequest = buildCompletionRequest(systemPrompt, userMessage, runtimeOpts);
          return await bridge.request("modelrunner.req", jobId, { completionRequest });  // posts to parent, awaits modelrunner.res via jobId
        },
        catch: (cause) => new ModelRunnerError("model invocation failed", cause),
      }),
  });
```

**Tag identity** (PRD FR-3 table — load-bearing):
- Context.Tag key: `"ModelRunner"` (exact, case-sensitive)
- Service interface: `{ complete: (params: { systemPrompt: string; userMessage: string }) => Effect.Effect<string, ModelRunnerError> }`
- Error `_tag`: `"ModelRunnerError"`

**Tests** (`src/substrate/__tests__/model-runner-layer.test.ts` · gates Sprint 3):
- Unit: mock bridge returns canned text → Effect resolves
- Unit: mock bridge returns error → Effect fails with ModelRunnerError shape
- **Integration test (PAIR-POINT — see PRD §6 Mid-Sprint-3)**: import real `gradeLoreEssay` from `~/Documents/GitHub/construct-lore-essay-grader/src/grader.ts`, provide loader-built ModelRunner Layer with mocked bridge response, verify Effect resolves to typed `LoreEssayOutput`

### 4.6 `src/substrate/event-writer-layer.ts` (Sprint 4)

Same shape as ModelRunner Layer. Bridges to parent EventStore via postMessage.

```typescript
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

export const buildEventWriterLayer = (bridge: WorkerBridge) =>
  Layer.succeed(EventWriter, {
    publish: (subject, payload) =>
      Effect.tryPromise({
        try: async () => {
          const jobId = crypto.randomUUID();
          const envelope = buildEventEnvelope(subject, payload);   // matches src/events/types.ts
          await bridge.request("eventwriter.req", jobId, { envelope });
        },
        catch: (cause) => new EventWriterError("event publish failed", cause),
      }),
  });
```

**Tests** (`src/substrate/__tests__/event-writer-layer.test.ts`):
- publish() correctly builds EventEnvelope (event_id/event_type/timestamp/correlation_id/sequence/checksum/schema_version/payload)
- subject naming convention enforced: `{aggregate}.{noun}.{verb}` regex check
- bridge error → EventWriterError shape

### 4.7 `src/substrate/sandbox-bridge.ts` (NEW · Sprint 5 · parent-side · NO Effect)

```typescript
export async function bridgeInvoke(
  loaded: LoadedConstruct,
  runtimeOpts: RuntimeOpts,
  input: unknown,
): Promise<SubstrateStepVerdict> {
  const jobId = crypto.randomUUID();
  const result = await workerPool.exec({
    type: "substrate-invoke",
    jobId,
    payload: { modPath: loaded.entryPath, exportName: loaded.manifest.executable.export, input, runtimeOpts },
  }, "interactive");
  return validateVerdict(result);   // Schema.decodeUnknown(SubstrateStepVerdict)
}

// Per-worker bridge handlers
function attachBridgeHandlers(worker: Worker): void {
  worker.on("message", (msg: BridgeEnvelope) => {
    switch (msg.type) {
      case "modelrunner.req": handleModelRunnerReq(worker, msg); break;
      case "eventwriter.req": handleEventWriterReq(worker, msg); break;
      default: /* result handled by exec promise */
    }
  });
}

async function handleModelRunnerReq(worker: Worker, msg: ModelRunnerReqEnvelope): Promise<void> {
  try {
    const { text } = await chevalInvoke(msg.payload.completionRequest);
    worker.postMessage({ type: "modelrunner.res", jobId: msg.jobId, payload: { text } });
  } catch (cause) {
    worker.postMessage({ type: "modelrunner.res", jobId: msg.jobId, payload: { error: { _tag: "ModelRunnerError", reason: String(cause) } } });
  }
}

async function handleEventWriterReq(worker: Worker, msg: EventWriterReqEnvelope): Promise<void> {
  try {
    await eventStore.append(msg.payload.envelope);
    worker.postMessage({ type: "eventwriter.res", jobId: msg.jobId, payload: { ok: true } });
  } catch (cause) {
    worker.postMessage({ type: "eventwriter.res", jobId: msg.jobId, payload: { error: { _tag: "EventWriterError", reason: String(cause) } } });
  }
}

export function broadcastDispose(slug: string): void {
  for (const worker of workerPool.allWorkers()) {
    worker.postMessage({ type: "dispose-runtime", jobId: crypto.randomUUID(), payload: { slug } });
  }
}
```

### 4.8 `src/substrate/worker-runtime.ts` (NEW · Sprint 5 · worker-side · Effect lives here)

```typescript
import { ManagedRuntime } from "effect";
import { composeLayer } from "./runtime.js";
import { buildModelRunnerLayer } from "./model-runner-layer.js";
import { buildEventWriterLayer } from "./event-writer-layer.js";
import { pathToFileURL } from "node:url";

const cache = new Map<string, ManagedRuntime.ManagedRuntime<unknown, never>>();
const moduleCache = new Map<string, Record<string, unknown>>();

export async function handleSubstrateInvoke(payload: SubstrateInvokePayload, bridge: WorkerBridge): Promise<SubstrateStepVerdict> {
  const { modPath, exportName, input, runtimeOpts } = payload;

  const slug = deriveSlugFromModPath(modPath);
  let runtime = cache.get(slug);
  if (!runtime) {
    const mod = moduleCache.get(modPath) ?? await import(pathToFileURL(modPath).href);
    moduleCache.set(modPath, mod);

    const program = mod[exportName] as (input: unknown) => Effect.Effect<unknown, unknown, unknown>;
    if (typeof program !== "function") throw new Error(`export ${exportName} is not a callable`);

    const modelRunnerLayer = buildModelRunnerLayer(bridge, runtimeOpts);
    const eventWriterLayer = buildEventWriterLayer(bridge);
    const layer = composeLayer(/* loaded ref */, { modelRunnerLayer, eventWriterLayer });

    runtime = ManagedRuntime.make(layer);
    cache.set(slug, runtime);
  }

  const result = await runtime.runPromise(program(input));
  return result as SubstrateStepVerdict;
}

export async function handleDisposeRuntime(slug: string): Promise<void> {
  const runtime = cache.get(slug);
  if (runtime) {
    await runtime.dispose();
    cache.delete(slug);
  }
}
```

### 4.9 `src/agent/sandbox-worker.ts` modifications (Sprint 5 · NO Effect)

Add envelope discriminator handling. Stays Effect-free.

```typescript
// After existing exec-message handling:
import { handleSubstrateInvoke, handleDisposeRuntime } from "../substrate/worker-runtime.js";

parentPort.on("message", async (msg: BridgeEnvelope | ExecMessage) => {
  switch (msg.type) {
    case "exec":
      // existing handler
      break;
    case "substrate-invoke":
      await validateModPathAgainstJail(msg.payload.modPath);
      await validateEnvelope(msg);  // structured-clone-safe schema check
      const verdict = await handleSubstrateInvoke(msg.payload, makeBridge(parentPort));
      parentPort.postMessage({ type: "result", jobId: msg.jobId, payload: verdict });
      break;
    case "dispose-runtime":
      await handleDisposeRuntime(msg.payload.slug);
      break;
    case "modelrunner.res":
    case "eventwriter.res":
      // forward to bridge response handler (jobId-keyed map)
      bridgeResponseRouter(msg);
      break;
  }
});
```

### 4.10 `src/substrate/cli.ts` + `index.ts` (Sprint 6)

Per PRD FR-6 ALEXANDER craft. JSON stdout, human stderr, color-on-status only.

```typescript
// cli.ts
const program = new Command()
  .command("substrate-construct")
  .command("invoke <slug>")
  .requiredOption("--input <file>", "Input JSON file")
  .action(async (slug: string, opts: { input: string }) => {
    process.stderr.write(`Loading construct ${slug}...\n`);
    const loaded = registry.get(slug) ?? exitWithError(3, `unknown slug: ${slug}`);
    process.stderr.write(`Composing runtime...\n`);
    process.stderr.write(`Invoking ${slug}...\n`);
    const input = JSON.parse(await readFile(opts.input, "utf-8"));
    try {
      const verdict = await Substrate.invoke(slug, input);
      process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
      process.exit(verdict.status === "APPROVED" ? 0 : verdict.status === "REJECTED" ? 1 : 2);
    } catch (err) {
      process.stderr.write(`ERROR: ${err.message}\n${err.stack}\n`);
      process.exit(3);
    }
  });

// index.ts (programmatic API)
export const Substrate = {
  invoke: async (slug: string, input: unknown): Promise<SubstrateStepVerdict> => {
    const loaded = registry.get(slug);
    if (!loaded) throw new Error(`unknown construct: ${slug}`);
    const runtimeOpts = deriveRuntimeOpts(loaded);
    return bridgeInvoke(loaded, runtimeOpts, input);
  },
};
```

---

## 5. Data Architecture

See PRD §FR-5 Execution model diagram + build doc §7.

**Data flow**:
1. Operator calls CLI or API consumer calls `Substrate.invoke(slug, input)`
2. Parent looks up slug in `registry` (populated by `loader.ts` at startup)
3. Parent dispatches `substrate-invoke` envelope to interactive lane via `WorkerPool.exec()`
4. Worker validates envelope + modPath; delegates to `worker-runtime.ts`
5. `worker-runtime.ts` imports module (memoized), composes Layer (capability-bounded), creates ManagedRuntime (cached by slug), runs Effect program
6. Inside Effect program: `yield* ModelRunner` → bridge sends `modelrunner.req` to parent → parent calls `chevalInvoke()` → parent posts `modelrunner.res` → worker bridge resolves the awaiting Promise → Effect continues
7. Same for `yield* EventWriter`
8. Effect resolves to verdict; worker posts `result` envelope back to parent
9. Parent validates against `SubstrateStepVerdict` schema
10. Returned to caller

**State storage**:
- Parent: in-memory `registry` (Map<slug, LoadedConstruct>) + JWT cache
- Worker: in-memory `ManagedRuntime` cache (Map<slug, ManagedRuntime>) + module cache (Map<modPath, Module>)
- No persistence beyond what EventWriter pushes to existing EventStore

---

## 6. API Design

### 6.1 CLI (per PRD FR-6 + ALEXANDER craft)

```
$ loa-finn substrate-construct invoke <slug> --input <file>
```

- stdout: JSON `SubstrateStepVerdict`
- stderr: human progress
- exit: 0 APPROVED, 1 REJECTED, 2 NEEDS_HUMAN, 3+ system error

### 6.2 Programmatic API

```typescript
import { Substrate } from "@loa-finn/substrate";
const verdict: SubstrateStepVerdict = await Substrate.invoke("lore-essay-grader", input);
```

### 6.3 Bridge envelope schemas (per PRD FR-5)

See `src/substrate/types.ts` — discriminated union with type-specific payload schemas. NOT JSON-only; structured-clone-safe.

---

## 7. Security Architecture

Per PRD §3 invariant 4 + FR-5 honest scope.

### 7.1 What this cycle protects

| Threat | Mitigation | Test |
|---|---|---|
| Construct loaded from outside packs dir | Loader realpath-canonicalizes `executable.entry`; rejects path traversal | `loader.test.ts` |
| Construct calls service it didn't declare | Layer composition (FR-2 capability rule) makes undeclared Tags unavailable | `runtime.test.ts` + `sandbox-bridge.integration.test.ts` |
| Function/closure smuggled across worker boundary | Bridge envelope validation rejects non-structured-clone-safe types | `sandbox-bridge.test.ts` |
| Tag identity drift between loader and construct | Required Sprint 3 integration test imports real construct | `model-runner-layer.test.ts` (PAIR-POINT) |
| JWT cache returning stale validation | State-aware cache (FR-1 contract) with re-check on every cached read | `jwt-validator.test.ts` (10 fake-clock cases) |
| Capability widening via ambient services | Hard ambient allowlist (`{Logger, Clock}` only); doctrine amendment required to extend | `runtime.test.ts` |
| Phase 3 work leaking into cycle-032 | Explicit BARTH cuts + git diff assertion (criterion 5.14) | CI / `audit-sprint` |

### 7.2 What this cycle does NOT protect (deferred to `trust:vendor`/`trust:untrusted`)

- Direct Node built-in access from inside imported construct code (`import("node:fs")`, `process.exit()`, etc.)
- Network egress restrictions
- CPU/memory limits per construct (Phase 3 candidates: `process.cpuUsage`, `node --inspect`, isolated-vm `memory-limit`)
- Side-channel timing attacks
- Construct supply-chain integrity beyond JWT license signature

---

## 8. Integration Points

| External system | Direction | Integration |
|---|---|---|
| `loa-constructs` | read (Zod schema) | Loader uses `@loa-constructs/shared` Zod for manifest validation |
| `construct-base` | reference (JSON Schema) | Non-runtime; documentation only |
| `construct-lore-essay-grader` (instance-1) | read (E2E test) | Sprint 3 + Sprint 7 import the actual `gradeLoreEssay` |
| `freeside-quests/protocol` | read (Effect Schema) | `SubstrateStepVerdict` validation in `sandbox-bridge.ts` |
| `src/hounfour/cheval-invoker` | call (Promise-based) | Parent-side bridge handler invokes for `modelrunner.req` |
| `src/events/writer` | call (Promise-based) | Parent-side bridge handler invokes for `eventwriter.req` |
| `src/agent/sandbox` + `worker-pool` | call (Promise-based) | `sandbox-bridge.ts` dispatches via `WorkerPool.exec()` |

---

## 9. Deployment Architecture

No deployment changes this cycle. Runtime ships inside loa-finn binary; substrate-construct packs install via existing `/loa constructs install` flow (filesystem symlinks into `.claude/constructs/packs/`). Per PRD §4 BARTH cut: no `registry.constructs.network` publishing in cycle-032.

---

## 10. Testing Strategy

| Test type | Coverage | Tool |
|---|---|---|
| Unit (per file) | loader, jwt-validator, runtime, model-runner-layer, event-writer-layer, sandbox-bridge | vitest |
| Integration (cross-pack Tag matching) | Sprint 3 PAIR-POINT — imports real `gradeLoreEssay`, verifies Tag resolves | vitest |
| Integration (worker-pool round-trip) | sandbox-bridge.integration.test.ts — real WorkerPool + real worker_threads | vitest (no mocks) |
| E2E | `e2e.test.ts` — fixture packs dir + real construct-lore-essay-grader + TestModelRunner Layer | vitest |
| Lifecycle | Two workers, dispose-broadcast verification | vitest with WorkerPool harness |
| Property tests | None this cycle (BARTH cut — Phase 3 candidate) | — |

**Test fixtures**:
- `src/substrate/__tests__/fixtures/valid-construct/` — minimal valid construct.yaml + dummy entry.mjs
- `src/substrate/__tests__/fixtures/invalid-manifest/` — bad-manifest variants
- `src/substrate/__tests__/fixtures/symlink-or-copy-of-lore-essay-grader/` — for E2E

---

## 11. Development Phases (7 sprints serial)

Per PRD §6 + build doc §8 + sprint.md.

| Sprint | Files | Tasks | Hours |
|---|---|---|---|
| 1 | types.ts, loader.ts, jwt-validator.ts | 5 | 2-3 |
| 2 | runtime.ts (composition + lifecycle) | 4 | 1-2 |
| 3 | model-runner-layer.ts + cross-pack integration test (PAIR-POINT) | 4 | 2-3 |
| 4 | event-writer-layer.ts | 3 | 1-2 |
| 5 | sandbox-bridge.ts (NEW) + worker-runtime.ts (NEW) + sandbox-worker.ts mods | 3 | 2-3 |
| 6 | cli.ts + index.ts (programmatic API) | 4 | 1-2 |
| 7 | E2E test + doctrine §13 + memory entry (PAIR-POINT pre + post) | 3 | 1-2 |

**Total**: 26 tasks · 10-17 hours estimated · serial · per-sprint feature branch + PR.

---

## 12. Technical Risks & Mitigation

Per PRD invariants + Codex review history.

| Risk | Severity | Mitigation | Verification |
|---|---|---|---|
| Tag identity drift between loader and construct | HIGH | Strict Tag contract (PRD FR-3 table); Sprint 3 integration test imports real construct | model-runner-layer.test.ts |
| Sandbox-claim overreach (filesystem jail vs node:fs) | HIGH (mitigated) | PRD §3 invariant 4 narrowed; FR-5 honest scope; §4 BARTH cut explicit | reviewed in iteration 2 |
| ManagedRuntime memory leak across workers | MEDIUM | Per-worker dispose-broadcast (FR-2 lifecycle); test in `runtime.test.ts` | runtime.test.ts |
| JWT cache returns stale authorization | MEDIUM (mitigated) | State-aware cache (FR-1 contract); re-check on every read; 10-case fake-clock test | jwt-validator.test.ts |
| Effect-TS leaks into src/agent | MEDIUM | Module ownership table (FR-5); sandbox-worker stays Effect-free; worker-runtime owns Effect | code review + grep audit |
| Bridge serialization mismatch (JSON vs structured-clone) | MEDIUM (mitigated) | Bridge contract is structured-clone-safe (FR-5); type-specific payload schemas | sandbox-bridge.test.ts |
| Capability widening via ambient services | MEDIUM (mitigated) | Hard `AMBIENT_TAG_KEYS = ["Logger", "Clock"]` constant; runtime.ts asserts | runtime.test.ts |
| Worker dynamic-import incompatibility with sandbox | LOW (mitigated) | Spike validated GREEN at 14.58ms cold-start | scripts/substrate-spike.mjs |

---

## 13. Future Considerations (out of cycle-032)

Per PRD §4 BARTH cuts:
- **Phase 3 of cycle-032**: Kafka adapter (`KafkaWriter` Layer + Kafka consumer + `@confluentinc/kafka-javascript`)
- **Cycle-033 candidates** (operator decides): `trust:vendor` tier (`node --experimental-permission` OR `isolated-vm`); real-LLM `AnthropicModelRunner` Layer; cubquests-interface integration; construct-creation tooling/templating
- **Cycle-034+**: `trust:untrusted` tier (subprocess + microVM); multi-construct composition recipe; `registry.constructs.network` publishing

---

*Drafted 2026-05-03 PM as the cycle-032 SDD. Pairs with PRD v1.2.0. Build doc remains canonical for code samples and architecture detail; this SDD provides the integration view, interface signatures, and sprint sequencing.*
