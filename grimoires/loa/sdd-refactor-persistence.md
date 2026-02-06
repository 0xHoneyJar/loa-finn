# Software Design Document: Adopt Upstream Loa Persistence Framework

> **Version**: 1.1.0
> **Date**: 2026-02-06
> **Author**: @janitooor
> **Status**: Draft
> **PRD**: `grimoires/loa/prd-refactor-persistence.md` v1.0.0
> **Parent SDD**: `grimoires/loa/sdd.md` v1.0.0 (loa-finn MVP)
> **Grounding**: `.claude/lib/persistence/index.ts` API surface, `src/index.ts` boot sequence

---

## 1. Executive Summary

This SDD specifies how loa-finn adopts the upstream Loa persistence framework (`.claude/lib/persistence/`) introduced in PR #7. The refactoring replaces 561 lines of custom persistence code with thin adapters over the upstream library, while preserving Finn's R2 and git sync as pluggable backends.

### Architecture Change

```
BEFORE (921 lines custom):
┌──────────────────────────────────────────┐
│  src/persistence/                        │
│  ├── wal.ts          (225 lines)         │  ← Custom WAL
│  ├── recovery.ts     (198 lines)         │  ← Custom recovery
│  ├── r2-sync.ts      (209 lines)         │  ← R2 client
│  ├── git-sync.ts     (234 lines)         │  ← Git worktree
│  └── pruner.ts       (55 lines)          │  ← Custom pruner
│  src/scheduler/                          │
│  └── circuit-breaker.ts (138 lines)      │  ← Custom CB
└──────────────────────────────────────────┘

AFTER (~350 lines custom):
┌──────────────────────────────────────────┐
│  .claude/lib/persistence/  (upstream)    │
│  ├── WALManager                          │  ← Framework WAL
│  ├── CircuitBreaker                      │  ← Framework CB
│  ├── RecoveryEngine                      │  ← Framework recovery
│  ├── CheckpointProtocol                  │  ← Framework checkpoint
│  ├── IdentityLoader                      │  ← Framework identity
│  ├── LearningStore                       │  ← Framework learning
│  └── BeadsWALAdapter                     │  ← Framework beads bridge
├──────────────────────────────────────────┤
│  src/persistence/  (thin adapters)       │
│  ├── r2-storage.ts   (~120 lines)        │  ← ICheckpointStorage → R2
│  ├── git-source.ts   (~80 lines)         │  ← IRecoverySource → Git
│  ├── pruner.ts       (~40 lines)         │  ← Compaction + 2-source guard
│  └── config.ts       (~30 lines)         │  ← Wiring configuration
│  src/agent/                              │
│  └── learnings.ts    (~40 lines)         │  ← LearningStore wiring
└──────────────────────────────────────────┘
```

**Key principle**: One source of truth for persistence primitives. Finn only owns what the upstream doesn't provide (R2 client, git worktree logic).

---

## 2. Design Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| DD-1 | Import upstream from `.claude/lib/persistence/` pinned to commit hash | System Zone is read-only; pin prevents silent drift (Flatline SKP-001) |
| DD-2 | Wrap R2 as `ICheckpointStorage` | Upstream's checkpoint protocol handles two-phase commits |
| DD-3 | Wrap Git as `IRecoverySource` | Upstream's recovery engine handles cascade + loop detection |
| DD-4 | Clean WAL start (no migration) | Pre-production; ULID→timestamp-seq format change not worth migrating |
| DD-5 | Upstream `CircuitBreaker` replaces Finn's | Lazy timers (no leaks), injectable clock (testable) |
| DD-6 | `IdentityLoader` replaces manual load | Hot-reload with change detection already built |
| DD-7 | `LearningStore` implements FR-6.5 | Quality-gated compound learnings without new custom code |
| DD-8 | `BeadsWALAdapter` implements FR-4.3 | Shell-safe bead transitions; use `execFile` not shell (Flatline SKP-007) |
| DD-9 | Keep Finn's two-source pruning guard with seq confirmation | Upstream compaction handles delta; Finn tracks confirmed seq per backend (Flatline SKP-004/SKP-008) |
| DD-10 | Checkpoint WAL segments, not individual entries | Align with upstream segment boundaries to avoid R2 object explosion (Flatline SKP-002) |
| DD-11 | Recovery sources carry monotonic version | Global WAL seq embedded in R2 manifests and git snapshots for freshness comparison (Flatline SKP-003) |
| DD-12 | Boot recovery has per-source timeouts + overall deadline | Prevents startup hangs from slow/misconfigured sources (Flatline Sprint SKP-003) |
| DD-13 | Canonical path builder with validation at append | Prevents path-prefix encoding bugs (Flatline Sprint SKP-001) |

