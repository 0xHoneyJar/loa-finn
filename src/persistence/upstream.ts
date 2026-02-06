// src/persistence/upstream.ts — Barrel re-export of upstream Loa persistence framework
// Pin: PR #7 merge commit 5fd0dac (DD-1)
// All Finn modules import upstream through this file.

// ── Types ────────────────────────────────────────────────────
export {
  PersistenceError,
} from "../../.claude/lib/persistence/types.js"

export type {
  PersistenceErrorCode,
} from "../../.claude/lib/persistence/types.js"

// ── Circuit Breaker ──────────────────────────────────────────
export {
  CircuitBreaker,
} from "../../.claude/lib/persistence/circuit-breaker.js"

export type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  CircuitBreakerStateChangeCallback,
} from "../../.claude/lib/persistence/circuit-breaker.js"

// ── WAL ──────────────────────────────────────────────────────
export {
  WALManager,
  createWALManager,
} from "../../.claude/lib/persistence/wal/wal-manager.js"

export type {
  WALManagerConfig,
} from "../../.claude/lib/persistence/wal/wal-manager.js"

export {
  generateEntryId,
  verifyEntry,
  computeDataChecksum,
  computeEntryChecksum,
} from "../../.claude/lib/persistence/wal/wal-entry.js"

export type {
  WALEntry,
  WALOperation,
  WALSegment,
  WALCheckpoint,
} from "../../.claude/lib/persistence/wal/wal-entry.js"

export {
  compactEntries,
} from "../../.claude/lib/persistence/wal/wal-compaction.js"

export {
  evaluateDiskPressure,
} from "../../.claude/lib/persistence/wal/wal-pressure.js"

export type {
  DiskPressureStatus,
} from "../../.claude/lib/persistence/wal/wal-pressure.js"

// ── Checkpoint ───────────────────────────────────────────────
export {
  CheckpointProtocol,
} from "../../.claude/lib/persistence/checkpoint/checkpoint-protocol.js"

export type {
  CheckpointProtocolConfig,
} from "../../.claude/lib/persistence/checkpoint/checkpoint-protocol.js"

export {
  createManifest,
  verifyManifest,
} from "../../.claude/lib/persistence/checkpoint/checkpoint-manifest.js"

export type {
  CheckpointManifest,
  CheckpointFileEntry,
  WriteIntent,
} from "../../.claude/lib/persistence/checkpoint/checkpoint-manifest.js"

export {
  MountCheckpointStorage,
} from "../../.claude/lib/persistence/checkpoint/storage-mount.js"

export type {
  ICheckpointStorage,
} from "../../.claude/lib/persistence/checkpoint/storage-mount.js"

// ── Recovery ─────────────────────────────────────────────────
export {
  RecoveryEngine,
} from "../../.claude/lib/persistence/recovery/recovery-engine.js"

export type {
  RecoveryEngineConfig,
  RecoveryState,
} from "../../.claude/lib/persistence/recovery/recovery-engine.js"

export type {
  IRecoverySource,
} from "../../.claude/lib/persistence/recovery/recovery-source.js"

export {
  MountRecoverySource,
} from "../../.claude/lib/persistence/recovery/sources/mount-source.js"

export {
  GitRecoverySource,
} from "../../.claude/lib/persistence/recovery/sources/git-source.js"

export type {
  GitRestoreClient,
} from "../../.claude/lib/persistence/recovery/sources/git-source.js"

export {
  TemplateRecoverySource,
} from "../../.claude/lib/persistence/recovery/sources/template-source.js"

// ── Identity ─────────────────────────────────────────────────
export {
  IdentityLoader,
  createIdentityLoader,
} from "../../.claude/lib/persistence/identity/identity-loader.js"

export type {
  IdentityLoaderConfig,
  IdentityDocument,
  Principle,
  Boundary,
} from "../../.claude/lib/persistence/identity/identity-loader.js"

export {
  FileWatcher,
} from "../../.claude/lib/persistence/identity/file-watcher.js"

export type {
  FileWatcherConfig,
  FileChangeCallback,
} from "../../.claude/lib/persistence/identity/file-watcher.js"

// ── Learning ─────────────────────────────────────────────────
export {
  LearningStore,
} from "../../.claude/lib/persistence/learning/learning-store.js"

export type {
  Learning,
  LearningStatus,
  LearningTarget,
  LearningStoreConfig,
  ILearningWAL,
  IQualityGateScorer,
} from "../../.claude/lib/persistence/learning/learning-store.js"

export {
  DefaultQualityGateScorer,
} from "../../.claude/lib/persistence/learning/quality-gates.js"

// ── Beads ────────────────────────────────────────────────────
export {
  BeadsWALAdapter,
} from "../../.claude/lib/persistence/beads/beads-wal-adapter.js"

export type {
  BeadsWALConfig,
  BeadWALEntry,
  BeadOperation,
  IBeadsWAL,
} from "../../.claude/lib/persistence/beads/beads-wal-adapter.js"

// BeadsRecoveryHandler omitted: upstream has type mismatch (NonSharedBuffer vs string)
// in default shell executor. Re-add when upstream fixes IShellExecutor compat (issue #14).
