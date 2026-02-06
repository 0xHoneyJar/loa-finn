// src/persistence/pruner.ts — WAL pruning with upstream compaction (SDD §3.3.1, DD-9, T-7.9)
// Uses upstream WALManager.compact() for deduplication and disk pressure for urgency.

import type { WALManager } from "./upstream.js"

export interface PruneResult {
  segmentsPruned: number
  compactionRatio: number
  diskPressure: string
}

export class WALPruner {
  private confirmedR2Seq = 0
  private confirmedGitSeq = 0
  private readonly minRetainedSegments = 2

  constructor(private wal: WALManager) {}

  /** Set confirmed R2 seq after successful sync. */
  setConfirmedR2Seq(seq: number): void {
    this.confirmedR2Seq = seq
  }

  /** Set confirmed git seq after successful push. */
  setConfirmedGitSeq(seq: number): void {
    this.confirmedGitSeq = seq
  }

  /** Get the minimum seq confirmed by both backends. */
  getSafeSeq(): number {
    return Math.min(this.confirmedR2Seq, this.confirmedGitSeq)
  }

  /**
   * Compact and prune WAL segments below the minimum confirmed seq.
   * Only prunes entries confirmed by BOTH R2 and git (DD-9).
   * Uses upstream disk pressure to determine urgency.
   */
  async pruneConfirmed(): Promise<PruneResult> {
    const status = this.wal.getStatus()
    const pressure = this.wal.getDiskPressure()

    // Safety: don't prune if we don't have enough segments
    if (status.segmentCount <= this.minRetainedSegments) {
      return { segmentsPruned: 0, compactionRatio: 0, diskPressure: pressure }
    }

    // Only prune below the lower of the two confirmed seqs
    const safeSeq = this.getSafeSeq()
    if (safeSeq === 0) {
      // Force compaction under critical disk pressure even without confirmed seqs
      if (pressure === "critical") {
        console.warn("[wal-prune] critical disk pressure, forcing compaction without confirmed seq")
      } else {
        return { segmentsPruned: 0, compactionRatio: 0, diskPressure: pressure }
      }
    }

    // Use upstream compaction (keeps latest write per path in closed segments)
    const result = await this.wal.compact()

    return {
      segmentsPruned: result.originalEntries - result.compactedEntries,
      compactionRatio: result.ratio,
      diskPressure: pressure,
    }
  }
}