---

## 3. Module Design

### 3.1 R2CheckpointStorage (New Adapter)

**File**: `src/persistence/r2-storage.ts` (~120 lines)

**Purpose**: Implement `ICheckpointStorage` interface using Cloudflare R2 (S3-compatible).

```typescript
import { ICheckpointStorage } from '../../.claude/lib/persistence/index.js';
import { S3Client, GetObjectCommand, PutObjectCommand,
         DeleteObjectCommand, ListObjectsV2Command,
         HeadObjectCommand } from '@aws-sdk/client-s3';

export class R2CheckpointStorage implements ICheckpointStorage {
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(config: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix?: string;  // Default: "finn/"
  });

  async isAvailable(): Promise<boolean>;
    // HeadBucket check; returns false if credentials missing

  async readFile(relativePath: string): Promise<Buffer | null>;
    // GetObjectCommand; null if NoSuchKey

  async writeFile(relativePath: string, content: Buffer): Promise<boolean>;
    // PutObjectCommand with SHA-256 in metadata

  async deleteFile(relativePath: string): Promise<boolean>;
    // DeleteObjectCommand

  async listFiles(subPrefix?: string): Promise<string[]>;
    // ListObjectsV2Command; strip prefix from keys

  async verifyChecksum(relativePath: string, expected: string): Promise<boolean>;
    // HeadObjectCommand; compare x-amz-meta-sha256

  async stat(relativePath: string): Promise<{ size: number; mtime: Date } | null>;
    // HeadObjectCommand; ContentLength + LastModified
}
```

**Integration with CheckpointProtocol**:
```typescript
const r2Storage = new R2CheckpointStorage(config.r2);
const checkpoint = new CheckpointProtocol({
  storage: r2Storage,
  staleIntentTimeoutMs: 10 * 60 * 1000,  // 10 minutes
});
```

**What moves from `r2-sync.ts`**:
- S3Client initialization → `R2CheckpointStorage` constructor
- Upload logic → `writeFile()` + upstream `CheckpointProtocol.beginCheckpoint()`
- Download logic → `readFile()` + upstream `CheckpointProtocol.getManifest()`
- Verification logic → `verifyChecksum()` + upstream `CheckpointProtocol.finalizeCheckpoint()`
- Checkpoint format → replaced by upstream `CheckpointManifest`

**What gets deleted**: The entire `sync()` and `restore()` methods from `r2-sync.ts`. The upstream `CheckpointProtocol` handles two-phase intent-based commits with stale intent cleanup.

### 3.2 GitRecoverySource (New Adapter)

**File**: `src/persistence/git-source.ts` (~80 lines)

**Purpose**: Implement `IRecoverySource` using Finn's git worktree snapshot logic.

```typescript
import { IRecoverySource } from '../../.claude/lib/persistence/index.js';

export class FinnGitRecoverySource implements IRecoverySource {
  readonly name = "git";

  constructor(config: {
    remote: string;
    branch: string;
    archiveBranch: string;
    repoDir: string;
    token?: string;
  });

  async isAvailable(): Promise<boolean>;
    // git ls-remote check; returns false if diverged or unreachable

  async restore(): Promise<Map<string, Buffer> | null>;
    // 1. git fetch
    // 2. Read snapshot-manifest.json via `git show`
    // 3. Read each file via `git show` (no checkout)
    // 4. Return Map<relativePath, Buffer>
    // 5. Any missing file → return null (all-or-nothing)
}
```

**What moves from `git-sync.ts`**:
- Fetch + manifest read logic → `restore()`
- Conflict detection (merge-base check) → `isAvailable()`
- `git show` file reads → `restore()`

**What stays in git-sync.ts** (renamed to `git-push.ts`, ~100 lines):
- `snapshot()` — create worktree, copy files, commit
- `push()` — fast-forward push to archive branch
- These are **write** operations; `IRecoverySource` is read-only

```typescript
// git-push.ts — outbound sync (not part of recovery)
export class GitPush {
  constructor(config: GitPushConfig);
  async snapshot(): Promise<SnapshotResult>;
  async push(): Promise<void>;
  get currentStatus(): GitSyncStatus;
}
```

### 3.3 WAL Migration

**Deleted file**: `src/persistence/wal.ts` (225 lines)

**Replacement**: Upstream `WALManager` from `.claude/lib/persistence/wal/wal-manager.ts`

