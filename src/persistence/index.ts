// src/persistence/index.ts — Persistence module barrel export

// Upstream re-exports (thin layer over .claude/lib/persistence/)
export {
  WALManager,
  createWALManager,
  PersistenceError,
} from "./upstream.js"

export type {
  WALManagerConfig,
  WALEntry,
  WALOperation,
  DiskPressureStatus,
} from "./upstream.js"

// Finn utilities
export { walPath } from "./wal-path.js"
export { validateUpstreamPersistence } from "./upstream-check.js"

// Finn adapters (will be replaced in subsequent tasks)
export { GitSync } from "./git-sync.js"
export type { SnapshotResult, GitSyncStatus } from "./git-sync.js"
export { ObjectStoreSync } from "./r2-sync.js"
export type { SyncResult, R2Checkpoint } from "./r2-sync.js"
export { WALPruner } from "./pruner.js"
export type { PruneResult } from "./pruner.js"
export { R2CheckpointStorage } from "./r2-storage.js"
export type { R2StorageConfig } from "./r2-storage.js"
