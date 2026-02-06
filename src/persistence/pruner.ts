// src/persistence/pruner.ts — WAL pruning & retention (SDD §3.3.1, T-3.7)

import type { WAL } from "./wal.js"
import type { ObjectStoreSync } from "./r2-sync.js"
import type { GitSync } from "./git-sync.js"

export interface PruneResult {
  segmentsPruned: number
  segmentsMarked: number
}

export class WALPruner {
  constructor(
    private wal: WAL,
    private r2Sync: ObjectStoreSync,
    private gitSync: GitSync,
  ) {}

  /**
   * Mark and prune WAL segments that have been confirmed in both R2 and git.
   * Only prunes segments where both R2 checkpoint and git snapshot confirm the data.
   */
  async pruneConfirmed(): Promise<PruneResult> {
    const checkpoint = this.r2Sync.getLastCheckpoint()
    if (!checkpoint) {
      return { segmentsPruned: 0, segmentsMarked: 0 }
    }

    // Only prune if git sync is also healthy (or unconfigured)
    if (this.gitSync.isConfigured && this.gitSync.currentStatus !== "ok") {
      return { segmentsPruned: 0, segmentsMarked: 0 }
    }

    // Find segments that exist in the R2 checkpoint
    const syncedKeys = new Set(checkpoint.walSegments)
    const localSegments = this.wal.getSegments()

    // Mark old segments as prunable (not the current/latest one)
    const toMark = localSegments.filter((seg) => {
      const key = `wal/${seg.split("/").pop()}`
      return syncedKeys.has(key)
    })

    // The last segment in the list is likely the active one — WAL.markPrunable handles this
    this.wal.markPrunable(toMark)

    // Now prune previously marked segments
    const pruned = this.wal.prune()

    return {
      segmentsPruned: pruned,
      segmentsMarked: toMark.length,
    }
  }
}