**Initialization change in `src/index.ts`**:

```typescript
// BEFORE
import { WAL } from './persistence/wal.js';
const wal = new WAL(config.dataDir);

// AFTER
import { createWALManager } from '../.claude/lib/persistence/index.js';
const wal = createWALManager(path.join(config.dataDir, 'wal'));
await wal.initialize();
```

**API mapping for callers**:

| Finn WAL API | Upstream WALManager API | Notes |
|--------------|----------------------|-------|
| `wal.append(type, op, path, data)` | `wal.append(op, walPath(prefix, ...segments), data?)` | Drop `type`; use canonical `walPath()` builder (DD-13) |
| `wal.replay(since?)` | `wal.replay(callback, { sinceSeq })` | Generator → callback visitor pattern |
| `wal.rotate()` | Automatic (on size/age threshold) | No manual rotation needed |
| `wal.getSegments()` | `wal.getStatus().segmentCount` | Less granular but sufficient |
| `wal.isDiskPressure` | `wal.getDiskPressure() !== "normal"` | Enum vs boolean |
| `wal.getHeadEntryId()` | `wal.getStatus().seq` | ULID → monotonic sequence number |
| *(none)* | `wal.getCompletedSegments(sinceSeq)` | Sealed segments for checkpoint upload (DD-10) |
| *(none)* | `wal.initialize()` | Truncates partial tail records, validates CRC |
| *(none)* | `wal.shutdown()` | Releases flock, flushes active segment |

**Replay invariants**:
- Ordering: entries replayed in append order (monotonic seq)
- Semantics: at-least-once delivery; callers must be idempotent
- Across segments: callback traverses segment boundaries transparently
- After compaction: only latest entry per path retained (keep-latest-per-path)

**Type encoding convention** (replacing the `type` field):

| Old `type` | New `path` prefix | Example |
|------------|-------------------|---------|
| `"session"` | `sessions/` | `sessions/{sessionId}/event.jsonl` |
| `"bead"` | `.beads/` | `.beads/wal/{beadId}/{uuid}.json` |
| `"memory"` | `learnings/` | `learnings/learnings.json` |
| `"config"` | `config/` | `config/circuit-breaker/{taskId}` |

**Canonical path builder** (DD-13, addresses Flatline Sprint SKP-001):

```typescript
const VALID_PREFIXES = ['sessions/', '.beads/', 'learnings/', 'config/'] as const;

export function walPath(prefix: typeof VALID_PREFIXES[number], ...segments: string[]): string {
  // Validate prefix
  if (!VALID_PREFIXES.includes(prefix)) {
    throw new PersistenceError('INVALID_PATH', `Unknown prefix: ${prefix}`);
  }
  // Normalize: no leading slash, no double separators, no '..'
  const path = prefix + segments.join('/');
  if (path.includes('..') || path.includes('//') || path.startsWith('/')) {
    throw new PersistenceError('INVALID_PATH', `Path traversal rejected: ${path}`);
  }
  return path;
}
```

All callers MUST use `walPath()` instead of string concatenation.

**Crash safety** (DD-12, addresses Flatline Sprint SKP-002):

Upstream `WALManager` uses length-prefixed + CRC32 record format. On recovery, partial tail records (from SIGKILL mid-write) are detected by CRC mismatch and safely truncated. `wal.initialize()` performs this truncation automatically. A startup self-check validates:
1. WAL directory exists and is writable
2. Active segment is parseable (no corruption beyond truncatable tail)
3. Sequence numbers are monotonically increasing

### 3.4 Circuit Breaker Migration

**Deleted file**: `src/scheduler/circuit-breaker.ts` (138 lines)

**Replacement**: Upstream `CircuitBreaker`

**Change in scheduler.ts**:

```typescript
// BEFORE
import { CircuitBreaker } from './circuit-breaker.js';
const cb = new CircuitBreaker(taskId, { failureThreshold: 3, cooldownMs: 300_000 });

// AFTER
import { CircuitBreaker } from '../../.claude/lib/persistence/index.js';
const cb = new CircuitBreaker(
  { maxFailures: 3, resetTimeMs: 300_000, halfOpenRetries: 1 },
  {
    onStateChange: (from, to) => {
      wal.append("write", `config/circuit-breaker/${taskId}`,
        Buffer.from(JSON.stringify({ taskId, from, to, timestamp: Date.now() }))
      );
    },
  }
);
```

**Key difference**: Upstream circuit breaker has no `setTimeout` — state transitions are checked lazily on `getState()`. This eliminates timer leak concerns for CF Workers.

