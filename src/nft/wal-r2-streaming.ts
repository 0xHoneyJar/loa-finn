// src/nft/wal-r2-streaming.ts — WAL-to-R2 Segment Streaming (T1.10)
// Ships immutable WAL segments to R2 for disaster recovery.
// Uses an injectable R2 client interface so tests run without cloud credentials.

import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Injectable R2 client interface — mockable for tests, real client wired in Sprint 3 */
export interface IR2WalClient {
  /** PUT a segment object. Returns true on success. */
  putSegment(key: string, data: Buffer, contentSha256: string): Promise<boolean>
  /** HEAD check — verify segment exists with matching checksum. */
  headSegment(key: string, expectedSha256: string): Promise<boolean>
  /** Read the manifest JSON. */
  getManifest(key: string): Promise<WalManifest | null>
  /** Write the manifest JSON. */
  putManifest(key: string, manifest: WalManifest): Promise<boolean>
}

export interface WalManifest {
  nft_id: string
  segments: Array<{
    key: string
    start_offset: number
    end_offset: number
    sha256: string
    created_at: number
  }>
  last_committed_offset: number
  updated_at: number
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WalR2StreamerConfig {
  nftId: string
  r2Client: IR2WalClient
  /** Records to buffer before flushing. Default: 10 */
  flushRecordThreshold?: number
  /** Seconds before auto-flush. Default: 60 */
  flushIntervalSeconds?: number
}

// ---------------------------------------------------------------------------
// WalR2Streamer
// ---------------------------------------------------------------------------

export class WalR2Streamer {
  private buffer: Buffer[] = []
  private bufferRecordCount = 0
  private currentOffset = 0
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushing = false

  constructor(private config: WalR2StreamerConfig) {}

  /** The record threshold that triggers an automatic flush. */
  get flushRecordThreshold(): number {
    return this.config.flushRecordThreshold ?? 10
  }

  /** Current number of buffered records. */
  get pendingRecordCount(): number {
    return this.bufferRecordCount
  }

  /** Current offset (next expected record offset). */
  get offset(): number {
    return this.currentOffset
  }

  /**
   * Call after each local WAL fsync to buffer the record for R2 upload.
   * When the buffer reaches flushRecordThreshold, flush is triggered automatically.
   */
  addRecord(recordBytes: Buffer, offset: number): void {
    this.buffer.push(recordBytes)
    this.bufferRecordCount += 1
    this.currentOffset = offset + 1 // Next expected offset

    // Auto-flush when buffer reaches threshold
    if (this.bufferRecordCount >= this.flushRecordThreshold) {
      // Fire-and-forget — errors are swallowed (best-effort).
      // Callers who need guarantees should call flush() directly.
      this.flush().catch(() => {})
    }
  }

  /**
   * Flush buffered records to R2 as an immutable segment.
   * Returns true on success, false on failure.
   * On failure the buffer is kept intact for retry on next flush.
   */
  async flush(): Promise<boolean> {
    if (this.bufferRecordCount === 0) return true
    if (this.flushing) return false // Prevent concurrent flushes

    this.flushing = true
    try {
      return await this.flushInternal()
    } finally {
      this.flushing = false
    }
  }

  /** Start auto-flush timer. */
  start(): void {
    const interval = (this.config.flushIntervalSeconds ?? 60) * 1000
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {})
    }, interval)
  }

  /** Stop auto-flush and flush remaining records. */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    if (this.bufferRecordCount > 0) {
      await this.flush()
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async flushInternal(): Promise<boolean> {
    const { nftId, r2Client } = this.config

    // 1. Snapshot the current buffer so addRecord() can continue during upload
    const records = this.buffer.slice()
    const recordCount = this.bufferRecordCount
    const startOffset = this.currentOffset - recordCount
    const endOffset = this.currentOffset - 1

    // 2. Concatenate buffer into a single segment blob
    const segment = Buffer.concat(records)

    // 3. Compute SHA-256 of the segment
    const sha256 = createHash("sha256").update(segment).digest("hex")

    // 4. Build the immutable segment key
    const segmentKey = `wal-segments/${nftId}/${startOffset}-${endOffset}.bin`

    // 5. PUT segment as immutable object
    const putOk = await r2Client.putSegment(segmentKey, segment, sha256)
    if (!putOk) {
      return false // Keep buffer intact for retry
    }

    // 6. HEAD verify after upload
    const headOk = await r2Client.headSegment(segmentKey, sha256)
    if (!headOk) {
      return false // Keep buffer intact for retry
    }

    // 7. Update manifest (read-modify-write) — ONLY after verified PUT
    const manifestKey = `wal-segments/${nftId}/manifest.json`
    let manifest = await r2Client.getManifest(manifestKey)

    if (!manifest) {
      manifest = {
        nft_id: nftId,
        segments: [],
        last_committed_offset: -1,
        updated_at: Date.now(),
      }
    }

    manifest.segments.push({
      key: segmentKey,
      start_offset: startOffset,
      end_offset: endOffset,
      sha256,
      created_at: Date.now(),
    })
    manifest.last_committed_offset = endOffset
    manifest.updated_at = Date.now()

    const manifestOk = await r2Client.putManifest(manifestKey, manifest)
    if (!manifestOk) {
      // Segment is uploaded but manifest failed — next flush will re-read
      // and the segment is idempotent (immutable), so this is safe.
      return false
    }

    // 8. Clear buffer on success
    // Remove only the records we flushed (addRecord may have added more during upload)
    this.buffer.splice(0, recordCount)
    this.bufferRecordCount -= recordCount

    return true
  }
}
