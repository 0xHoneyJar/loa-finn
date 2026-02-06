// src/persistence/index.ts — Persistence module barrel export

export { WAL, DiskPressureError } from "./wal.js"
export type { WALEntry, WALEntryType } from "./wal.js"
export { ObjectStoreSync } from "./r2-sync.js"
export type { SyncResult, R2Checkpoint } from "./r2-sync.js"
export { GitSync } from "./git-sync.js"
export type { SnapshotResult, GitSyncStatus } from "./git-sync.js"
export { RecoveryCascade } from "./recovery.js"
export type { RecoveryResult, RecoveryMode, RecoverySource, ConflictInfo } from "./recovery.js"
export { WALPruner } from "./pruner.js"
export type { PruneResult } from "./pruner.js"