### 3.5 Recovery Engine Migration

**Deleted file**: `src/persistence/recovery.ts` (198 lines)

**Replacement**: Upstream `RecoveryEngine` with Finn's sources plugged in.

```typescript
import {
  RecoveryEngine, TemplateRecoverySource, MountRecoverySource
} from '../../.claude/lib/persistence/index.js';
import { R2CheckpointStorage } from './r2-storage.js';
import { FinnGitRecoverySource } from './git-source.js';

// Build source cascade
const r2Storage = new R2CheckpointStorage(config.r2);
const mountSource = new MountRecoverySource(r2Storage);
const gitSource = new FinnGitRecoverySource(config.git);
const templateSource = new TemplateRecoverySource(new Map([
  ['grimoires/loa/BEAUVOIR.md', Buffer.from(defaultBeauvoir)],
  ['grimoires/loa/NOTES.md', Buffer.from('# NOTES.md\n\n## Learnings\n\n## Blockers\n')],
]));

const recovery = new RecoveryEngine({
  sources: [mountSource, gitSource, templateSource],  // Priority order
  loopMaxFailures: 3,
  loopWindowMs: 10 * 60 * 1000,
  perSourceTimeoutMs: 30_000,     // DD-12: 30s per source
  overallDeadlineMs: 120_000,     // DD-12: 2min total boot deadline
  onStateChange: (from, to) => {
    console.log(`[recovery] ${from} → ${to}`);
  },
  onEvent: (event, data) => {
    console.log(`[recovery] ${event}`, data);
  },
});

const result = await recovery.run();
```

**State mapping to Finn's health**:

| Upstream `RecoveryState` | Finn Health Status | Finn Recovery Mode |
|--------------------------|-------------------|--------------------|
| `RUNNING` | `healthy` | `strict` (successful) |
| `RECOVERING` | `degraded` | — (transient) |
| `DEGRADED` | `degraded` | `degraded` |
| `LOOP_DETECTED` | `unhealthy` | — (fatal) |
| `IDLE` | — | — (pre-boot) |

### 3.6 IdentityLoader Adoption

**Modified file**: `src/agent/session.ts`

**Current approach** (manual, no hot-reload):
```typescript
// Load once at boot, passed to resource loader
const identity = await loadIdentity(beauvoirPath);
```

**New approach** (upstream IdentityLoader):
```typescript
import { createIdentityLoader } from '../../.claude/lib/persistence/index.js';

const identityLoader = createIdentityLoader(config.dataDir);
await identityLoader.load();

// Hot-reload with change detection
identityLoader.startWatching((filePath) => {
  console.log(`[identity] BEAUVOIR.md changed, reloading`);
  // Next session creation picks up new identity
});

// In session creation:
const identity = identityLoader.getIdentity();
// identity.corePrinciples, identity.boundaries, etc.
```

**Scheduler task change**: Remove `identity_reload` task (60s interval). The `FileWatcher` handles this natively with debouncing.

### 3.7 LearningStore Adoption

**New file**: `src/agent/learnings.ts` (~40 lines)

```typescript
import { LearningStore, DefaultQualityGateScorer } from '../../.claude/lib/persistence/index.js';

export function createLearningStore(dataDir: string, wal?: ILearningWAL): LearningStore {
  return new LearningStore(
    {
      basePath: path.join(dataDir, 'learnings'),
      wal,
    },
    new DefaultQualityGateScorer()
  );
}

// Session integration — load recent learnings into context
export async function getContextLearnings(store: LearningStore): Promise<string> {
  const learnings = await store.getLearnings('active');
  const recent = learnings
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, 20);

  if (recent.length === 0) return '';

  return '## Recent Learnings\n\n' +
    recent.map(l =>
      `- **${l.trigger}**: ${l.solution} (confidence: ${
        l.effectiveness
          ? (l.effectiveness.successes / l.effectiveness.applications * 100).toFixed(0) + '%'
          : 'new'
      })`
    ).join('\n');
}
```

**Integration with session creation** (`session.ts`):
```typescript
const learningsContext = await getContextLearnings(learningStore);
// Append to system prompt after identity
```

### 3.8 BeadsWALAdapter Adoption

**Integration in boot sequence** (`src/index.ts`):

