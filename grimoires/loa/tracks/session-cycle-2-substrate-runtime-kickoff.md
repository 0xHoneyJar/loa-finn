---
session: cycle-2-substrate-runtime
date: 2026-05-03
type: kickoff
status: planned
target_repo: loa-finn
parent_cycle: cycle-1-substrate-integration (closed 2026-05-03 PM)
---

# Cycle-2 substrate-runtime — kickoff (planned)

## Scope

- Ship the **substrate-construct loader** in `src/substrate/` — filesystem scan + manifest validation + JWT licensing + dynamic-import + ManagedRuntime composition
- Ship the **Effect Layer bridges**: `ModelRunner` (wraps `cheval-invoker`) and `EventWriter` (wraps existing EventStore append-only writer)
- Ship the **sandbox integration** so substrate-construct invocations run in the existing 2-worker interactive lane with capability-bounded Layers
- Ship the **CLI surface** (`loa-finn substrate-construct invoke <slug>`) and **programmatic API** (`Substrate.invoke()`)
- 7 sprints serial · 1-3 hours each · half-day to full-day budget
- BARTH cuts named: NO Kafka cluster setup (adapter is Sprint 8 / Phase 3) · NO `trust:vendor`/`trust:untrusted` tiers · NO real LLM ModelRunner · NO Effect adoption outside `src/substrate/`

## Artifacts

- **Build doc** (source of truth): `grimoires/loa/specs/cycle-2-substrate-runtime-build.md`
- **Codebase survey**: `grimoires/loa/specs/cycle-2-substrate-runtime-codebase-survey.md` (Explore agent · 416 lines)
- **Landscape research**: `grimoires/loa/specs/cycle-2-substrate-runtime-landscape.md` (Agent + WebSearch · 572 lines)
- **Cycle-1 doctrine** (prior context): `~/vault/wiki/concepts/substrate-mental-model-for-product-builders.md` §12 first execution learnings

## Prior session (cycle-1 substrate-integration · closed 2026-05-03 PM)

3 PRs merged · 4 deliverables shipped:
- `0xHoneyJar/construct-lore-essay-grader` (PUBLISHED · BORGES persona · instance-1 of `type: substrate-construct`)
- `0xHoneyJar/construct-base#12` (JSON Schema for substrate-construct + 4 new fields + conditional allOf)
- `0xHoneyJar/loa-constructs#223` (Zod manifest schema + 11 tests + superRefine conditional · 79 total pass)
- `0xHoneyJar/freeside-quests#1` (`@freeside-quests/protocol` + `@freeside-quests/engine` · in-process pipeline · 11 dispatch tests)
- Doctrine §12 (~150 lines · 5 corrections · operator-coined "constructs are agents" reframe ratified)
- Memory entry `project_substrate_layer_integration_cycle_001_shipped.md`

Substrate ABI complete at the contract layer · runtime layer queued for THIS cycle.

## Decisions made (PREPLAN structural decisions)

1. **Loader location**: NEW `src/substrate/` directory in loa-finn (separates substrate concerns from agent-as-skill-pack and hounfour-as-model-invocation)
2. **Effect runtime**: `ManagedRuntime.make(layer)` per construct (memoized · disposed on unload)
3. **Construct registry**: filesystem scan at startup + lazy dynamic-import on first invocation
4. **EventWriter abstraction**: Effect Tag · current impl wraps existing EventStore · Phase 3 adds KafkaWriter Layer with same Tag
5. **ModelRunner Layer**: Effect Tag · wraps `src/hounfour/cheval-invoker.ts` · the KEY INTEGRATION POINT (Effect → CompletionRequest)
6. **Sandbox lane**: substrate-constructs ride existing 2-worker interactive lane via `ToolSandbox.execute()`
7. **Trust tier**: only `trust:internal` ships in cycle-2 (worker_threads + capability-bounded Layer · the Tag set IS the capability set)
8. **JWT validation**: load-time RS256 + cached refresh per invocation (TTL = min(license.exp, 1h))
9. **Construct → Kafka topic binding**: declared via construct.yaml `streams.reads/writes` · loader subscribes/publishes via EventWriter Tag (Kafka adapter Phase 3)
10. **Dispatcher entry**: CLI command `loa-finn substrate-construct invoke <slug>` + programmatic `Substrate.invoke(slug, input)` API

## Invariants (must NOT change in cycle-2)

1. Effect-program construct contract `(input) => Effect<O, E, R>` (cycle-1 sealed)
2. construct.yaml manifest schema (just merged in construct-base#12 + loa-constructs#223)
3. Hounfour CompletionRequest/Result wire format (TypeBox)
4. Sandbox + worker-pool isolation primitives
5. EventStore append-only contract (Kafka is adapter · EventStore stays)
6. JWT licensing flow (RS256 · grace periods per `.claude/protocols/constructs-integration.md`)
7. Substrate-step protocol contract version 1.0.0 (`SubstrateStepSubmission/Verdict`)
8. Capability-bounded Layer principle (the Tag set IS the capability set)

## Personas

- **OSTROM** lead (`the-arcade/identity/OSTROM.md`) — substrate runtime is structural
- **ALEXANDER** craft lens (`artisan/identity/ALEXANDER.md`) — only for the CLI output surface (§9 design rules)
- **BARTH** ship discipline (`the-arcade/identity/BARTH.md`) — V1 cuts named in §10 of the build doc

## Operator pair-points (in build doc §13.4)

1. Pre-Sprint-1: confirm `src/substrate/` directory location
2. Mid-Sprint-3: review ModelRunner Tag identity bridge (cross-pack Tag matching is load-bearing)
3. Pre-Sprint-7: confirm e2e test fixture (real construct-lore-essay-grader vs simplified test pack)
4. Post-Sprint-7: review doctrine §13 draft

## What was deferred to V1.5 (per build doc §11)

- Kafka adapter (Sprint 8 / Phase 3) — `@confluentinc/kafka-javascript` wrapped as `KafkaWriter` Tag
- AnthropicModelRunner Layer — real LLM smoke
- cubquests-interface OffchainStepConfig.verificationType `"construct"` integration
- `trust:vendor` isolation tier (subprocess + Node `--permission` flags)
- `trust:untrusted` (isolated-vm or microVM)

## Adjacent open threads (operator decides cadence)

- loa-constructs Vercel deploys fail on every PR (pre-existing infra issue · separate config sweep)
- loa-constructs 44 dependabot vulns (1 critical · 20 high · 21 mod · 2 low)
- construct-base-update has operator's prior `feat/template-composability-update` branch (distinct scope · ready when operator resumes)
- BFZ on loa-finn last regen 2026-02-22 (~70 days old · accurate enough · regen optional)
