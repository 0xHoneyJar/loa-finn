---
generated_date: "2026-02-16"
source_repo: 0xHoneyJar/loa-finn
provenance: cycle-025-sprint-61-task-2.5
curator: bridgebuilder
max_age_days: 90
tags: ["architectural", "philosophical"]
---

# Development History: 25 Cycles of loa-finn

The loa-finn runtime was built across 25 development cycles, 61 sprints, and hundreds of tasks over 12 days in February 2026. This document narrates the arc of that development — from the first agent core through production deployment and, finally, the Oracle knowledge interface itself.

Each cycle followed the Loa framework workflow: PRD, SDD, sprint plan, implementation, review, audit. Many cycles were shaped by Bridgebuilder autonomous code review, which introduced iterative feedback loops starting from cycle-004. The GPT-5.2 Flatline Protocol provided adversarial review for design documents starting from cycle-020.

---

## Phase 0: Foundation (Cycles 1-5)

**Duration**: 2026-02-06 to 2026-02-08
**Sprints**: 1-13 (13 sprints)
**Theme**: Build the minimal viable agent runtime

### Cycle 1 — loa-finn MVP: Minimal Persistent Loa Agent

The first cycle established the core architecture across 6 sprints: Agent Core (sprint-1), Gateway and Auth (sprint-2), Persistence (sprint-3), Scheduler and Compound (sprint-4), Deployment (sprint-5), and Loa Integration (sprint-6). This produced a functional Hono-based HTTP server with WAL-based persistence, JWT authentication, session management, and a basic agent invocation pipeline.

The gateway pattern (`src/gateway/server.ts`) and configuration model (`src/config.ts`) established in this cycle remained stable through all subsequent cycles.

### Cycle 2 — Upstream Loa Persistence Framework

A single-sprint refactoring cycle (sprint-7, 12 tasks) that adopted the upstream Loa persistence framework. This replaced the initial custom persistence layer with a standardized approach, establishing the pattern of aligning with the parent Loa framework that would recur throughout the project.

### Cycle 3 — Persistence Hardening and Tool Sandbox

Two sprints (8-9) addressed upstream persistence hardening and tool execution sandboxing. Sprint-9 introduced the tool execution sandbox with timeout enforcement (30s default) — a constraint that persists in the production system today (`src/config.ts`).

### Cycle 4 — Bridgebuilder: Autonomous PR Review Agent

A milestone cycle. Sprint-10 (Hexagonal Foundation) and sprint-11 (Wiring, Integration, Deployment) produced the Bridgebuilder — the first autonomous PR review agent in the ecosystem. The Bridgebuilder uses hexagonal architecture with port/adapter patterns, enabling it to be swapped between different review contexts.

This was the first cycle where code reviewed itself, establishing the feedback loop that would shape all subsequent development. The Bridgebuilder persona (`grimoires/bridgebuilder/`) would evolve into a central figure in the ecosystem's quality culture.

### Cycle 5 — Worker Thread Sandbox: Non-Blocking Tool Execution

Sprints 12-13 moved tool execution to worker threads for non-blocking operation. The Worker Pool Foundation (sprint-12) and System Integration (sprint-13) completed the sandbox architecture. This was the last "infrastructure foundation" cycle before multi-model work began.

---

## Phase 1: Multi-Model (Cycles 6-8)

**Duration**: 2026-02-08 to 2026-02-09
**Sprints**: 14-20 (7 sprints, plus the Arrakis mega-sprint of 44 tasks)
**Theme**: Multi-model provider abstraction and distributed inference

### Cycle 6 — Hounfour Phases 0-2: Multi-Model Provider Abstraction

Three sprints (14-16) laid the Hounfour foundation. Phase 0 (sprint-14) established `cheval.py`, configuration, and the cost ledger. Phase 1 (sprint-15) integrated the Flatline Protocol and budget enforcement. Phase 2 (sprint-16) added agent portability and health checks.

The name "Hounfour" (from Haitian Vodou — the temple where spirits are served) reflects the system's role as the space where multiple AI models are orchestrated. The "cheval" subprocess model (from the Vodou concept of a person "ridden" by a spirit) describes how agents mount different model providers.

### Cycle 7 — Hounfour Phase 3: Server Integration and Self-Hosted Inference

Three sprints (17-19) tackled the server-side integration: Sidecar and Tool-Call Orchestrator (sprint-17), Streaming and Redis State (sprint-18), GPU Deployment and Ledger Export (sprint-19). This phase enabled self-hosted model inference alongside API-based providers.

### Cycle 8 — Hounfour Phase 4: Arrakis Distribution (Spice Gate)

