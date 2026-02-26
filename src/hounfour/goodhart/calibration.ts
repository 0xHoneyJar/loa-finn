// src/hounfour/goodhart/calibration.ts — HITL Calibration Engine (SDD §4.1.3, cycle-034)
//
// S3-polled calibration entries with HMAC integrity verification.
// Blending formula: weighted average of decayed EMA and human calibration scores.

import type { PoolId } from "@0xhoneyjar/loa-hounfour"
import type { NFTRoutingKey } from "../nft-routing-config.js"

// --- Types ---

export interface CalibrationConfig {
  /** S3 bucket for calibration data */
  s3Bucket: string
  /** S3 key (default: "finn/calibration.jsonl") */
  s3Key: string
  /** Poll interval in ms (default: 60000) */
  pollIntervalMs: number
  /** Local fallback path when S3 unavailable */
  localFallbackPath?: string
  /** Blending weight for calibration scores (default: 3.0) */
  calibrationWeight: number
  /** HMAC-SHA256 secret for integrity verification */
  hmacSecret: string
}

export interface CalibrationEntry {
  nftId: string
  poolId: PoolId
  routingKey: NFTRoutingKey
  /** Score in [0, 1] */
  score: number
  evaluator: "human"
  /** ISO 8601 timestamp */
  timestamp: string
  note?: string
}

/** S3 client interface — injected to avoid hard AWS SDK dependency */
export interface S3Reader {
  getObject(bucket: string, key: string, ifNoneMatch?: string): Promise<{
    status: 200 | 304
    body?: string
    etag?: string
  }>
}

// --- Engine ---

export class CalibrationEngine {
  private entries: Map<string, CalibrationEntry[]> = new Map()
  private lastETag: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private readonly config: CalibrationConfig
  private s3Reader: S3Reader | null = null

  constructor(config: CalibrationConfig, s3Reader?: S3Reader) {
    this.config = config
    this.s3Reader = s3Reader ?? null
  }

  /** Set the S3 reader (for deferred injection) */
  setS3Reader(reader: S3Reader): void {
    this.s3Reader = reader
  }

  /** Start periodic S3 polling */
  startPolling(): void {
    if (this.pollTimer) return
    // Initial fetch
    void this.fetchFromS3()
    this.pollTimer = setInterval(() => void this.fetchFromS3(), this.config.pollIntervalMs)
    // T-7.7: Unref so polling doesn't prevent Node.js from exiting cleanly
    if (typeof this.pollTimer === "object" && "unref" in this.pollTimer) {
      this.pollTimer.unref()
    }
  }

  /** Stop periodic polling */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** Load entries from local JSONL file (fallback when S3 unavailable) */
  loadFromLocal(content: string): void {
    const parsed = this.parseJSONL(content)
    if (parsed) {
      this.rebuildLookup(parsed)
    }
  }

  /** Get calibration entries for a specific key */
  getCalibration(nftId: string, poolId: PoolId, routingKey: NFTRoutingKey): CalibrationEntry[] {
    const key = `${nftId}:${poolId}:${routingKey}`
    return this.entries.get(key) ?? []
  }

  /**
   * Blend decayed EMA with calibration scores (SDD §4.1.3 blending formula).
   *
   * finalScore = (decayedEma * sampleCount + calibrationScore * calibrationWeight * calibrationCount)
   *              / (sampleCount + calibrationWeight * calibrationCount)
   *
   * When no calibration entries exist, returns decayedEma unchanged.
   */
  blendWithDecay(decayedEma: number, sampleCount: number, calibrationEntries: CalibrationEntry[]): number {
    if (calibrationEntries.length === 0) return decayedEma

    const calibrationScore = calibrationEntries.reduce((sum, e) => sum + e.score, 0) / calibrationEntries.length
    const calibrationCount = calibrationEntries.length
    const w = this.config.calibrationWeight

    const numerator = decayedEma * sampleCount + calibrationScore * w * calibrationCount
    const denominator = sampleCount + w * calibrationCount

    if (denominator === 0) return decayedEma
    return numerator / denominator
  }

