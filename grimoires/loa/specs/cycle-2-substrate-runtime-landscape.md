# Cycle-2 Substrate-Runtime Landscape Report

**Date:** 2026-05-03
**Context:** loa-finn Cycle-2 substrate-construct loader kickoff
**Scope:** State-of-the-art research across four architectural questions
**Companion:** `cycle-2-substrate-runtime-codebase-survey.md` (internal grounding)

---

## Executive Summary

Four questions, four recommendations:

1. **Effect-TS dynamic loading** → Use `ManagedRuntime` per-construct + dynamic `import()` with normalized file URLs. Layers must be pure (no top-level side effects). Cache the runtime; dispose on construct unload. The `effect-mcp` and `EffectPatterns` repos are the closest production references, but no community has solved "JWT-licensed Effect plugin" — loa-finn would be one of the first.

2. **Kafka client** → `@confluentinc/kafka-javascript` (CJSK) is the right default for production substrates. It went GA in early 2026, ships librdkafka under the hood, and exposes both KafkaJS-shaped and node-rdkafka-shaped APIs. KafkaJS itself is fine for prototypes but loses on throughput + has had a maintenance lull. `@platformatic/kafka` is a recent pure-TS contender (223% faster than KafkaJS in benchmarks) worth watching but not yet battle-hardened.

3. **Isolation model** → Layered approach. Keep worker_threads as the *fast path* (untrusted-code-as-tool-result, current sandbox.ts shape). For *running adversarial Effect programs*, the only safe in-process option is `isolated-vm` (V8 isolates, same primitive as Cloudflare/Deno Deploy). For *truly untrusted constructs*, the industry has consolidated on Firecracker microVMs (AWS Lambda, Vercel Sandbox, Cloudflare Sandboxes). vm2 is dead (CVE-2026-22709, sandbox escape). `node:vm` is explicitly "not a security mechanism" per the maintainers. Three tiers: trusted (worker_threads) → semi-trusted (isolated-vm) → untrusted (microVM/container).

4. **JWT-licensed pack loading** → Validate at *load-time and per-invocation* with cached result. RS256 + JWKS is canonical (matches existing `constructs-integration.md`). For revocation: short TTL (24h) + grace period (already implemented for licenses) is the right pattern; introspection adds latency without much benefit at this scale. Sigstore + npm provenance is the industry direction for the *distribution* problem (verifying pack content matches source) — orthogonal to the *authorization* problem the JWT solves.

