// src/bridgebuilder/lease.ts

import type { R2CheckpointStorage } from "../persistence/r2-storage.js"

const LEASE_KEY = "bridgebuilder/run-lock"

interface LeaseData {
  runId: string
  startedAt: string
  expiresAt: string
}

export class RunLease {
  constructor(
    private readonly r2: R2CheckpointStorage,
    private readonly ttlMinutes: number,
  ) {}

  /**
   * Attempt to acquire the run lease. Returns true if acquired.
   *
   * Uses read-after-write verification to detect races:
   * 1. Read existing lease — exit if active (not expired)
   * 2. Write our lease with unique runId
   * 3. Read back and verify our runId is present (R2 eventual consistency guard)
   * If the read-back shows a different runId, another run won the race — exit.
   */
  async acquire(runId: string): Promise<boolean> {
    // Step 1: Check for active (non-expired) lease
    const existing = await this.r2.readFile(LEASE_KEY)
    if (existing) {
      try {
        const lease = JSON.parse(existing.toString("utf-8")) as LeaseData
        if (new Date(lease.expiresAt) > new Date()) {
          console.log(`[bridgebuilder] Active lease held by ${lease.runId} — exiting`)
          return false
        }
        console.log(`[bridgebuilder] Expired lease from ${lease.runId} — overwriting`)
      } catch {
        // Corrupt lease — overwrite
      }
    }

    // Step 2: Write our lease
    const lease: LeaseData = {
      runId,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.ttlMinutes * 60_000).toISOString(),
    }
    const written = await this.r2.writeFile(LEASE_KEY, Buffer.from(JSON.stringify(lease), "utf-8"))
    if (!written) return false

    // Step 3: Read-after-write verification
    // Small delay to allow R2 propagation (S3 strong consistency, but belt-and-suspenders)
    await new Promise(r => setTimeout(r, 200))
    const readBack = await this.r2.readFile(LEASE_KEY)
    if (!readBack) return false

    try {
      const verified = JSON.parse(readBack.toString("utf-8")) as LeaseData
      if (verified.runId !== runId) {
        console.log(`[bridgebuilder] Lease race lost to ${verified.runId} — exiting`)
        return false
      }
    } catch {
      return false
    }

    return true
  }

  /** Release the lease. */
  async release(): Promise<void> {
    await this.r2.deleteFile(LEASE_KEY)
  }
}
