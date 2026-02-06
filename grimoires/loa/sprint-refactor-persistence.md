# Sprint Plan: Adopt Upstream Loa Persistence Framework

> **Version**: 1.1.0
> **Date**: 2026-02-06
> **Author**: @janitooor
> **PRD**: `grimoires/loa/prd-refactor-persistence.md` v1.0.0
> **SDD**: `grimoires/loa/sdd-refactor-persistence.md` v1.1.0
> **Cycle**: cycle-002

---

## Sprint 7: Persistence Refactoring (Global ID: 7)

**Goal**: Replace custom persistence code with upstream Loa persistence framework. Thin adapters for R2/Git. Adopt IdentityLoader, LearningStore, BeadsWALAdapter.

**Exit Criteria**: All 27 existing tests pass with upstream primitives. Kill → restart → resume conversation. IdentityLoader hot-reload working. LearningStore quality gates active.

**Estimated Effort**: ~26 hours across 12 tasks (increased from 23h after Flatline hardening)

---

### Task Breakdown

#### T-7.1: Replace WAL with upstream WALManager

**Priority**: P0
**Effort**: Medium (3h)
**Depends on**: —

**Description**:
Delete `src/persistence/wal.ts` (225 lines). Replace all WAL usage with upstream `WALManager` from `.claude/lib/persistence/`. Update all callers to use the new API: `append(operation, path, data?)` instead of `append(type, operation, path, data)`. Encode the old `type` field as a path prefix convention (`sessions/`, `.beads/`, `learnings/`, `config/`).

**Acceptance Criteria**:
- [ ] `src/persistence/wal.ts` deleted
- [ ] `createWALManager(walDir)` + `await wal.initialize()` in boot sequence
- [ ] `await wal.shutdown()` in graceful shutdown handler
- [ ] Canonical `walPath()` builder enforces valid prefixes and rejects path traversal (SDD DD-13)
- [ ] All callers use `walPath()` — no string concatenation for WAL paths
- [ ] Segment rotation at 10MB (configurable via `WALManagerConfig.maxSegmentSize`)
- [ ] Disk pressure monitoring via `wal.getDiskPressure()`
- [ ] `wal.getStatus()` returns `{ seq, activeSegment, segmentCount, totalSize, diskPressure }`
- [ ] Startup self-check validates upstream persistence symbols exist (SDD DD-1)
- [ ] No references to old `WAL` class or `WALEntry` type from `src/persistence/wal.ts`

---

#### T-7.2: Replace circuit breaker with upstream

**Priority**: P0
**Effort**: Small (1h)
**Depends on**: —

**Description**:
Delete `src/scheduler/circuit-breaker.ts` (138 lines). Update `scheduler.ts` to use upstream `CircuitBreaker` with lazy state transitions (no `setTimeout`). Wire `onStateChange` callback to log transitions to WAL.

**Acceptance Criteria**:
- [ ] `src/scheduler/circuit-breaker.ts` deleted
- [ ] Each scheduler task uses upstream `CircuitBreaker({ maxFailures: 3, resetTimeMs: 300_000 })`
- [ ] `onStateChange` callback logs to WAL: `wal.append("write", "config/circuit-breaker/${taskId}", ...)`
- [ ] No `setTimeout` used for circuit breaker state (lazy transitions)
- [ ] `cb.getState()` returns `"CLOSED" | "OPEN" | "HALF_OPEN"`
- [ ] Health aggregator reads `cb.getFailureCount()` for task status

---

#### T-7.3: Replace recovery with upstream RecoveryEngine

**Priority**: P0
**Effort**: Medium (3h)
**Depends on**: T-7.1

**Description**:
Delete `src/persistence/recovery.ts` (198 lines). Initialize upstream `RecoveryEngine` with pluggable `IRecoverySource[]` cascade. Wire `onStateChange` and `onEvent` callbacks for observability. Map upstream `RecoveryState` to Finn's health status.

**Acceptance Criteria**:
- [ ] `src/persistence/recovery.ts` deleted
- [ ] `RecoveryEngine({ sources: [mountSource, gitSource, templateSource] })` in boot
- [ ] Per-source timeout: 30s; overall boot deadline: 120s (SDD DD-12)
- [ ] Loop detection: 3 failures in 10min window → `LOOP_DETECTED`
- [ ] State mapping: `RUNNING` → healthy, `DEGRADED` → degraded, `LOOP_DETECTED` → unhealthy
- [ ] `onEvent` logs `trying_source`, `restored`, `source_failed` events
- [ ] Recovery result exposes `{ state, source, files }`
- [ ] Boot blocks until `recovery.run()` completes (bounded by deadline)
- [ ] If template fallback used → outbound sync disabled until operator confirms (SDD DD-11)

