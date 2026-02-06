# Refactoring PRD: Adopt Upstream Loa Persistence Framework

> **Version**: 1.0.0
> **Date**: 2026-02-06
> **Author**: @janitooor
> **Status**: Draft
> **Parent PRD**: `grimoires/loa/prd.md` (loa-finn MVP)
> **Trigger**: PR #7 — Loa framework update introducing `.claude/lib/persistence/`
> **Grounding**: Codebase diff analysis of `src/persistence/` vs `.claude/lib/persistence/`

---

## 1. Problem Statement

### The Problem

PR #7 merges three upstream Loa commits that introduce a **4,794-line portable persistence framework** in `.claude/lib/persistence/`. Finn's existing `src/persistence/` contains **921 lines** of custom WAL, recovery, sync, and pruning code that overlaps significantly with the upstream library.

Maintaining both implementations creates three problems:

1. **Divergent WAL formats**: Finn uses ULID-based entry IDs with `type/operation/path/data/checksum` fields. Upstream uses time-sortable `${timestamp}-${seq}-${hex4}` IDs with `operation/path/data/checksum/entryChecksum` fields. Two WAL formats in one codebase means two replay codepaths, two compaction strategies, and two sets of bugs.

2. **Duplicated safety primitives**: Both codebases implement disk pressure monitoring, checksum verification, segment rotation, and circuit breakers — each with slightly different thresholds, algorithms, and edge-case handling. Finn's circuit breaker uses `setTimeout` timers; upstream uses lazy timer-free state transitions. Finn's disk pressure uses `statfsSync()`; upstream uses total WAL size. Neither is wrong, but maintaining both is unnecessary complexity.

3. **Missing capabilities in Finn**: The upstream lib provides Identity Loader (BEAUVOIR.md hot-reload with change detection), Learning Store (quality-gated compound learnings), Beads WAL Adapter (shell-safe state transition recording), and Checkpoint Protocol (two-phase intent-based checkpointing) — all capabilities Finn needs for its MVP but hasn't built yet. Building them from scratch when tested upstream implementations exist violates the k3s philosophy stated in the original PRD.

### Why Now

- The upstream persistence lib was designed for exactly this use case — agent runtimes that need portable, framework-grade persistence
- Finn's persistence code is not yet in production; refactoring now is zero-risk
- The original PRD targets <2,000 custom lines; adopting upstream removes ~600 lines from that count
- Every day the two implementations diverge makes future alignment harder

### Strategy

**Defer to upstream. Keep Finn as a thin adapter layer.**

Finn's R2 sync and git sync are the only persistence modules without upstream equivalents. These become `ICheckpointStorage` and `IRecoverySource` implementations — thin adapters over the upstream interfaces.

> **Source**: PR #7 diff analysis, original PRD §1.3 ("k3s philosophy"), D-004 decision log

---

## 2. Goals & Success Metrics

### Goals

| ID | Goal | Priority |
|----|------|----------|
| RG-1 | Replace Finn's WAL with upstream `WALManager` | P0 |
| RG-2 | Replace Finn's circuit breaker with upstream `CircuitBreaker` | P0 |
| RG-3 | Replace Finn's recovery cascade with upstream `RecoveryEngine` | P0 |
| RG-4 | Implement R2 sync as `ICheckpointStorage` adapter | P0 |
| RG-5 | Implement git sync as `IRecoverySource` adapter | P0 |
| RG-6 | Adopt `IdentityLoader` for BEAUVOIR.md hot-reload (FR-6.1) | P0 |
| RG-7 | Adopt `LearningStore` for compound learning cycle (FR-6.5) | P1 |
| RG-8 | Adopt `BeadsWALAdapter` for bead state transitions (FR-4.3) | P1 |
| RG-9 | All existing tests pass with upstream primitives | P0 |
| RG-10 | WAL pruner uses upstream compaction + Finn's two-source confirmation | P1 |

### Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Custom persistence lines | 921 | <350 | Lines in `src/persistence/` (adapters only) |
| Total custom code | 2,923 | <2,400 | Total non-dependency TypeScript |
| WAL implementations | 2 (Finn + upstream) | 1 (upstream) | Count of WAL entry formats |
| Circuit breaker implementations | 2 | 1 (upstream) | Count of state machines |
| Test coverage | 27 passing | 27+ passing | All existing tests pass, new adapter tests added |
| Identity hot-reload | Manual | Automatic | BEAUVOIR.md changes detected via FileWatcher |
| Compound learning | Not implemented | Quality-gated | LearningStore with 4-gate filter active |