```typescript
import { BeadsWALAdapter, BeadsRecoveryHandler } from '../../.claude/lib/persistence/index.js';

// After WAL initialization
const beadsAdapter = new BeadsWALAdapter(wal, {
  pathPrefix: '.beads/wal',
  verbose: false,
});

// During recovery — replay bead transitions via execFile (DD-8, no shell)
const beadsRecovery = new BeadsRecoveryHandler(beadsAdapter, {
  beadsDir: '.beads',
  brCommand: 'br',
  skipSync: false,
  useExecFile: true,  // execFile with fixed argv, no shell invocation
});
const beadsResult = await beadsRecovery.recover();
// If `br` binary is missing/wrong version, recovery degrades gracefully
// (logs warning, skips bead replay, does not block boot)
```

**Bead state transitions** (used throughout the app):
```typescript
// When a session is created
await beadsAdapter.recordTransition({
  operation: 'update',
  beadId: sessionBeadId,
  payload: { status: 'active', label: 'session:active' },
});
```

### 3.9 Pruner Refactor

**Modified file**: `src/persistence/pruner.ts` (~55 lines)

```typescript
export class WALPruner {
  private confirmedR2Seq = 0;
  private confirmedGitSeq = 0;
  private readonly minRetainedSegments = 2;  // Safety floor

  constructor(
    private wal: WALManager,
    private r2Storage: R2CheckpointStorage,
    private gitPush: GitPush,
  ) {}

  /** Called by R2 sync after successful finalizeCheckpoint */
  setConfirmedR2Seq(seq: number): void { this.confirmedR2Seq = seq; }

  /** Called by Git sync after successful push */
  setConfirmedGitSeq(seq: number): void { this.confirmedGitSeq = seq; }

  async pruneConfirmed(): Promise<{ segmentsPruned: number }> {
    // Guard: only prune entries confirmed by BOTH backends (DD-9)
    const safeSeq = Math.min(this.confirmedR2Seq, this.confirmedGitSeq);
    if (safeSeq === 0) {
      return { segmentsPruned: 0 };
    }

    // Never compact active segment; retain minimum segments floor
    const result = await this.wal.compact({
      belowSeq: safeSeq,
      retainSegments: this.minRetainedSegments,
    });
    return { segmentsPruned: result.segmentsRemoved ?? 0 };
  }
}
```

---

## 4. Boot Sequence (Updated)

```
Phase 1: Config + Upstream Validation (CHANGED)
  └─ loadConfig() → FinnConfig
  └─ validateUpstream() — verify pinned upstream symbols (DD-1)

Phase 2: WAL (CHANGED)
  └─ createWALManager(dataDir + '/wal')
  └─ await wal.initialize() — truncates partial tail records, validates CRC

Phase 3: Storage Adapters (NEW)
  ├─ R2CheckpointStorage(config.r2)
  ├─ CheckpointProtocol({ storage: r2Storage })
  ├─ FinnGitRecoverySource(config.git)
  └─ GitPush(config.git)               // Outbound only

Phase 4: Recovery (CHANGED)
  └─ RecoveryEngine({
       sources: [MountRecoverySource(r2Storage), gitSource, templateSource],
       loopMaxFailures: 3,
       perSourceTimeoutMs: 30_000,     // DD-12
       overallDeadlineMs: 120_000,     // DD-12
     })
  └─ await recovery.run()              // BLOCKING with deadline
  └─ If template fallback used → disable outbound sync (DD-11)

Phase 5: Identity (CHANGED)
  └─ createIdentityLoader(dataDir)
  └─ await identityLoader.load()
  └─ identityLoader.startWatching()    // Replaces scheduler task

Phase 6: Learning Store (NEW)
  └─ createLearningStore(dataDir, wal)

Phase 7: Beads Bridge (CHANGED)
  ├─ BeadsWALAdapter(wal)
  ├─ BeadsRecoveryHandler(beadsAdapter)
  └─ await beadsRecovery.recover()

Phase 8: Gateway
  └─ createApp(config) → { app, router }

Phase 9: Scheduler + Health (CHANGED)
  └─ Scheduler() with upstream CircuitBreaker
  └─ HealthAggregator(deps) — maps upstream states
  └─ 4 tasks (identity_reload removed):
     1. r2_sync     → checkpoint.beginCheckpoint() + finalizeCheckpoint()
     2. git_sync    → gitPush.snapshot() + gitPush.push()
     3. health      → healthAggregator.check()
     4. wal_prune   → pruner.pruneConfirmed()

Phase 10: HTTP Server + WebSocket

Phase 11: Graceful Shutdown
  └─ scheduler.stop()
  └─ Final checkpoint via CheckpointProtocol
  └─ wal.shutdown()                    // Release flock
  └─ server.close()
```

### Dependency Graph (Updated)