---

#### T-7.4: Implement R2CheckpointStorage adapter

**Priority**: P0
**Effort**: Medium (3h)
**Depends on**: T-7.1

**Description**:
Create `src/persistence/r2-storage.ts` implementing `ICheckpointStorage`. Wrap existing S3Client logic from `r2-sync.ts`. Delete `r2-sync.ts` (209 lines). Integrate with upstream `CheckpointProtocol` for two-phase intent-based checkpoints.

**Acceptance Criteria**:
- [ ] `R2CheckpointStorage` implements all `ICheckpointStorage` methods
- [ ] `isAvailable()` returns false when credentials missing
- [ ] `writeFile()` stores SHA-256 in S3 metadata (`x-amz-meta-sha256`)
- [ ] `verifyChecksum()` compares metadata SHA-256 with expected
- [ ] `stat()` returns `{ size, mtime }` from `HeadObjectCommand`
- [ ] Path traversal prevention (no `..` in relative paths)
- [ ] R2 endpoint validated against `*.r2.cloudflarestorage.com` or `*.r2.dev` pattern (SDD §9)
- [ ] R2 sync uploads sealed WAL segments, not individual entries (SDD DD-10)
- [ ] Single-flight guard prevents concurrent sync runs (SDD §6)
- [ ] Intent ID is deterministic (`checkpoint-${seq}`) for idempotent retries
- [ ] `CheckpointProtocol.beginCheckpoint()` + `finalizeCheckpoint()` with walSeq in metadata
- [ ] `src/persistence/r2-sync.ts` deleted
- [ ] Stale intent cleanup runs after each sync (TTL-based, >10min old)
- [ ] Confirmed R2 seq reported to pruner after successful finalize

---

#### T-7.5: Implement GitRecoverySource adapter

**Priority**: P0
**Effort**: Medium (2h)
**Depends on**: T-7.3

**Description**:
Create `src/persistence/git-source.ts` implementing `IRecoverySource`. Extract restore logic from `git-sync.ts`. Rename remaining `git-sync.ts` to `git-push.ts` (outbound only). Conflict detection via `isAvailable()`.

**Acceptance Criteria**:
- [ ] `FinnGitRecoverySource` implements `IRecoverySource` interface
- [ ] `isAvailable()` returns false on diverged branches (merge-base check)
- [ ] `restore()` returns `Map<string, Buffer>` or null (all-or-nothing)
- [ ] Uses `git show` for file reads (no checkout)
- [ ] `src/persistence/git-sync.ts` renamed to `git-push.ts`
- [ ] `GitPush` class retains `snapshot()` and `push()` methods only
- [ ] Git snapshot manifest includes `walSeq` for freshness comparison (SDD DD-11)
- [ ] Confirmed git seq reported to pruner after successful push
- [ ] No restore/recovery logic in `git-push.ts`

---

#### T-7.6: Adopt IdentityLoader for BEAUVOIR.md

**Priority**: P0
**Effort**: Small (1h)
**Depends on**: —

**Description**:
Replace manual identity loading in `src/agent/session.ts` with upstream `IdentityLoader`. Use `FileWatcher` for hot-reload. Remove `identity_reload` scheduled task (60s interval) — FileWatcher handles debounced detection natively.