  /** Fetch from S3 with ETag-based conditional get and HMAC verification */
  private async fetchFromS3(): Promise<void> {
    if (!this.s3Reader) return

    try {
      const response = await this.s3Reader.getObject(
        this.config.s3Bucket,
        this.config.s3Key,
        this.lastETag ?? undefined,
      )

      if (response.status === 304) return // Not modified

      if (!response.body) return

      // HMAC integrity check
      if (!await this.verifyHMAC(response.body)) {
        console.error(JSON.stringify({
          component: "calibration",
          event: "hmac_verification_failed",
          severity: "alarm",
          timestamp: new Date().toISOString(),
        }))
        return // Retain existing entries, do NOT apply tainted data
      }

      const parsed = this.parseJSONL(this.stripHMACLine(response.body))
      if (parsed) {
        this.rebuildLookup(parsed)
        this.lastETag = response.etag ?? null
      }
    } catch (err) {
      // S3 error — retain existing entries
      console.warn(`[calibration] S3 fetch failed, retaining stale entries: ${err}`)
    }
  }

  /** Verify HMAC-SHA256 of content (last line is {"hmac":"<hex>"}) */
  private async verifyHMAC(body: string): Promise<boolean> {
    const lines = body.trimEnd().split("\n")
    if (lines.length < 2) return false

    const hmacLine = lines[lines.length - 1]
    let expectedHmac: string
    try {
      const parsed = JSON.parse(hmacLine) as { hmac?: string }
      if (!parsed.hmac) return false
      expectedHmac = parsed.hmac
    } catch {
      return false
    }

    const contentBeforeHmac = lines.slice(0, -1).join("\n")

    // Use Node.js crypto for HMAC-SHA256 with timing-safe comparison
    const { createHmac, timingSafeEqual } = await import("node:crypto")
    const computed = createHmac("sha256", this.config.hmacSecret)
      .update(contentBeforeHmac)
      .digest("hex")

    // Reject non-hex or mismatched lengths before timing-safe compare
    if (!/^[0-9a-fA-F]+$/.test(expectedHmac) || expectedHmac.length !== computed.length) {
      return false
    }

    const computedBuf = Buffer.from(computed, "hex")
    const expectedBuf = Buffer.from(expectedHmac, "hex")
    if (computedBuf.length !== expectedBuf.length) return false

    return timingSafeEqual(computedBuf, expectedBuf)
  }

  /** Strip the HMAC line from body before parsing entries */
  private stripHMACLine(body: string): string {
    const lines = body.trimEnd().split("\n")
    return lines.slice(0, -1).join("\n")
  }

  /** Parse JSONL content into calibration entries */
  private parseJSONL(content: string): CalibrationEntry[] | null {
    try {
      const entries: CalibrationEntry[] = []
      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const entry = JSON.parse(trimmed) as CalibrationEntry
        if (this.validateEntry(entry)) {
          entries.push(entry)
        }
      }
      return entries
    } catch {
      console.warn("[calibration] Failed to parse JSONL content")
      return null
    }
  }

  /** Validate a single calibration entry */
  private validateEntry(entry: CalibrationEntry): boolean {
    return (
      typeof entry.nftId === "string" &&
      typeof entry.poolId === "string" &&
      typeof entry.routingKey === "string" &&
      typeof entry.score === "number" &&
      entry.score >= 0 && entry.score <= 1 &&
      entry.evaluator === "human" &&
      typeof entry.timestamp === "string"
    )
  }

  /** Rebuild the lookup map from a list of entries */
  private rebuildLookup(entries: CalibrationEntry[]): void {
    const newMap = new Map<string, CalibrationEntry[]>()
    for (const entry of entries) {
      const key = `${entry.nftId}:${entry.poolId}:${entry.routingKey}`
      const existing = newMap.get(key) ?? []
      existing.push(entry)
      newMap.set(key, existing)
    }
    this.entries = newMap
  }
}