```
config ──────┐
             ├─→ wal (upstream WALManager)
             │     ├─→ r2Storage (ICheckpointStorage adapter)
             │     │     └─→ checkpointProtocol (upstream)
             │     ├─→ gitSource (IRecoverySource adapter)
             │     ├─→ gitPush (outbound sync)
             │     ├─→ beadsAdapter (upstream BeadsWALAdapter)
             │     │     └─→ beadsRecovery (upstream handler)
             │     └─→ learningStore (upstream LearningStore)
             │
             ├─→ recoveryEngine (upstream) ← [mountSource, gitSource, templateSource]
             │
             ├─→ identityLoader (upstream) ← FileWatcher
             │
             ├─→ gateway (Hono + SessionRouter)
             │
             └─→ scheduler
                  ├─ circuitBreaker (upstream, per task)
                  └─ healthAggregator
                       ├─ wal.getDiskPressure()
                       ├─ recovery.getState()
                       ├─ circuitBreaker.getState() (per task)
                       ├─ r2Storage.isAvailable()
                       ├─ gitPush.currentStatus
                       └─ beadsAdapter.getCurrentSeq()
```

---

## 5. Health Aggregator Changes

**Updated HealthDeps interface**:

```typescript
interface HealthDeps {
  config: FinnConfig;
  wal: WALManager;                     // Was: WAL
  r2Storage: R2CheckpointStorage;      // Was: ObjectStoreSync
  gitPush: GitPush;                    // Was: GitSync
  recovery: RecoveryEngine;            // NEW
  scheduler: Scheduler;
  identityLoader: IdentityLoader;      // NEW
  learningStore: LearningStore;        // NEW
  getSessionCount: () => number;
  getBeadsAvailable: () => boolean;
}
```

**Updated status tree**:

```typescript
interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  checks: {
    agent: { status: string; model: string; sessionCount: number };
    wal: {
      status: string;
      segmentCount: number;
      diskPressure: DiskPressureStatus;  // Was: boolean
      seq: number;                       // NEW: current sequence
    };
    r2: {
      status: string;                    // "ok" | "disabled" | "unavailable"
      lastCheckpoint?: string;           // NEW: manifest version
    };
    git: {
      status: string;                    // "ok" | "conflict" | "error" | "disabled"
    };
    recovery: {
      state: RecoveryState;              // NEW: upstream state
      source?: string;                   // NEW: which source succeeded
    };
    identity: {
      status: string;                    // NEW
      checksum: string;                  // NEW: current BEAUVOIR.md hash
      watching: boolean;                 // NEW: FileWatcher active
    };
    learnings: {
      total: number;                     // NEW
      active: number;                    // NEW
    };
    beads: { status: string; available: boolean };
    scheduler: { status: string; tasks: TaskStatus[] };
  };
}
```

**Updated status computation**:

```
unhealthy if:
  - wal.diskPressure === "critical"
  - recovery.state === "LOOP_DETECTED"
  - agent.status !== "ok"

degraded if:
  - wal.diskPressure === "warning"
  - recovery.state === "DEGRADED"
  - r2.status === "unavailable"
  - git.status === "conflict"
  - scheduler has open circuit breakers
  - !beadsAvailable

healthy otherwise
```

---

## 6. R2 Sync Task (Updated)

The R2 sync task uploads WAL **segments** (not individual entries) via `CheckpointProtocol` (DD-10):

```typescript
// Sync task handler — single-flight guard prevents concurrent runs
let syncInFlight = false;

async function r2SyncHandler() {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    // 1. Get completed (non-active) WAL segments since last checkpoint
    const manifest = await checkpoint.getManifest();
    const lastCheckpointSeq = manifest?.metadata?.walSeq ?? 0;
    const status = wal.getStatus();

    // Only upload sealed segments — never the active one
    const segments = await wal.getCompletedSegments(lastCheckpointSeq);
    if (segments.length === 0) return;

    // 2. Prepare segment files for checkpoint
    const files = segments.map(seg => ({
      relativePath: `wal/segments/${seg.name}`,
      content: seg.content,
    }));

    // 3. Two-phase checkpoint with idempotent intent naming
    const intentId = `checkpoint-${status.seq}`;
    await checkpoint.beginCheckpoint(intentId, files);
    await checkpoint.finalizeCheckpoint(intentId, files, {
      metadata: { walSeq: status.seq, timestamp: Date.now() },
    });

    // 4. Record confirmed R2 seq for pruning safety (DD-9)
    confirmedR2Seq = status.seq;

    // 5. Clean stale intents (TTL-based, >10min old)
    await checkpoint.cleanStaleIntents();
  } finally {
    syncInFlight = false;
  }
}
```