A massive cycle executed in the arrakis repository — 44 tasks consolidated into a single ledger entry (sprint-20). The "Spice Gate" (a Dune reference — the Arrakis distribution layer controls access to the "spice" of AI inference) implemented the agent gateway for the distribution infrastructure. PR arrakis#40.

---

## Phase 2: Integration (Cycles 9-18)

**Duration**: 2026-02-09 to 2026-02-13
**Sprints**: 22-49 (28 sprints, many superseded and re-planned)
**Theme**: Integration debt, ground truth, documentation, extraction

### Cycle 9 — Hounfour Phase 5 (Original, Superseded)

The original Phase 5 plan (sprints 22-24) for integration debt, NativeRuntimeAdapter, and finnNFT routing was never implemented. The work was superseded by cycle-018, which re-planned and executed all Phase 5 work with a cleaner architecture after the ground truth and documentation cycles provided deeper understanding.

### Cycles 10-11 — Ground Truth

Two cycles (sprints 25-28) built the Ground Truth verification infrastructure — a factual documentation pipeline that extracts claims from the codebase and validates them. Cycle-010 built the verification infrastructure and capability brief. Cycle-011, driven by Bridgebuilder PR review feedback from PR loa-finn#51, hardened the structural verification and added property testing.

### Cycle 12 — Bridgebuilder Review Hardening

Planned as 3 sprints (29-31) to address findings from Bridgebuilder's PR loa-finn#52 review. The sprints were superseded — work was implemented directly in PR loa-finn#54. This marked the beginning of a pattern where Bridgebuilder review findings drove entire cycles of improvement.

### Cycle 13 — Documentation Rewrite (Superseded)

Planned as 3 sprints (32-34) for a complete documentation rewrite. Never directly executed — instead, the work was absorbed into cycles 14-17 through iterative Bridgebuilder feedback loops, each cycle addressing findings from the previous review.

### Cycles 14-17 — The Bridgebuilder Feedback Spiral

Four cycles driven entirely by Bridgebuilder review findings:

- **Cycle 14** (sprints 35-36): PR loa-finn#55 findings — schema evolution, content quality
- **Cycle 15** (sprints 37-38): PR loa-finn#56 findings — DERIVED provenance class, citation auto-repair
- **Cycle 16** (sprints 39-40, superseded): PR loa-finn#57 findings — epistemic infrastructure (absorbed into cycle-017)
- **Cycle 17** (sprints 41-42): PR loa-finn#58 findings — parser hardening, provenance intelligence, routing preparation. GPT-5.2 APPROVED.

This sequence — where each Bridgebuilder review triggered a new improvement cycle — demonstrated the power of autonomous code review as a development driver. The Bridgebuilder was not just reviewing code; it was shaping the architecture.

### Cycle 18 — Hounfour Phase 5: Protocol Extraction and Integration

The definitive Phase 5 cycle. Seven sprints (43-49) across five threads:

1. **Protocol Package Extraction** (sprint-43): Created the `loa-hounfour` standalone package
2. **Integration Hardening** (sprint-44): Budget, JWT, reconciliation, E2E tests
3. **NativeRuntime and Ensemble** (sprint-45): NativeRuntime adapter, ensemble orchestrator, routing matrix — 121 tests
4. **NFT Routing and BYOK** (sprint-46): finnNFT routing, BYOK proxy — 144 tests
5. **loa-hounfour Extraction** (sprint-47): Published to 0xHoneyJar/loa-hounfour
6. **Bridgebuilder Protocol Hardening** (sprint-48): 7 Bridgebuilder findings, loa-hounfour v1.1.0
7. **Consumer Updates** (sprint-49): Pinned v1.1.0, fixed budget-migration test

The extraction of `packages/loa-hounfour/` into the standalone `0xHoneyJar/loa-hounfour` repository was a key architectural milestone — the protocol types that define how all adapters communicate became an independent, publishable package with 91+ tests.

---

## Phase 3: Production (Cycles 19-24)

**Duration**: 2026-02-13 to 2026-02-17
**Sprints**: 50-59 (10 sprints)
**Theme**: Production hardening, billing settlement, deployment

### Cycle 19 — Loa Update and Bridgebuilder Migration

Sprint-50 updated the Loa framework from v1.33.1 to v1.35.0 and migrated the Bridgebuilder to V3. Three iterations of Bridgebuilder review on PR loa-finn#63 resolved 35 findings to 0 unresolved HIGH/MEDIUM. 256 tests passing.

### Cycle 20 — Pool Claim Enforcement: Confused Deputy Prevention