**Acceptance Criteria**:
- [ ] `createIdentityLoader(dataDir)` at boot
- [ ] `await identityLoader.load()` parses BEAUVOIR.md
- [ ] `identityLoader.startWatching()` enables hot-reload
- [ ] `identityLoader.stopWatching()` called in graceful shutdown
- [ ] Identity changes logged to NOTES.md (via IdentityLoader's built-in change detection)
- [ ] `identity_reload` task removed from scheduler (4 tasks instead of 5)
- [ ] `identityLoader.getIdentity()` used in session creation
- [ ] Health aggregator reports `identity.checksum` and `identity.watching`

---

#### T-7.7: Adopt LearningStore for compound learning

**Priority**: P1
**Effort**: Medium (2h)
**Depends on**: T-7.1

**Description**:
Create `src/agent/learnings.ts` wiring upstream `LearningStore`. Initialize with quality gate scorer. Load active learnings into session context. Track effectiveness.

**Acceptance Criteria**:
- [ ] `createLearningStore(dataDir, wal)` factory function
- [ ] `DefaultQualityGateScorer` attached (4-gate filter: depth, reusability, trigger clarity, verification)
- [ ] `getContextLearnings(store)` returns formatted string for system prompt
- [ ] Last 20 active learnings loaded, sorted by recency
- [ ] Learnings with quality score < 18 total are filtered out
- [ ] `recordApplication(id, success)` tracks effectiveness
- [ ] Pending learnings (target: "loa") saved to `pending-self/` for human approval
- [ ] Health aggregator reports `learnings.total` and `learnings.active`

---

#### T-7.8: Adopt BeadsWALAdapter

**Priority**: P1
**Effort**: Medium (2h)
**Depends on**: T-7.1

**Description**:
Wire upstream `BeadsWALAdapter` and `BeadsRecoveryHandler` into the boot sequence. Record bead state transitions through the WAL. Replay through `br` CLI during recovery.

**Acceptance Criteria**:
- [ ] `BeadsWALAdapter(wal, { pathPrefix: '.beads/wal' })` initialized after WAL
- [ ] `BeadsRecoveryHandler(beadsAdapter)` runs during boot recovery
- [ ] Uses `execFile` with fixed argv, not shell invocation (SDD DD-8)
- [ ] If `br` binary missing or wrong version → degrade gracefully, don't block boot
- [ ] Shell escape validation on all bead inputs (alphanumeric + underscore/hyphen only)
- [ ] Operation whitelist enforced (create/update/close/reopen/label/comment/dep)
- [ ] Bead ID validation: max 128 chars, no path traversal
- [ ] `beadsAdapter.recordTransition()` used for session state changes
- [ ] Recovery replays WAL entries through `br` CLI commands
- [ ] Final `br sync --flush-only` after replay

---

#### T-7.9: Refactor pruner with upstream compaction

**Priority**: P1
**Effort**: Small (1h)
**Depends on**: T-7.1, T-7.4

**Description**:
Update `src/persistence/pruner.ts` to use upstream `wal.compact()` instead of custom pruning logic. Keep the two-source confirmation guard (R2 + git).

**Acceptance Criteria**:
- [ ] `wal.compact()` used for delta reduction (keep-latest-per-path)
- [ ] Pruner tracks `confirmedR2Seq` and `confirmedGitSeq` (set by sync tasks after success)
- [ ] Prune only entries below `min(confirmedR2Seq, confirmedGitSeq)` (SDD DD-9)
- [ ] Minimum retained segments floor (2 segments) as safety net
- [ ] Active segment never compacted or deleted
- [ ] `pruneConfirmed()` returns `{ segmentsPruned: number }`
- [ ] Pruner is ~55 lines (down from original, up from naive 40 due to safety logic)

---

#### T-7.10: Update health aggregator for upstream states

**Priority**: P0
**Effort**: Small (1h)
**Depends on**: T-7.2, T-7.3

**Description**:
Update `src/scheduler/health.ts` to use upstream types and states. Add new health checks for identity, learnings, and recovery.

**Acceptance Criteria**:
- [ ] `HealthDeps` interface updated with upstream types
- [ ] `wal.getDiskPressure()` replaces `wal.isDiskPressure`
- [ ] `recovery.getState()` exposed in health status
- [ ] `identity.checksum` and `identity.watching` reported
- [ ] `learnings.total` and `learnings.active` reported
- [ ] `unhealthy` triggered by `LOOP_DETECTED` or `diskPressure === "critical"`
- [ ] `degraded` triggered by `DEGRADED`, `warning` pressure, open circuits

---

#### T-7.11: Update all tests for new APIs

**Priority**: P0
**Effort**: Medium (3h)
**Depends on**: T-7.1 through T-7.10

**Description**:
Update all existing tests to use upstream APIs. Add new adapter contract tests. Ensure all 27 existing tests pass.

**Acceptance Criteria**:
- [ ] All existing tests updated with new imports
- [ ] `R2CheckpointStorage` contract tests (implements `ICheckpointStorage`)
- [ ] `FinnGitRecoverySource` contract tests (implements `IRecoverySource`)
- [ ] `getContextLearnings()` unit test
- [ ] Circuit breaker tests use upstream API (lazy transitions, injectable clock)
- [ ] WAL tests use `WALManager.append()` signature (no `type` param)
- [ ] `walPath()` rejects invalid prefixes, `..`, double separators (Flatline Sprint SKP-001)
- [ ] Recovery tests mock `IRecoverySource` interface
- [ ] Recovery timeout test: slow source → deadline triggers (Flatline Sprint SKP-003)
- [ ] Pruner test: only compacts below `min(r2Seq, gitSeq)` (Flatline SDD SKP-004)
- [ ] R2 endpoint validation test: rejects non-R2 URLs (Flatline SDD SKP-006)
- [ ] All 27+ tests pass (`pnpm test`)

---

#### T-7.12: Integration test — kill, restart, resume

**Priority**: P0
**Effort**: Small (1h)
**Depends on**: T-7.11

**Description**:
End-to-end integration test: send messages, kill process, restart, verify conversation resumes where left off. WAL entries replayed, identity loaded, learnings available.

**Acceptance Criteria**:
- [ ] Test starts Finn process
- [ ] Sends messages via WebSocket
- [ ] Kills process (SIGKILL)
- [ ] Restarts process
- [ ] Verifies recovery completes (health = healthy)
- [ ] Resumes session with conversation history intact
- [ ] WAL entries from before kill are replayed
- [ ] Identity and learnings loaded on restart

---

### Sprint Summary

| Task | Priority | Effort | Dependencies | Flatline Hardening |
|------|----------|--------|-------------|-------------------|
| T-7.1: WAL migration | P0 | Medium (3.5h) | — | DD-13 path builder, DD-1 upstream validation |
| T-7.2: Circuit breaker migration | P0 | Small (1h) | — | — |
| T-7.3: Recovery engine migration | P0 | Medium (3.5h) | T-7.1 | DD-12 boot timeouts, DD-11 template safety |
| T-7.4: R2CheckpointStorage | P0 | Medium (3.5h) | T-7.1 | DD-10 segment uploads, single-flight, endpoint validation |
| T-7.5: GitRecoverySource | P0 | Medium (2.5h) | T-7.3 | DD-11 walSeq in manifest |
| T-7.6: IdentityLoader | P0 | Small (1h) | — | — |
| T-7.7: LearningStore | P1 | Medium (2h) | T-7.1 | — |
| T-7.8: BeadsWALAdapter | P1 | Medium (2h) | T-7.1 | DD-8 execFile, graceful degradation |
| T-7.9: Pruner refactor | P1 | Small (1.5h) | T-7.1, T-7.4 | DD-9 confirmed seq tracking |
| T-7.10: Health aggregator | P0 | Small (1h) | T-7.2, T-7.3 | — |
| T-7.11: Update tests | P0 | Medium (3.5h) | All above | +4 Flatline-driven test cases |
| T-7.12: Integration test | P0 | Small (1h) | T-7.11 | — |

### Dependency Graph

```
T-7.1 (WAL) ──────┬──→ T-7.3 (Recovery) ──→ T-7.5 (GitSource)
                   │         │
T-7.2 (CB) ───────┤         ├──→ T-7.10 (Health)
                   │         │
T-7.6 (Identity) ─┤    T-7.4 (R2Storage) ──→ T-7.9 (Pruner)
                   │
                   ├──→ T-7.7 (Learning)
                   │
                   └──→ T-7.8 (Beads)

All ──→ T-7.11 (Tests) ──→ T-7.12 (Integration)
```

### Parallelization Strategy

**Wave 1** (can run concurrently):
- T-7.1 (WAL migration)
- T-7.2 (Circuit breaker)
- T-7.6 (IdentityLoader)

**Wave 2** (after T-7.1):
- T-7.3 (Recovery engine)
- T-7.4 (R2CheckpointStorage)
- T-7.7 (LearningStore)
- T-7.8 (BeadsWALAdapter)

**Wave 3** (after wave 2):
- T-7.5 (GitRecoverySource) — needs T-7.3
- T-7.9 (Pruner) — needs T-7.1, T-7.4
- T-7.10 (Health) — needs T-7.2, T-7.3

**Wave 4** (final):
- T-7.11 (Tests) — needs all above
- T-7.12 (Integration) — needs T-7.11

---

### Lines Deleted vs Created

| Category | Files | Lines |
|----------|-------|-------|
| **Deleted** | `wal.ts`, `recovery.ts`, `r2-sync.ts`, `circuit-breaker.ts` | -770 |
| **Created** | `r2-storage.ts`, `git-source.ts`, `config.ts`, `learnings.ts` | +290 |
| **Modified** | `index.ts`, `pruner.ts`, `scheduler.ts`, `health.ts`, `session.ts`, `git-push.ts` | ~-20 |
| **Net** | | **~-500** |

---

### Flatline Review Integration (v1.1.0)

**SDD Review** (Opus + GPT-5.2, 217s):
- 6 blockers addressed → SDD DD-1, DD-8, DD-9, DD-10, DD-11, DD-12, DD-13
- Key hardening: upstream version pinning, segment-based checkpoints, recovery freshness, credential security

**Sprint Review** (Opus + GPT-5.2, 215s):
- 6 blockers addressed → acceptance criteria updated on T-7.1, T-7.3, T-7.4, T-7.5, T-7.8, T-7.9
- 4 high-consensus items integrated (upstream pin, error contracts, concurrency model, boot timeout)
- 1 disputed item (legacy WAL migration) — resolved by DD-4 (clean start, pre-production)
- 4 new test cases added to T-7.11

**Net effort impact**: +3h (23h → 26h) from additional safety/validation logic