---

## 7. Testing Strategy

### Existing Tests (Must Pass)

All 27 existing tests must pass with upstream primitives. Changes needed:

| Test File | Changes Required |
|-----------|-----------------|
| `tests/persistence/wal.test.ts` | Update imports; `append()` signature change (drop `type`) |
| `tests/persistence/recovery.test.ts` | Update to `RecoveryEngine` API; mock `IRecoverySource` |
| `tests/persistence/r2-sync.test.ts` | Test `R2CheckpointStorage` adapter; mock S3Client |
| `tests/persistence/git-sync.test.ts` | Split: `FinnGitRecoverySource` + `GitPush` tests |
| `tests/persistence/pruner.test.ts` | Update to use upstream `compact()` |
| `tests/scheduler/circuit-breaker.test.ts` | Update to upstream `CircuitBreaker` API |
| `tests/integration/compound-trajectory.test.ts` | Should pass unchanged (tests Pi SDK layer) |

### New Tests

| Test File | Coverage |
|-----------|----------|
| `tests/persistence/r2-storage.test.ts` | `ICheckpointStorage` contract compliance |
| `tests/persistence/git-source.test.ts` | `IRecoverySource` contract compliance |
| `tests/agent/learnings.test.ts` | `getContextLearnings()` formatting |
| `tests/integration/kill-restart.test.ts` | Full kill → restart → resume cycle |

### Interface Contract Tests

Each adapter should verify it satisfies the upstream interface contract:

```typescript
// r2-storage.test.ts
describe('R2CheckpointStorage implements ICheckpointStorage', () => {
  it('returns null for missing files', async () => { /* ... */ });
  it('round-trips file content', async () => { /* ... */ });
  it('verifies checksums correctly', async () => { /* ... */ });
  it('returns false when unavailable', async () => { /* ... */ });
  it('lists files with prefix filtering', async () => { /* ... */ });
  it('prevents path traversal', async () => { /* ... */ });
});
```

---

## 8. Migration Checklist

### Files to Delete

| File | Lines | Replaced By |
|------|-------|-------------|
| `src/persistence/wal.ts` | 225 | Upstream `WALManager` |
| `src/persistence/recovery.ts` | 198 | Upstream `RecoveryEngine` |
| `src/persistence/r2-sync.ts` | 209 | `r2-storage.ts` + upstream `CheckpointProtocol` |
| `src/scheduler/circuit-breaker.ts` | 138 | Upstream `CircuitBreaker` |
| **Total** | **770** | |

### Files to Create

| File | Est. Lines | Purpose |
|------|-----------|---------|
| `src/persistence/r2-storage.ts` | ~120 | `ICheckpointStorage` → R2 |
| `src/persistence/git-source.ts` | ~80 | `IRecoverySource` → Git worktree |
| `src/persistence/config.ts` | ~30 | Persistence wiring config type |
| `src/agent/learnings.ts` | ~40 | LearningStore wiring |
| **Total** | **~270** | |

### Files to Modify

| File | Changes |
|------|---------|
| `src/index.ts` | New boot sequence (§4); upstream imports |
| `src/persistence/index.ts` | Re-export upstream + adapters |
| `src/persistence/git-sync.ts` | Rename to `git-push.ts`; remove restore logic |
| `src/persistence/pruner.ts` | Use upstream `compact()`; keep two-source guard |
| `src/scheduler/scheduler.ts` | Upstream `CircuitBreaker`; remove identity_reload task |
| `src/scheduler/health.ts` | Updated deps interface; upstream state mapping |
| `src/agent/session.ts` | `IdentityLoader` + learnings context |
| `src/gateway/sessions.ts` | No changes (SessionRouter is independent) |
| `src/gateway/ws.ts` | No changes (WebSocket is independent) |

### Net Line Impact

| Category | Before | After | Delta |
|----------|--------|-------|-------|
| Deleted | 770 | 0 | -770 |
| Created | 0 | ~270 | +270 |
| Modified | — | — | ~-30 (net simplification) |
| **Net** | | | **~-530** |

---

## 9. Risk Mitigations

### Upstream Version Pinning (DD-1, Flatline SDD SKP-001)

Pin upstream persistence framework to the merge commit hash from PR #7. A startup self-check validates the expected upstream version:

```typescript
const EXPECTED_UPSTREAM_VERSION = '7c12e95';  // PR #7 merge commit

function validateUpstream(): void {
  // Check index.js exists and exports expected symbols
  const required = ['WALManager', 'CircuitBreaker', 'RecoveryEngine',
                    'CheckpointProtocol', 'ICheckpointStorage'];
  const upstream = require('../../.claude/lib/persistence/index.js');
  for (const sym of required) {
    if (!(sym in upstream)) {
      throw new PersistenceError('UPSTREAM_INCOMPATIBLE',
        `Missing symbol: ${sym}. Expected upstream version: ${EXPECTED_UPSTREAM_VERSION}`);
    }
  }
}
```

Finn imports through a single barrel (`src/persistence/config.ts`) so upstream changes only require updating one file.

### Import Path Stability

The `.claude/lib/persistence/` path is in System Zone (never edited by Finn). If upstream restructures, only `src/persistence/config.ts` imports need updating — all other modules import through the barrel.

### Credential Security (Flatline SDD SKP-006)

R2 and Git credentials:
- **Source**: Environment variables only (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`, `GIT_TOKEN`)
- **No hardcoded secrets**: Config constructor reads from `process.env`; no config file storage
- **Log redaction**: Credential values never logged; only `R2_ENDPOINT` hostname appears in health output
- **R2 endpoint validation**: Must match `*.r2.cloudflarestorage.com` or `*.r2.dev` pattern (prevents SSRF)
- **Least privilege**: R2 token scoped to single bucket with `PutObject/GetObject/ListObjectsV2/HeadObject/DeleteObject` only
- **Git token**: Scoped to `repo` (read/write) on archive branch only
- **Rotation**: No framework-managed rotation; operator rotates via env var update + process restart

### CF Workers Compatibility

The upstream persistence lib uses:
- `fs-ext.flock` with PID-file fallback — **compatible** (PID fallback works on CF Workers)
- `fs.watch` with `fs.watchFile` fallback — **compatible** (polling fallback works everywhere)
- No native binaries or `child_process` in core WAL/checkpoint/recovery — **compatible**

`BeadsRecoveryHandler` uses `child_process.execFile` (not `exec`) for `br` CLI — this only runs during recovery, which happens at boot (before CF Workers restrictions apply to the container). If `br` is missing, recovery degrades gracefully without blocking boot.

### Recovery Source Freshness (DD-11, Flatline SDD SKP-003)

Each checkpoint and git snapshot embeds the WAL sequence number at time of creation:
- R2 manifest: `metadata.walSeq` field
- Git snapshot: `snapshot-manifest.json` contains `walSeq` field
- Recovery compares `walSeq` across sources; picks highest consistent source
- If template source is used (walSeq=0), outbound sync is disabled until operator confirms via `/health` endpoint with `?confirm-template=true`

### Rollback Plan

If the refactoring introduces regressions:
1. Git revert the refactoring commit(s)
2. Old files are restored from git history
3. No WAL data migration needed (pre-production)
4. Upstream lib remains in `.claude/` unchanged

---

## 10. Appendix: Import Map

```typescript
// From upstream (read-only, System Zone)
import {
  // WAL
  WALManager, createWALManager, WALManagerConfig,
  WALEntry, WALOperation,
  compactEntries,
  evaluateDiskPressure, DiskPressureStatus,

  // Circuit Breaker
  CircuitBreaker, CircuitBreakerConfig, CircuitBreakerState,

  // Recovery
  RecoveryEngine, RecoveryState, RecoveryEngineConfig,
  IRecoverySource,
  MountRecoverySource, TemplateRecoverySource,

  // Checkpoint
  CheckpointProtocol, CheckpointProtocolConfig,
  ICheckpointStorage,
  CheckpointManifest, CheckpointFileEntry,

  // Identity
  IdentityLoader, createIdentityLoader,
  IdentityDocument, IdentityLoaderConfig,
  FileWatcher,

  // Learning
  LearningStore, Learning, LearningStatus,
  DefaultQualityGateScorer,

  // Beads
  BeadsWALAdapter, BeadsRecoveryHandler,
  BeadWALEntry, BeadOperation,

  // Types
  PersistenceError, PersistenceErrorCode,
} from '../../.claude/lib/persistence/index.js';

// From Finn adapters (custom)
import { R2CheckpointStorage } from './persistence/r2-storage.js';
import { FinnGitRecoverySource } from './persistence/git-source.js';
import { GitPush } from './persistence/git-push.js';
import { WALPruner } from './persistence/pruner.js';
import { createLearningStore, getContextLearnings } from './agent/learnings.js';
```