### Non-Goals

- Migrating existing WAL data (Finn is pre-production; clean start is acceptable)
- Modifying the upstream persistence lib (it's in `.claude/` System Zone)
- Adding multi-tenant support (deferred to v1.1 per original PRD)
- Changing the R2 or git sync strategies (only wrapping them in upstream interfaces)

---

## 3. Impact Analysis

### Module-by-Module Overlap

| Finn Module | Lines | Upstream Equivalent | Lines | Action |
|-------------|-------|---------------------|-------|--------|
| `src/persistence/wal.ts` | 225 | `.claude/lib/persistence/wal/wal-manager.ts` | 631 | **Replace** — upstream has compaction, locking, rotation recovery |
| `src/persistence/recovery.ts` | 198 | `.claude/lib/persistence/recovery/recovery-engine.ts` | 140 | **Replace** — upstream has loop detection, pluggable sources |
| `src/persistence/r2-sync.ts` | 209 | `.claude/lib/persistence/checkpoint/` | 270 | **Adapt** — wrap R2 client as `ICheckpointStorage` |
| `src/persistence/git-sync.ts` | 234 | `.claude/lib/persistence/recovery/sources/git-source.ts` | 38 | **Adapt** — wrap git worktree logic as `IRecoverySource` |
| `src/persistence/pruner.ts` | 55 | `.claude/lib/persistence/wal/wal-compaction.ts` | 38 | **Replace** — upstream compaction + Finn's two-source guard |
| `src/scheduler/circuit-breaker.ts` | 138 | `.claude/lib/persistence/circuit-breaker.ts` | 167 | **Replace** — upstream has lazy timers (no leaks), injectable clock |
| `src/agent/session.ts` (identity) | ~20 | `.claude/lib/persistence/identity/identity-loader.ts` | 285 | **Adopt** — IdentityLoader + FileWatcher for hot-reload |
| — (not implemented) | 0 | `.claude/lib/persistence/learning/` | 570 | **Adopt** — LearningStore for FR-6.5 |
| — (not implemented) | 0 | `.claude/lib/persistence/beads/` | 540 | **Adopt** — BeadsWALAdapter for FR-4.3 |

### Key Design Differences

| Aspect | Finn's Implementation | Upstream Implementation | Resolution |
|--------|----------------------|------------------------|------------|
| **WAL Entry ID** | ULID via `monotonicFactory()` | `${timestamp}-${seq}-${hex4}` | Adopt upstream format. Both are monotonic + sortable. |
| **WAL Entry Fields** | `type` field (session/bead/memory/config) | No `type` field; uses `path` prefix | Encode type in path convention (e.g., `sessions/`, `beads/`) |
| **Disk Pressure** | `statfsSync()` on filesystem | Total WAL size in bytes | Adopt upstream (portable, no OS dependency) |
| **Circuit Breaker Timers** | `setTimeout` with `.unref()` | Lazy (no timers, check on `getState()`) | Adopt upstream (no timer leaks, testable) |
| **Recovery Sources** | Hardcoded R2 → Git → Template cascade | Pluggable `IRecoverySource[]` array | Wrap R2 and Git as `IRecoverySource` implementations |
| **Recovery Modes** | `strict/degraded/clean` via enum | State machine: `IDLE/RECOVERING/RUNNING/DEGRADED/LOOP_DETECTED` | Map upstream states to Finn's health reporting |
| **Segment Locking** | `flock` only | `flock` (preferred) + PID-file fallback | Adopt upstream (more portable for CF Workers) |
| **Checksum** | SHA-256 of `JSON.stringify(data)` | SHA-256 truncated to 16 hex (entry) + full SHA-256 (data) | Adopt upstream (entry-level + data-level integrity) |
| **Compaction** | Via `WALPruner` (external) | Built into `WALManager.compact()` | Adopt upstream (integrated, automatic on pressure) |

### Breaking Changes

| Change | Impact | Migration |
|--------|--------|-----------|
| WAL entry format change | Existing WAL segments unreadable | Pre-production: no migration needed. Clean start. |
| Circuit breaker API change | Scheduler task registration | Update `ScheduledTaskDef` to use upstream `CircuitBreaker` API |
| Recovery result shape change | Health aggregator reads `RecoveryResult` | Update `health.ts` to map upstream `RecoveryState` |
| Entry ID format change | Any code comparing/sorting by ULID | Update to use `generateEntryId()` from upstream |

---

## 4. Functional Requirements

### FR-R1: WAL Migration (P0)

Replace `src/persistence/wal.ts` with upstream `WALManager`.

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-R1.1 | Initialize `WALManager` from upstream lib with Finn's data directory | WAL segments created in `${dataDir}/wal/` |
| FR-R1.2 | All WAL callers use upstream `append(operation, path, data?)` API | No references to old `WAL` class remain |
| FR-R1.3 | Segment rotation at 10MB (matching original spec) | Configurable via `WALManagerConfig.maxSegmentSize` |
| FR-R1.4 | Disk pressure uses upstream thresholds (100MB warning, 150MB critical) | Health status reflects pressure state |
| FR-R1.5 | Compaction triggers automatically on disk pressure | `compact()` called when pressure = "warning" |
| FR-R1.6 | Replay supports `sinceSeq` for incremental sync | R2 sync uses `getEntriesSince()` for delta |

### FR-R2: Circuit Breaker Migration (P0)

Replace `src/scheduler/circuit-breaker.ts` with upstream `CircuitBreaker`.

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-R2.1 | Scheduler tasks wrapped in upstream `CircuitBreaker.execute()` | 3 failures → OPEN → 5min → HALF_OPEN |
| FR-R2.2 | No `setTimeout` timers for circuit breaker state | Lazy transitions on `getState()` |
| FR-R2.3 | State changes exposed via `onStateChange` callback | Health aggregator receives transition events |
| FR-R2.4 | Circuit breaker stats available for `/health` endpoint | `getStats()` returns state, failure count, last failure time |

### FR-R3: Recovery Engine Migration (P0)

Replace `src/persistence/recovery.ts` with upstream `RecoveryEngine`.

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-R3.1 | Recovery uses pluggable `IRecoverySource[]` cascade | Sources registered in priority order |
| FR-R3.2 | Loop detection prevents infinite recovery attempts | 3 failures in 10min window → LOOP_DETECTED |
| FR-R3.3 | Recovery state mapped to Finn's health reporting | RECOVERING → health.degraded, RUNNING → health.healthy, LOOP_DETECTED → health.unhealthy |
| FR-R3.4 | State change events emitted for observability | `onEvent` callback receives `trying_source`, `restored`, `source_failed` |

### FR-R4: R2 Adapter (P0)

Wrap `src/persistence/r2-sync.ts` as `ICheckpointStorage` implementation.

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-R4.1 | `R2CheckpointStorage` implements `ICheckpointStorage` interface | `readFile`, `writeFile`, `deleteFile`, `listFiles`, `verifyChecksum`, `stat` |
| FR-R4.2 | Existing R2 client (`@aws-sdk/client-s3`) used internally | No new dependencies |
| FR-R4.3 | Two-phase checkpoint uses upstream `CheckpointProtocol` | Intent markers, verification, manifest atomicity |
| FR-R4.4 | Graceful fallback when R2 credentials missing | `isAvailable()` returns false, recovery skips R2 |

### FR-R5: Git Adapter (P0)

Wrap `src/persistence/git-sync.ts` as `IRecoverySource` implementation.

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-R5.1 | `GitRecoverySource` implements `IRecoverySource` interface | `name`, `isAvailable()`, `restore()` |
| FR-R5.2 | Existing git worktree logic preserved inside adapter | Temporary worktrees, `git show` reads, no checkout |
| FR-R5.3 | Conflict detection preserved (diverged branches) | `isAvailable()` returns false on divergence |
| FR-R5.4 | Snapshot manifest read into `Map<string, Buffer>` | Compatible with upstream recovery engine's expectations |

### FR-R6: Identity Loader Adoption (P0)

Replace manual BEAUVOIR.md loading in `src/agent/session.ts` with upstream `IdentityLoader`.

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-R6.1 | `IdentityLoader` parses BEAUVOIR.md at boot | Principles, boundaries, interaction style extracted |
| FR-R6.2 | `FileWatcher` detects BEAUVOIR.md changes | Agent picks up identity updates without restart |
| FR-R6.3 | Identity changes logged to NOTES.md | Change detection with old/new checksum comparison |
| FR-R6.4 | Parsed identity feeds into Pi SDK `systemPrompt` | `createAgentSession()` receives structured identity |

### FR-R7: Learning Store Adoption (P1)

Add upstream `LearningStore` for compound learning cycle (original PRD FR-6.5).

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-R7.1 | `LearningStore` initialized with `${dataDir}/learnings/` | CRUD operations for compound learnings |
| FR-R7.2 | Quality gates filter low-value learnings | 4-gate scoring: depth, reusability, trigger clarity, verification |
| FR-R7.3 | Active learnings loaded into session context | Last 20 learnings appended to system prompt |
| FR-R7.4 | Learning effectiveness tracked | `recordApplication()` increments success/failure counts |
| FR-R7.5 | Learnings persisted through WAL | `type: "memory"` entries in WAL for crash recovery |

### FR-R8: Beads WAL Adapter Adoption (P1)

Add upstream `BeadsWALAdapter` for bead state transitions (original PRD FR-4.3).

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-R8.1 | Bead state transitions recorded in WAL | Create, update, close, label, dep operations logged |
| FR-R8.2 | Shell escape validation on all bead inputs | No injection via bead IDs, labels, or descriptions |
| FR-R8.3 | Beads recovery replays WAL through `br` CLI | Crash → restart → bead state restored |
| FR-R8.4 | Operation whitelist enforced | Only create/update/close/reopen/label/comment/dep allowed |

### FR-R9: Pruner Refactor (P1)

Combine upstream compaction with Finn's two-source confirmation guard.

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-R9.1 | Compaction uses upstream `compactEntries()` (delta reduction) | Keep-latest-per-path within segments |
| FR-R9.2 | Segment deletion requires BOTH R2 checkpoint AND git snapshot | No data loss if one sync tier fails |
| FR-R9.3 | Active segment never compacted or deleted | Only closed segments eligible |
| FR-R9.4 | Two-phase mark (`.prunable`) → delete preserved | Retry-safe on partial failure |

---

## 5. Technical Design (High-Level)

### Architecture After Refactoring

```
src/persistence/
├── index.ts                    # Re-exports upstream + adapters
├── r2-storage.ts               # ICheckpointStorage → R2 (adapter, ~120 lines)
├── git-source.ts               # IRecoverySource → Git worktree (adapter, ~80 lines)
├── pruner.ts                   # Compaction + two-source guard (refined, ~40 lines)
└── config.ts                   # FinnPersistenceConfig (wiring, ~30 lines)

src/scheduler/
├── scheduler.ts                # Uses upstream CircuitBreaker (updated)
├── health.ts                   # Maps upstream states to health (updated)
└── (circuit-breaker.ts)        # DELETED — replaced by upstream

src/agent/
├── session.ts                  # Uses upstream IdentityLoader (updated)
└── learnings.ts                # Wires upstream LearningStore (new, ~40 lines)
```

### Deleted Files

| File | Lines | Reason |
|------|-------|--------|
| `src/persistence/wal.ts` | 225 | Replaced by upstream `WALManager` |
| `src/persistence/recovery.ts` | 198 | Replaced by upstream `RecoveryEngine` |
| `src/scheduler/circuit-breaker.ts` | 138 | Replaced by upstream `CircuitBreaker` |
| **Total deleted** | **561** | |

### New/Modified Files

| File | Est. Lines | Type |
|------|-----------|------|
| `src/persistence/r2-storage.ts` | ~120 | New (adapter) |
| `src/persistence/git-source.ts` | ~80 | New (adapter) |
| `src/persistence/config.ts` | ~30 | New (wiring) |
| `src/agent/learnings.ts` | ~40 | New (LearningStore wiring) |
| `src/persistence/pruner.ts` | ~40 | Modified (use upstream compaction) |
| `src/scheduler/scheduler.ts` | ~131 | Modified (upstream CircuitBreaker) |
| `src/scheduler/health.ts` | ~118 | Modified (upstream state mapping) |
| `src/agent/session.ts` | ~63 | Modified (IdentityLoader) |
| `src/persistence/r2-sync.ts` | — | Deleted (logic moves to r2-storage.ts) |
| `src/persistence/git-sync.ts` | — | Deleted (logic moves to git-source.ts) |

### Import Pattern

```typescript
// Finn imports from upstream persistence lib
import {
  WALManager, createWALManager,
  CircuitBreaker,
  RecoveryEngine, TemplateRecoverySource,
  CheckpointProtocol, MountCheckpointStorage,
  IdentityLoader, createIdentityLoader,
  LearningStore,
  BeadsWALAdapter, BeadsRecoveryHandler,
} from '../../.claude/lib/persistence/index.js';
```

> **Note**: The upstream lib is in `.claude/` (System Zone). Finn imports but never modifies it.

---

## 6. Scope & Prioritization

### Sprint Plan

This refactoring maps to a single sprint (Sprint 7, Global ID 7 in ledger).

| Task | Priority | Effort | Depends On |
|------|----------|--------|------------|
| T-7.1: Replace WAL with upstream WALManager | P0 | Medium (3h) | — |
| T-7.2: Replace circuit breaker with upstream | P0 | Small (1h) | — |
| T-7.3: Replace recovery with upstream RecoveryEngine | P0 | Medium (3h) | T-7.1 |
| T-7.4: Implement R2CheckpointStorage adapter | P0 | Medium (3h) | T-7.1 |
| T-7.5: Implement GitRecoverySource adapter | P0 | Medium (2h) | T-7.3 |
| T-7.6: Adopt IdentityLoader for BEAUVOIR.md | P0 | Small (1h) | — |
| T-7.7: Adopt LearningStore for compound learning | P1 | Medium (2h) | T-7.1 |
| T-7.8: Adopt BeadsWALAdapter | P1 | Medium (2h) | T-7.1 |
| T-7.9: Refactor pruner with upstream compaction | P1 | Small (1h) | T-7.1, T-7.4 |
| T-7.10: Update health aggregator for upstream states | P0 | Small (1h) | T-7.2, T-7.3 |
| T-7.11: Update all tests for new APIs | P0 | Medium (3h) | All above |
| T-7.12: Integration test: kill → restart → resume | P0 | Small (1h) | T-7.11 |

**Total estimated effort**: ~23 hours

### Exit Criteria

1. Zero references to deleted files (`wal.ts`, `recovery.ts`, `circuit-breaker.ts`)
2. All 27 existing tests pass with upstream primitives
3. New adapter tests for R2CheckpointStorage and GitRecoverySource
4. IdentityLoader hot-reload functional (change BEAUVOIR.md → agent picks up)
5. LearningStore quality gates active (low-quality learnings filtered)
6. Kill → restart → resume conversation integration test passes

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Upstream WAL format incompatible with R2 sync | Medium | High | R2 adapter translates between formats; checkpoint protocol handles serialization |
| `fs-ext` flock not available on CF Workers | Medium | Medium | Upstream already has PID-file fallback; validates our CF Workers spike concern |
| Upstream lib API changes in future updates | Low | Medium | Pin to current version; adapter layer isolates Finn from upstream changes |
| Test suite needs significant rewriting | Medium | Medium | Tests verify behavior, not implementation; most should adapt with import changes |
| IdentityLoader parsing doesn't match Finn's BEAUVOIR.md format | Low | Low | BEAUVOIR.md follows Loa standard format; IdentityLoader was designed for it |
| Import path from `src/` to `.claude/lib/` creates circular dependency | Low | High | One-way dependency only: Finn imports upstream, never vice versa |

---

## 8. Decision Log

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| RD-001 | Adopt upstream persistence, not maintain parallel | k3s philosophy: minimize custom code, leverage framework | 2026-02-06 |
| RD-002 | Thin adapter pattern for R2/git | Only Finn-specific sync logic stays custom | 2026-02-06 |
| RD-003 | Clean WAL start (no migration) | Pre-production; no user data to preserve | 2026-02-06 |
| RD-004 | Adopt IdentityLoader + LearningStore | Implements FR-6.1 and FR-6.5 from original PRD without new custom code | 2026-02-06 |
| RD-005 | Single refactoring sprint (Sprint 7) | All changes are interdependent; splitting across sprints adds integration risk | 2026-02-06 |