**Pull-threads worth re-research before sprint plan:**
- Does Pi SDK's session lifecycle conflict with `ManagedRuntime.dispose()` cleanup? (test before committing)
- `@confluentinc/kafka-javascript` + Bun compatibility (open issue #24258 as of 2026-05) — non-blocker for Node 22 deploy, blocker if Bun is target
- `isolated-vm` + Node 22 + worker_threads — known to work but operational complexity is high; consider if Phase-2 substrate can defer to subprocess isolation (cheaper, slower, simpler)
- Effect's `@effect/platform-node` is runtime-agnostic but doesn't ship a Kafka layer; the Kafka client lives outside Effect's Layer system today

---

## Question 1 · Effect-TS Dynamic Loading + Layer Composition

### State of the Art

**The canonical Effect-TS pattern for plugin-style loading does not exist as a published recipe.** The community has converged on three primitives that compose into a loader:

1. **`ManagedRuntime.make(layer)`** — Converts a `Layer<R>` into a long-lived `Runtime<R>` with explicit `dispose()` for cleanup. Documented as the recommended bridge for "frameworks with limited control over the entry point" (React, Remix, plugin systems). Source: [`ManagedRuntime.ts` docs](https://effect-ts.github.io/effect/effect/ManagedRuntime.ts.html).

2. **`Effect.provide(program, layer)` + `Effect.runPromise`** — The one-shot pattern. Each program gets its own layer instance. Layers are memoized by reference identity, so passing the same layer twice constructs services once. Source: [Effect docs](https://effect.website/docs/runtime/).

3. **Dynamic `import()`** — Standard ES module dynamic import. The TypeScript type narrowing returns `Promise<{ default: T }>` (or named exports). Effect itself does nothing special here — the construct file is loaded by the host JS runtime, then the exported `Effect.gen` program is invoked.

**Production references (closest to loa-finn's use case):**

- **EffectPatterns** ([github.com/PaulJPhilp/EffectPatterns](https://github.com/PaulJPhilp/EffectPatterns)) — Community knowledge base of Effect patterns. Closest pattern is "service-as-plugin" but no JWT-licensed plugin loader.
- **effect-mcp** ([deepwiki.com/tim-smart/effect-mcp](https://deepwiki.com/tim-smart/effect-mcp/5.2-effect-ts-patterns-and-best-practices)) — MCP server built with Effect. Demonstrates layered service composition and ManagedRuntime usage.
- **@akoenig/effect-remix** — Reference for ManagedRuntime in non-Effect-native frameworks; pattern transfers to "non-Effect runtime" of Pi SDK.

**Recommended canonical loader shape:**

```typescript
// substrate-construct-loader.ts (sketch)
import { Layer, ManagedRuntime, Effect } from "effect"
import type { ModelRunner } from "./construct-services.js"

interface LoadedConstruct {
  runtime: ManagedRuntime.ManagedRuntime<ModelRunner, never>
  invoke: <A, E>(program: Effect.Effect<A, E, ModelRunner>) => Promise<A>
  dispose: () => Promise<void>
}

async function loadConstruct(packDir: string): Promise<LoadedConstruct> {
  // 1. Validate JWT license (existing constructs-integration.md flow)
  await validateLicense(`${packDir}/.license.json`)

  // 2. Build the Layer with concrete impls of declared Tags
  //    Critical: Layer must be PURE (no top-level fs/http/process.env reads)
  const layer = Layer.mergeAll(
    ModelRunnerLive,        // Wraps Hounfour invoke
    SandboxAccessLive,      // Wraps ToolSandbox.execute
    KafkaPublisherLive,     // Wraps EventWriter
  )

  // 3. Create runtime (services constructed lazily on first use)
  const runtime = ManagedRuntime.make(layer)

  // 4. Dynamic-import the construct module
  //    file:// URL prevents path-traversal via require resolution
  const url = pathToFileURL(`${packDir}/dist/index.js`).href
  const mod = await import(url)
  if (typeof mod.default !== "function") {
    throw new Error(`Construct ${packDir} missing default export (Effect program)`)
  }

  return {
    runtime,
    invoke: (program) => runtime.runPromise(program),
    dispose: () => runtime.dispose(),
  }
}
```

### Tradeoffs

| Pattern | Pro | Con |
|---|---|---|
| `ManagedRuntime` per construct | Clean disposal, isolated services | Overhead per load (~ms); doesn't share connection pools across constructs |
| Single shared `ManagedRuntime` | One layer build, one connection pool | Construct unload requires cooperative cleanup; one bad construct affects all |
| `Effect.runPromise(program.pipe(Effect.provide(layer)))` per invocation | Simplest mental model | Layer rebuild per call; bad for hot path |
| `Layer.scoped` with `Scope` finalizers | Effect-idiomatic resource cleanup | Maps poorly to "load construct, run N times, unload" (Scope is per-Effect, not per-construct) |

**Failure modes documented in community sources:**

1. **Side-effects at import time** — If the construct file has `const db = await new Pool()` at module top level, `import()` will trigger that side effect *before* the Layer is provided. The pattern in [EffectPatterns repo](https://github.com/PaulJPhilp/EffectPatterns) is explicit: "Defer service initialization to `Effect.provide` at the application entry point." Loa-finn must enforce this in construct authoring docs.

2. **Layer ordering with `Layer.mergeAll`** — If `ServiceB` depends on `ServiceA` and you `Layer.mergeAll(ServiceB, ServiceA)`, the order doesn't matter (Layer resolves dependencies via Tag identity). But if both export the *same* Tag, the rightmost wins. This is the analog of the "rightmost provider wins" rule in `Effect.provide`.

3. **Scope leak via uncalled `dispose()`** — `ManagedRuntime` allocates resources (e.g., HTTP connection pools). Forgetting `await runtime.dispose()` on construct unload leaks Scopes. Loa-finn's session lifecycle (Pi SDK `SessionManager.close`) needs a hook to call `dispose()` per loaded construct.

4. **Type erasure across dynamic import** — `import()` returns `Promise<unknown>` in strict TS mode without explicit assertion. Without runtime schema validation (TypeBox/Zod/Effect Schema), you can't trust that the imported value is actually an `Effect.Effect<A, E, R>`. Recommend wrapping construct entry-point with TypeBox at the boundary.

5. **Circular Layer dependencies** — Effect detects these at runtime and fails fast (`MissingLayerCause`). Construct authors won't see this until their construct is loaded. Mitigation: ship a `construct-validate.sh` style preflight that boots the runtime in dev and runs a smoke `Effect.gen`.

### Recommendation for loa-finn

**Adopt `ManagedRuntime` per loaded construct, with shared lower-level services injected at runtime construction time.**

Specifically:

- The construct's exported `Effect.gen` program declares its required Tags (`ModelRunner`, `KafkaPublisher`, `Storage`).
- loa-finn provides the *Layer* (concrete impls) at load time. The Layer is built from finn's existing services (Hounfour as ModelRunner, EventWriter as KafkaPublisher).
- `runtime.runPromise(program)` is the per-invocation hot path. No layer rebuild.
- `runtime.dispose()` runs on construct unload (tied to Pi SDK session lifecycle).
- Cache the loaded construct (`{packDir, runtime, invokeFn}`) keyed by license-fingerprint + version; invalidate on license re-validation.

**Effort estimate:** Small. Effect-TS is purely additive in `src/agent/substrate-construct-loader.ts`; no migration of existing Promise-based code required. The hard part is the *contract* — what Tags do constructs depend on? — which is a doctrine question, not an Effect question.

**Sources:**
- [Managing Layers · Effect Documentation](https://effect.website/docs/requirements-management/layers/)
- [ManagedRuntime.ts · effect-ts.github.io](https://effect-ts.github.io/effect/effect/ManagedRuntime.ts.html)
- [Introduction to Runtime · Effect Documentation](https://effect.website/docs/runtime/)
- [EffectPatterns · GitHub](https://github.com/PaulJPhilp/EffectPatterns)
- [Multi-Runtime Platform Architecture · DeepWiki](https://deepwiki.com/Effect-TS/effect/5.1-multi-runtime-platform-architecture)
- [Effect-TS in 2026 · DEV](https://dev.to/ottoaria/effect-ts-in-2026-functional-programming-for-typescript-that-actually-makes-sense-1go)

---

## Question 2 · Kafka Consumer Patterns for Substrate-Shaped Pub/Sub

### State of the Art

**The Node.js Kafka client landscape consolidated in 2026.** Three viable choices:

| Client | Backed by | Throughput | TS support | Last release | Notes |
|---|---|---|---|---|---|
| **`@confluentinc/kafka-javascript` (CJSK)** | Confluent (official) | Native (librdkafka) | First-class | GA 2026 Q1 | Wraps librdkafka. KafkaJS-compatible API. Confluent Schema Registry + CSFLE built in. Node 18-24. Open issue with Bun (#24258). |
| **`kafkajs`** | Tulios (community) | Pure TS, slower | Native | Maintenance lull (issues open since 2024) | Most-deployed historically. Simpler API. 53% slower than CJSK in batch scenarios. |
| **`@platformatic/kafka`** | Platformatic (vendor) | Pure TS, optimized | First-class | Active 2026 | 223% faster than KafkaJS in their benchmarks. Newer (2025 launch). Smaller ecosystem. |
| **`node-rdkafka`** | Blizzard (community) | Native (librdkafka) | Add-on types | Maintenance | Predecessor to CJSK. Use CJSK instead for new code. |

**Effect-TS native Kafka layer:**
- **Does not exist as of 2026-05.** No `@effect/kafka` or `@effect/cluster-kafka` package in the Effect-TS monorepo or community packages. `@effect/cluster` exists but is for distributed Effect runtimes, not Kafka transport.
- Pattern: Wrap CJSK or kafkajs as an Effect Tag (`KafkaConsumer`, `KafkaProducer`) with Layer impls. This is what Effect users do in production today.

**Topic naming convention `{aggregate}.{noun}.{verb}`:**
- This shape is consistent with Apache Kafka best practices for multi-tenancy. Apache Kafka docs explicitly recommend "namespace by convention; use prefix ACLs to enforce."
- DoorDash's published pattern uses tenant-tagged messages on shared topics with tenant filtering at the consumer. Gong publishes a similar pattern.
- For loa-finn's use case (per-construct topic shape): `agent.lore-essay.submission` is well-formed. Recommendation: add a tenant prefix in production: `{tenant}.agent.lore-essay.submission` with prefix ACLs per tenant.

**Consumer group strategy (industry consensus):**
- **One consumer group per construct** (not per pool, not per tenant). Rationale: offset management and rebalancing are scoped per group; stopping one construct shouldn't stop others.
- Multiple instances of the same construct (horizontal scale) join the same group → kafka load-balances partitions across them.
- "One topic per consumer group" is the canonical pattern (per [Conduktor](https://www.conduktor.io/glossary/multi-tenancy-in-kafka-environments)) — when you need to reset offsets, kafka forces you to stop consumption from all topics in the group, so co-locating topics in groups creates operational pain.

**Backpressure + concurrency:**
- CJSK exposes `eachBatch` and `eachMessage` handlers; kafkajs exposes the same. Concurrency is bounded by partition count (one partition = one consumer = one in-flight message at a time per consumer in the group).
- For "N concurrent invocations per construct": configure partition count = desired concurrency. Don't try to parallelize within a single partition handler (breaks ordering guarantees).
- Pause/resume APIs let the consumer apply backpressure against the construct's downstream (e.g., if the LLM pool is rate-limited, the consumer should `pause(topic)` until budget recovers).

**Failure handling — DLQ pattern (industry consensus 2026):**
- **Manual error classification** is the right default. Distinguish transient (network, rate-limit, downstream timeout) from permanent (schema violation, business-rule violation).
- **Transient errors:** retry with exponential backoff inside the consumer; if max-retries exceeded, send to DLQ.
- **Permanent errors:** send to DLQ immediately, no retry.
- **DLQ topic naming:** `{original-topic}.dlq` is the convention. e.g., `agent.lore-essay.submission.dlq`.
- **Monitoring:** Alert on DLQ topic message rate (any sustained inflow indicates systemic issue).
- **Replay tooling:** Build a "DLQ-to-source-topic" replayer that the operator can fire after fixing the root cause.

### Composition with Typed-Streams Convention

The cycle-002 typed-streams (`Signal`, `Verdict`, `Artifact`, `Intent`, `Operator-Model`) are JSONL schema types declared in `construct.yaml` for *skill-pack* composition. They live in append-only JSONL trajectory files today.

**For substrate-constructs riding Kafka, the natural mapping is:**

| Typed-stream | Kafka topic shape | Direction |
|---|---|---|
| `Intent` | `{tenant}.intent.{intent-name}` | Operator → substrate-constructs (orchestration) |
| `Signal` | `{tenant}.{aggregate}.{source}.signal` | Substrate-constructs ← observers (input) |
| `Verdict` | `{tenant}.{aggregate}.{construct}.verdict` | Substrate-constructs → downstream (output) |
| `Artifact` | `{tenant}.{aggregate}.{construct}.artifact` | Substrate-constructs → content-addressable storage (output) |
| `Operator-Model` | `{tenant}.operator.session.context` | Substrate-constructs ← session manager (input, every stage) |

Each Kafka message envelope embeds the typed-stream JSONL document as the payload, with `stream_type` and `schema_version` as message headers (so consumers can filter without payload deserialization). The existing `EventEnvelope` shape in `src/events/types.ts` already supports this — `event_type` field can carry `signal`, `verdict`, etc.

This composes cleanly: skill-packs (running in Claude Code harness) write JSONL → trajectory files. Substrate-constructs (running in Finn) write JSONL → Kafka topics → (optionally tee'd to JSONL trajectory). The schema is the same; the transport is different.

### Tradeoffs

| Decision | Pro | Con |
|---|---|---|
| **CJSK** as default client | Native perf, official support, Schema Registry built-in, KafkaJS-compatible API for migration | C++ binding adds build complexity (postinstall download); Bun unsupported (open issue #24258) |
| **KafkaJS** as default client | Pure TS, no native deps, simple to deploy | 50%+ throughput penalty; maintenance lull |
| **`@platformatic/kafka`** as default | Fastest, pure TS | Less battle-tested; smaller community; vendor-controlled |
| **One consumer group per construct** | Independent rebalancing, offset reset isolated | More groups to manage; harder to share infrastructure |
| **One consumer group per tenant** | Fewer groups | Tenant noisy-neighbor: one bad construct stalls all tenant's constructs |
| **Wrap client as Effect Tag** | Composes with Effect-program constructs; testable via Layer.test | Custom code to write/maintain; no upstream maintenance |
| **DLQ-per-topic** | Replay scope is precise | More topics to monitor |
| **DLQ-shared** | Fewer topics | Replay is messy; can't reset offset for one source independently |

### Recommendation for loa-finn

**Default:** `@confluentinc/kafka-javascript` wrapped as Effect Tags (`KafkaConsumer`, `KafkaProducer`) with `Live` layer impls in `src/events/kafka-effect-layer.ts`.

**Topology:**
- Topic shape: `{tenant}.{aggregate}.{noun}.{verb}` (4 segments; tenant is the new prefix). Backwards-compatible with construct.yaml declarations that omit tenant — the loader injects it.
- One consumer group per construct (`{tenant}.{construct-id}.consumer`). Match construct's tenant ACL allowlist.
- Per-construct DLQ: `{tenant}.{aggregate}.{noun}.{verb}.dlq` with manual classification (transient retry inside consumer, permanent → DLQ immediately).
- Backpressure: use `pause(topic)` when Hounfour budget circuit opens; `resume(topic)` when budget recovers.

**Concurrency model:**
- Partition count = desired concurrent invocations per construct. Default 4.
- Each consumer instance handles one partition at a time (kafka guarantee).
- Inside the partition handler: invoke `runtime.runPromise(program)` (single Effect execution per message; no in-handler parallelism).

**Effort estimate:**
- CJSK install + Effect Layer wrappers: ~200 LOC
- Topic naming conventions doctrine page: ~50 LOC docs
- DLQ pattern + replayer: ~150 LOC
- Total Phase-2 Kafka work: ~400 LOC + 1-2 days operational tuning

**Alternative if Bun is a target:** Stay on `kafkajs` (pure TS, Bun-compatible) and accept the throughput penalty. Re-evaluate CJSK once Bun issue closes.

**Sources:**
- [Confluent Kafka JavaScript Client GA](https://www.confluent.io/blog/introducing-confluent-kafka-javascript/)
- [Why we created another Kafka client for Node.js · Platformatic](https://blog.platformatic.dev/why-we-created-another-kafka-client-for-nodejs)
- [How We Made @platformatic/kafka 223% Faster](https://blog.platformatic.dev/how-we-made-platformatickafka-223-faster-and-what-we-learned-along-the-way)
- [Multi-Tenancy · Apache Kafka Operations](https://kafka.apache.org/42/operations/multi-tenancy/)
- [Setting up Kafka multi-tenancy · DoorDash](https://careersatdoordash.com/blog/setting-up-kafka-multi-tenancy/)
- [How to Implement Dead Letter Queue Patterns · OneUptime](https://oneuptime.com/blog/post/2026-02-09-dead-letter-queue-patterns/view)
- [Kafka Connect DLQ deep dive · Confluent](https://www.confluent.io/blog/kafka-connect-deep-dive-error-handling-dead-letter-queues/)
- [Pros and Cons of Multiple Topics vs One Topic per Consumer Group · Zenduty](https://community.zenduty.com/t/pros-and-cons-of-having-multiple-topics-vs-one-topic-per-consumer-group/738)
- [@confluentinc/kafka-javascript Bun issue #24258](https://github.com/oven-sh/bun/issues/24258)

---

## Question 3 · Sandbox Isolation Models for Executable Effect Programs

### State of the Art

**The hierarchy of isolation primitives in 2026, ordered by strength:**

| Tier | Primitive | Strength | Latency | Used by |
|---|---|---|---|---|
| 0 | None (in-process) | None | <1 μs | Trusted libraries |
| 1 | `node:vm` Context | Weak (not a security boundary per Node maintainers) | ~10 μs | Templating, expression eval |
| 2 | Worker thread | Same-process, separate event loop | ~100 μs | loa-finn current sandbox |
| 3 | `isolated-vm` (V8 isolates) | Same-process, separate V8 heap | ~1 ms | Cloudflare Workers, Deno Deploy, Algolia, Fly CDN |
| 4 | Subprocess (`child_process`) | OS process boundary | ~10 ms | loa-finn fallback executor |
| 5 | Container (Docker) | Linux namespaces + cgroups | ~100 ms | Most current "sandbox" services |
| 6 | microVM (Firecracker) | Hypervisor + minimal kernel | ~125 ms boot, sub-ms steady state | AWS Lambda, Vercel Sandbox, Cloudflare Sandboxes, Daytona |

**Critical 2026 events:**

- **`vm2` is dead** ([CVE-2026-22709, CVSS 9.8](https://thehackernews.com/2026/01/critical-vm2-nodejs-flaw-allows-sandbox.html)). Sandbox escape via Promise callback sanitization gap. Maintainers explicitly state: "we recommend isolated-vm or containerized applications" for new code.

- **`node:vm` is not a security mechanism.** Node.js docs were strengthened in 2024-2025 to make this explicit. Function constructor escape is a classic vector. SourceTextModule has the same fundamental issue (separate context, same process, shared GC, shared event loop).

- **Cloudflare Dynamic Workers (April 2026)** — V8 isolate-based sandbox tier specifically for AI agent code execution. 100x faster than container-based sandboxes (advertised). Uses Cloudflare's existing per-tenant cordoning model (free vs enterprise tenants never share processes).

- **Vercel Sandbox** — Ephemeral compute for untrusted/AI-generated code. Likely Firecracker under the hood.

- **Node.js 22 Permission Model** — `--permission` flag (no longer experimental in 23.5+). Restricts fs/net/process/worker_threads access. Granular per-resource flags. Useful as defense-in-depth but not a sandbox per se (process-scoped, not module-scoped).

**Threat model for adversarial Effect program:**

An Effect program loaded via `import()` runs in the same V8 context as loa-finn (worker_threads share isolate per-thread, not per-module). The threats:

1. **`process.env` exposure** — Effect program can read `process.env.ANTHROPIC_API_KEY`. Existing `SecretRedactor` redacts in *output* but doesn't prevent *read*.
2. **Direct `fs` import** — `import { readFileSync } from "node:fs"` works without restriction. FilesystemJail only protects sandboxed subprocess paths, not in-process module file access.
3. **Direct `net`/`http` import** — Construct can connect anywhere. Existing sandbox doesn't restrict outbound network from main thread.
4. **`process.kill()`** — Construct can terminate the main process. Or worse, `process.kill(-pid)` to kill process group.
5. **Prototype pollution** — Via `Object.prototype.foo = badThing`, affects all subsequent code in same isolate.
6. **Resource exhaustion** — Infinite loop, unbounded memory allocation, etc.

**Comparison of tier-3 options:**

- **`isolated-vm`** ([npm](https://www.npmjs.com/package/isolated-vm), [github](https://github.com/laverdet/isolated-vm)) — V8 isolates wrapped for Node.js. Same primitive Cloudflare Workers and Deno Deploy use. Each isolate has its own heap, its own globals, its own GC. Inter-isolate communication is explicit (copy-only, no shared references). Used by Algolia (custom crawlers) and Fly CDN (dynamic endpoints) in production. Operational complexity: high (memory limits, ABI compat with Node releases, native module).

- **Cloudflare Workers (V8 isolates + tenant cordoning + MPK)** — Defense-in-depth: V8 isolate (layer 1) + Linux namespaces/seccomp (layer 2) + tenant cordoning (free vs enterprise never co-located) + Memory Protection Keys (hardware trap on cross-isolate read attempts, 92% of Spectre-class bugs caught). Loa-finn is unlikely to replicate all of this, but the principle "defense in depth, not single layer" is the takeaway.

- **Deno permissions model** — `--allow-fs=/path`, `--allow-net=host:port`, etc. Granular. But Deno is the runtime; you can't load a Deno-permissioned module from inside Node.

- **Node.js Permission Model (v22+)** — `--permission`, `--allow-fs-read=/path`, `--allow-fs-write=/path`. Process-level, not module-level. Useful for the Finn process as a whole; doesn't isolate one construct from another.

**Capability-bounded runtimes (Snowflake Native Apps, Salesforce LWC):**

- Snowflake Native Apps Framework runs apps inside Snowflake's data plane with explicit capabilities (which warehouses, which schemas, which UDFs). Users grant capabilities at install time. Strong precedent for *capability-as-license* model.
- Salesforce LWC uses the Lightning Web Runtime — a minimal, security-hardened JS runtime with ahead-of-time compilation. Not directly applicable but the principle (constrained API surface) is.

### Tradeoffs

| Approach | Pro | Con |
|---|---|---|
| **Worker thread (current)** + dynamic import | Already implemented; fast | Same V8 isolate as main thread → no protection against malicious in-process code |
| **`isolated-vm` per construct** | Strong isolation, V8-native | High operational complexity; native module rebuilds per Node version; memory limits hard to tune |
| **Subprocess (child_process)** per construct | OS-level isolation; existing executor pattern works | ~10-100ms overhead per invocation; IPC marshalling cost |
| **Firecracker microVM per construct** | Strongest isolation; AWS-grade | Requires KVM host (no macOS dev); operational ownership of microVM lifecycle |
| **Container per construct** | Strong isolation, good tooling | ~100ms boot; Docker daemon dependency |
| **Capability-bounded API** (no fs/net/process exposed) | Construct can ONLY do what loa-finn permits | Requires curating an explicit API surface for constructs (significant doctrine work) |

### Recommendation for loa-finn

**Three-tier isolation model, opt-in per construct via license/manifest:**

| Tier | Isolation | Use case | Construct manifest |
|---|---|---|---|
| **trust:internal** | worker_threads (current) | First-party constructs (loa, 0xHoneyJar) | `trust: internal` in construct.yaml |
| **trust:vendor** | subprocess + Node `--permission` | Third-party but vetted (signed SLA, named vendor) | `trust: vendor` in construct.yaml; vendor JWT |
| **trust:untrusted** | `isolated-vm` OR subprocess+microVM | Public marketplace constructs | `trust: untrusted` in construct.yaml; minimal capabilities |

**Phase-2 implementation (minimum viable):**

1. **Default tier = trust:internal** for all bootstrap constructs. Use existing worker_threads. This unblocks lore-essay-grader and similar trusted use cases.
2. **Capability-bounded API** for all tiers — the *Layer* loa-finn provides to constructs is the API surface. If `Layer` doesn't include a `FileSystem` Tag, the construct can't do filesystem I/O *within the Effect program*. This is structural, not enforced — but it's the right doctrine.
3. **Construct manifest declares `requires:`** — list of Tags the construct's Effect program will request. Loader rejects loads where requested Tags exceed the trust tier's capability set.

**Phase-3+ implementation (when first marketplace construct ships):**

4. Add `isolated-vm` for `trust:untrusted`. Wrap each loaded construct in its own isolate. Marshal Effect program inputs/outputs as JSON across the isolate boundary (copy-only).
5. OR: Subprocess + Node `--permission` flags scoped per-construct. Cheaper to implement than `isolated-vm`, weaker isolation but tractable.

**Rejected approaches:**

- `vm2`: dead (CVE-2026-22709)
- `node:vm` SourceTextModule alone: not a security boundary per maintainers
- Container per construct: too heavy for per-invocation isolation
- Firecracker microVM in Phase-2: KVM host requirement breaks macOS dev; defer to "vendor sandbox" tier on Lambda/Vercel/Cloudflare

**The "simplest path that gives meaningful isolation":** Don't try to make in-process Node sandboxing work for adversarial code. For the trusted/vendor tiers, the structural protection of *capability-bounded Layer* is the meaningful isolation — the Effect program literally cannot import services not in its declared `requires:` list (because they're not in the Layer the loader provides). For the untrusted tier, defer to subprocess + Node `--permission` first; upgrade to `isolated-vm` only when load justifies the operational complexity.

**Sources:**
- [Cloudflare Workers Security Model](https://developers.cloudflare.com/workers/reference/security-model/)
- [Sandboxing AI agents, 100x faster · Cloudflare](https://blog.cloudflare.com/dynamic-workers/)
- [CVE-2026-22709 vm2 sandbox escape · The Hacker News](https://thehackernews.com/2026/01/critical-vm2-nodejs-flaw-allows-sandbox.html)
- [New Sandbox Escape Affecting vm2 · Semgrep](https://semgrep.dev/blog/2026/calling-back-to-vm2-and-escaping-sandbox/)
- [Node.js vm module security concerns · Snyk](https://snyk.io/blog/security-concerns-javascript-sandbox-node-js-vm-module/)
- [isolated-vm · npm](https://www.npmjs.com/package/isolated-vm)
- [11 Best Sandbox Runners in 2026 · Better Stack](https://betterstack.com/community/comparisons/best-sandbox-runners/)
- [Firecracker microVMs · AWS Open Source Blog](https://aws.amazon.com/blogs/opensource/firecracker-open-source-secure-fast-microvm-serverless/)
- [Lambda Tenant Isolation Mode](https://www.dataa.dev/2026/02/28/aws-lambda-tenant-isolation-mode-multi-tenant-saas-2/)
- [Node.js 22 Permission Model · johal.in](https://johal.in/deep-dive-nodejs-22-implements-experimental-permission-model/)
- [Permissions · Node.js v25 docs](https://nodejs.org/api/permissions.html)
- [Deno Security and permissions](https://docs.deno.com/runtime/fundamentals/security/)

---

## Question 4 · JWT-Licensed Pack Loading

### State of the Art

**Existing loa-constructs convention** (per `constructs-integration.md`):
- RS256 JWT signed by registry private key
- Public key fetched from registry, cached at `~/.loa/cache/public-keys/{key_id}.pem`
- Validation: header.kid → fetch key → verify signature → check exp → tier-based grace period (24h individual/pro, 72h team, 168h enterprise)
- Validation timing: at *load time* during `/setup` or skill discovery
- Offline support: cached public key + grace period

**Industry parallels:**

| System | Mechanism | Loa-finn analog |
|---|---|---|
| **npm package signing (Sigstore)** | Sigstore-signed provenance attestation linking source → binary; verified via Rekor transparency log | Verifies the *content* of a pack matches what the vendor published. Orthogonal to JWT (which authorizes the buyer). |
| **Mac App Store code signing** | Developer cert signs binary; OS verifies on launch + periodically; revocation via OCSP | RS256 JWT signs license, validated on load + grace period. Equivalent shape. |
| **JWT introspection (OAuth2 RFC 7662)** | Server-side check of token validity per request | Higher latency, real-time revocation. Not needed if TTL is short. |
| **Short TTL + rotation** | Tokens expire quickly (5-15min for access tokens); refresh token issues new ones | The default for stateless validation. Loa-constructs uses 24h-7d depending on tier. |

**JWT validation timing — load-time vs per-invocation:**

The choice has tradeoffs:

| Timing | Pro | Con |
|---|---|---|
| **Load-time only** | Zero per-invocation cost | Revocation lag = entire process lifetime (until next load) |
| **Per-invocation** | Real-time revocation | Latency on hot path (signature verify is ~1ms) |
| **Load-time + cached refresh** | Low hot-path cost; bounded revocation lag | More complex; requires invalidation strategy |

**Recommended hybrid (per industry consensus, see [JWT Revocation Strategies · Drozd](https://www.michal-drozd.com/en/blog/jwt-revocation-strategies/)):**

- Validate at load time (full RS256 verify).
- Cache validation result with TTL = min(license.exp, configured TTL like 1h).
- On each invocation: cheap cache lookup. If TTL expired, re-validate from cached public key (no network call).
- On `LOA_OFFLINE=1`: skip TTL checks, use cached result until license.exp.

**Revocation patterns:**

- **JWT introspection** (per-request HTTP check to authorization server): Strong revocation, high latency. Justified only if license abuse is a real threat with high impact.
- **Short TTL + grace period** (current loa-constructs pattern): Bounded revocation lag (24h-7d). Suitable for most cases. Operator must coordinate with vendor: revoke = "stop renewing."
- **JWT versioning** (jti claim + revocation list): Maintain a small revocation list, check jti against it. Hybrid between TTL and introspection. Useful for "revoke this specific license" without affecting the whole tier.

**Sigstore + npm provenance:**
- Solves a *different* problem from JWT licensing. JWT says "this user is authorized to load this pack." Sigstore says "this pack file matches what the vendor published; nobody tampered with it in transit/storage."
- For loa-constructs / loa-finn: both are valuable. JWT is the entitlement layer; Sigstore is the supply-chain integrity layer.
- Adoption status: npm ships Sigstore-signed provenance via `npm publish --provenance`. GitHub Actions and GitLab CI/CD generate the attestation. Verification via `npm audit signatures` or programmatic `sigstore-js`.

### Tradeoffs

| Decision | Pro | Con |
|---|---|---|
| **Load-time JWT validation only** | Zero hot-path cost | Revocation requires process restart; bad for long-running Finn process |
| **Per-invocation JWT validation** | Immediate revocation | ~1ms latency per construct invocation; CPU cost adds up at scale |
| **Load-time + cached refresh (recommended)** | Low cost, bounded revocation | Implementation complexity |
| **Sigstore on top of JWT** | Tamper-evident pack distribution; supply-chain provenance | Requires Sigstore tooling in publish pipeline; another verification step |
| **JWT introspection endpoint** | Real-time revocation | Network call per check; auth server availability dependency |
| **Short TTL (1-24h) + auto-refresh** | Stateless; bounded lag; matches industry default | Requires refresh endpoint; offline grace period management |
| **Long TTL (7-30d) + revocation list** | Survives long offline periods | Revocation list becomes a synchronization problem |

### Recommendation for loa-finn

**Adopt load-time + cached refresh, with explicit per-invocation re-check on cache miss.**

Specifically:

1. **Load time** (existing `constructs-integration.md` flow):
   - Read `.license.json`
   - Verify RS256 signature against cached public key (network fetch if not cached)
   - Check exp + grace period
   - Cache validation result keyed by `(license-fingerprint, cached-at)` with TTL = min(license.exp, 1h)
   - Reject load if invalid/expired beyond grace.

2. **Per-invocation** (substrate-construct loader hot path):
   - Lookup cached validation result for loaded construct
   - If TTL expired: re-validate (no network — uses cached public key). ~1ms.
   - If license expired beyond grace: dispose construct runtime (`runtime.dispose()`), reject invocation with `LICENSE_EXPIRED` error
   - Else: proceed with `runtime.runPromise(program)`

3. **Revocation strategy (Phase 2):**
   - Default: rely on TTL + grace period. Operator revokes = vendor stops renewing. 24h-7d lag depending on tier.
   - Optional: maintain a small JWT revocation list (`~/.loa/cache/revoked-jti.json`). Refresh from registry every 1h. Per-invocation cache lookup checks jti against list. Adds ~1μs to hot path; bounded by revocation list size.
   - Avoid full introspection-per-request unless threat model justifies it.

4. **Supply-chain integrity (Phase 3):**
   - Adopt Sigstore for pack publication. Each pack ships a Sigstore-signed manifest of file checksums.
   - Loader verifies pack file checksums against manifest at load time (one-time cost).
   - Provenance link: pack source repo → CI build → published artifact. Verifiable via Rekor.
   - This is independent of JWT; both layers run in parallel.

5. **Failure modes to plan for:**
   - **License expired mid-session:** Dispose runtime, surface clear error. Don't silently fail.
   - **Public key rotation:** Cache TTL on public key (24h default) means old key is replaced; old licenses signed by old key fail validation. Document rotation procedure.
   - **Offline operator:** `LOA_OFFLINE=1` skips network refresh; uses cached key + cached validation result. Already implemented in constructs-integration.md.
   - **Clock skew:** JWT exp uses Unix timestamps. If Finn process clock is ahead, valid licenses appear expired. Use NTP; tolerate ±60s skew.

**Effort estimate:**
- Cached validation layer in substrate-construct-loader: ~100 LOC
- Reuse existing `.claude/scripts/license-validator.sh` for load-time check
- Sigstore integration: ~200 LOC + CI changes (Phase 3, defer)
- Total Phase-2 license work: ~150 LOC + existing scripts

**Sources:**
- [Constructs Integration Protocol · loa-constructs](https://github.com/0xHoneyJar/loa-constructs/blob/main/.claude/protocols/constructs-integration.md) (internal)
- [JWT Revocation Strategies · Drozd](https://www.michal-drozd.com/en/blog/jwt-revocation-strategies/)
- [Choosing Between JWKS and Token Introspection · DEV](https://dev.to/mechcloud_academy/choosing-between-jwks-and-token-introspection-for-oauth-20-token-validation-1h9d)
- [JWT Security Best Practices for 2026 · DevToolKit](https://www.devtoolkit.cloud/blog/jwt-security-best-practices-2026)
- [How to Manage JWT Expiration and Revoke JWTs · FusionAuth](https://fusionauth.io/articles/tokens/revoking-jwts)
- [Introducing npm package provenance · GitHub Blog](https://github.blog/security/supply-chain-security/introducing-npm-package-provenance/)
- [npm + Sigstore: Making Javascript secure by default · Chainguard](https://www.chainguard.dev/unchained/npm-sigstore-making-javascript-secure-by-default)
- [sigstore-js · GitHub](https://github.com/sigstore/sigstore-js)
- [Generating provenance statements · npm Docs](https://docs.npmjs.com/generating-provenance-statements/)

---

## Cross-Cutting Themes

### 1. Layer-as-Capability is the Unifying Doctrine

Across all four questions, the same pattern surfaces: **the Layer the loader provides IS the construct's capability set.**

- Effect-TS: Layer declares which Tags are concretely implemented. If `FileSystem` Tag isn't in the Layer, the construct can't do `yield* FileSystem`.
- Kafka: Layer declares which `KafkaProducer` (with which topic ACLs) is provided. Construct can only publish where the producer allows.
- Sandbox: Layer is the structural enforcement of "what the construct can call." More restrictive Layer = more restrictive construct.
- License: License declares which tier of Layer the construct gets. Higher tier = richer Layer = more capabilities.

This is the same pattern as Snowflake Native Apps Framework's capability model. It's the right doctrine.

### 2. Defense-in-Depth, Not Single-Layer Security

vm2's death is the cautionary tale: a single isolation primitive will fail. Cloudflare's model (V8 isolate + Linux namespaces + tenant cordoning + MPK + tier separation) is overkill for loa-finn but the *principle* is right.

Loa-finn's sandbox.ts already has multiple layers (filesystem jail + command allowlist + worker thread + secret redactor). Add to this for substrate-constructs: capability-bounded Layer + license validation + (Phase-3) isolated-vm or microVM.

### 3. Trust-Tier Differentiation

Don't try to apply "untrusted code" isolation to first-party constructs. The complexity cost is too high.

Phase 2: ship trusted-only (`trust: internal`) constructs with worker_threads + capability-bounded Layer. This is enough for lore-essay-grader and named vendor partnerships.

Phase 3: when the first marketplace construct from an unvetted vendor ships, add the `trust: untrusted` tier with isolated-vm or subprocess+microVM.

### 4. Effect-TS as the Construct ABI

The Effect program signature `Effect.Effect<A, E, R>` IS the contract. `R` declares what the construct needs; `A` declares what it returns; `E` declares what it can fail with. This is sufficient for most safety guarantees *if* the Layer is curated.

This means construct authoring requires teaching: what Tags exist, what they mean, what tier they're available at. The doctrine page is more important than the runtime code.

### 5. Pull-Threads for Re-Research

Before committing to sprint plan:

1. **Pi SDK + ManagedRuntime lifecycle interaction** — does `runtime.dispose()` block on in-flight Effects? What if Pi SDK session closes mid-Effect? Test in a spike.
2. **CJSK + Bun** — open issue #24258. If Bun is a near-term target (e.g., for edge deploy), this is a blocker. Confirm with operator.
3. **isolated-vm operational complexity** — read post-mortems from Algolia and Fly. Memory limit tuning is non-trivial.
4. **Effect's planned Kafka layer** — search Effect-TS GitHub issues/discussions for "kafka" — is one in flight? If so, wait or contribute. If not, our Tag wrapper sets the de facto pattern.
5. **Sigstore + private packs** — Sigstore's transparency log is public. For private, paid constructs, this might leak metadata. Confirm threat model.

---

## Appendix: Recommended Substrate-Construct Manifest Schema (v0)

For the next sprint to formalize:

```yaml
# .claude/constructs/packs/lore-essay-grader/construct.yaml
apiVersion: v1
kind: SubstrateConstruct
metadata:
  name: lore-essay-grader
  vendor: 0xhoneyjar
  version: 0.3.0
  license: ./.license.json
spec:
  trust: internal      # internal | vendor | untrusted
  entryPoint: ./dist/index.js
  effect:
    requires:
      - ModelRunner    # Tag from @loa/finn-construct-api
      - Storage        # Tag from @loa/finn-construct-api
    provides:
      - LoreEssayGraderService
  kafka:
    consumes:
      - aggregate: agent
        noun: lore-essay
        verb: submission
        consumerGroup: ${tenant}.lore-essay-grader
    produces:
      - aggregate: agent
        noun: lore-essay
        verb: verdict
  pool:
    preferred: reasoning
    fallback: [fast-code, cheap]
  budget:
    maxCostCentsPerInvocation: 10
    maxLatencyMs: 30000
streams:
  reads: [Signal, Intent, Operator-Model]
  writes: [Verdict, Artifact]
schema:
  inputSchema: ./schemas/submission.schema.json
  outputSchema: ./schemas/verdict.schema.json
```

The loader would parse this, validate against `.claude/schemas/substrate-construct.schema.json`, build the appropriate Layer (with only the requested capabilities), validate the JWT license, and register with Hounfour as a tool definition.

---

## Document Status

| Field | Value |
|---|---|
| Status | Draft, ready for cycle-2 sprint planning |
| Confidence | 0.7 (well-grounded in documented patterns; not yet validated against loa-finn spike) |
| Load-bearing | Yes (intended to anchor architecture decisions for Phase-2 substrate-construct loader) |
| Next step | Spike: Effect ManagedRuntime + dynamic import + cached license check + worker_thread invocation. Time-box 1 day. Validate or invalidate the four recommendations. |