Sprints 51-52 implemented pool claim enforcement — preventing confused deputy attacks where one tenant's request could be routed through another tenant's model pool. Grounded in RFC loa-finn#31 Phase 4. PR loa-finn#65 merged. Bridge flatlined: 54 findings reduced to 0 in 2 iterations. This cycle introduced the pattern of citing Stripe's idempotency keys as an industry parallel.

### Cycle 21 — S2S Billing Finalize Client

Sprints 53-54 implemented the server-to-server billing finalize client with loa-hounfour v5.0.0 upgrade. Key architectural decisions: float-to-BigInt conversion for micro-USD billing (a Bridgebuilder HIGH finding), DLQ isolation for failed billing calls, reservation_id JWT propagation. Bridge converged from 0.92 to 0.98 (FLATLINE). PR loa-finn#68.

### Cycle 22 — E2E Smoke Test: Billing Wire Verification

Sprint-55 proved the billing wire works against real containers. Fixed 5 integration mismatches discovered during E2E testing: JWT algorithm (RS256 vs ES256), field naming conventions, identity field propagation, URL path construction, Docker configuration. 52 tests. PR loa-finn#71 merged.

### Cycle 23 — Shadow Deploy Readiness

Sprints 56-57 prepared for shadow deployment. DLQ persistence (implementing Ostrom Principle 7 — graduated sanctions), billing invariant formalization, shadow deploy configuration. Synthesized from Bridgebuilder Deep Review findings. PR loa-finn#72 merged. Bridge flatlined: 4 findings to 0 in 2 iterations. 62 tests.

### Cycle 24 — Production Deploy and Thinnest Product Surface

Sprints 58-59 deployed to production. Sprint-58 built endpoints, infrastructure, and tests (35 tests, GPT-5.2 APPROVED). Sprint-59 added CI/CD workflow, production smoke tests, ES256-only JWT enforcement, and Dockerfile health checks. 152 tests passing. The "thinnest product surface" principle — deploy only what is needed, nothing more — governed the production scope.

---

## Phase 4: Knowledge (Cycle 25)

**Duration**: 2026-02-16 onwards
**Sprints**: 60-61
**Theme**: The Oracle — making the ecosystem understand itself

### Cycle 25 — The Oracle: Unified Knowledge Interface

The current cycle. Sprint-60 (Knowledge Engine Foundation) built the TypeScript knowledge enrichment engine: types, loader (5 security gates), registry (schema validation), enricher (budget/trust boundary). 72 tests.

Sprint-61 (Knowledge Corpus and E2E Verification) creates the knowledge source files you are reading now, plus integration, gold-set evaluation, and red-team adversarial test suites.

The Oracle represents a convergence: it uses every system built across 24 prior cycles (Hounfour routing, billing, JWT auth, health checks) to deliver knowledge about those very systems. It is the ecosystem teaching itself to newcomers.

---

## Key Milestones

| Milestone | Cycle | Sprint | Date |
|-----------|-------|--------|------|
| First agent invocation | 1 | 1 | 2026-02-06 |
| First persistence layer | 1 | 3 | 2026-02-06 |
| First Bridgebuilder review | 4 | 10-11 | 2026-02-07 |
| Multi-model foundation (Hounfour Phase 0) | 6 | 14 | 2026-02-08 |
| Arrakis distribution layer | 8 | 20 | 2026-02-09 |
| Ground Truth verification | 10 | 25 | 2026-02-10 |
| loa-hounfour extraction to standalone repo | 18 | 47 | 2026-02-12 |
| Pool claim enforcement | 20 | 51 | 2026-02-13 |
| Billing finalize with BigInt micro-USD | 21 | 53 | 2026-02-16 |
| Production deployment | 24 | 58-59 | 2026-02-16 |
| Oracle knowledge engine | 25 | 60 | 2026-02-16 |

---

## Patterns That Emerged

**Bridgebuilder-Driven Development**: Starting from cycle-012, entire development cycles were triggered by Bridgebuilder review findings. The autonomous reviewer became a de facto architect, identifying structural improvements that human developers had not considered.

**Supersession as Learning**: Multiple cycles (9, 12, 13, 16) were planned but superseded — their work absorbed into later, better-informed cycles. This was not waste. Each planning exercise deepened understanding even when the plan was never executed.

**The Flatline as Quality Gate**: From cycle-020 onward, the GPT-5.2 Flatline Protocol reviewed every PRD, SDD, and sprint plan. The pattern of "iteration N, M blocking issues resolved" shows the adversarial review consistently found real issues — typically 4-10 blocking findings per document.

**Convergence Metrics**: Bridge review loops consistently show convergence patterns — starting with many findings (30-50) and reducing to 0 in 2-3 iterations. The "flatline" metaphor (from the medical monitor showing a flat line when the heart stops) signals kaironic completion: the work is done when the review has nothing left to say.
