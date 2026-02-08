// src/bridgebuilder/lease.ts

const LEASE_KEY = "bridgebuilder/run-lock"

interface LeaseData {
  runId: string
  startedAt: string
  expiresAt: string
}

/** Minimal storage interface for lease operations — enables in-memory testing. */
export interface ILeaseStorage {
  readFile(key: string): Promise<Buffer | null>
  writeFile(key: string, content: Buffer): Promise<boolean>
  deleteFile(key: string): Promise<boolean>
}

export interface LeaseRejection {
  held: true
  heldBy: string
}

export class RunLease {
  constructor(
    private readonly storage: ILeaseStorage,
    private readonly ttlMinutes: number,
    private readonly delayMs = 200,
  ) {}

  /**
   * Attempt to acquire the run lease. Returns true if acquired,
   * or a LeaseRejection with the holder's runId if held.
   *
   * Uses read-after-write verification to detect races:
   * 1. Read existing lease — exit if active (not expired)
   * 2. Write our lease with unique runId
   * 3. Read back and verify our runId is present (R2 eventual consistency guard)
   * If the read-back shows a different runId, another run won the race — exit.
   */
  async acquire(runId: string): Promise<boolean | LeaseRejection> {
    // Step 1: Check for active (non-expired) lease
    const existing = await this.storage.readFile(LEASE_KEY)
    if (existing) {
      try {
        const lease = JSON.parse(existing.toString("utf-8")) as LeaseData
        if (new Date(lease.expiresAt) > new Date()) {
          return { held: true, heldBy: lease.runId }
        }
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
    const written = await this.storage.writeFile(LEASE_KEY, Buffer.from(JSON.stringify(lease), "utf-8"))
    if (!written) return false

    // Step 3: Read-after-write verification
    if (this.delayMs > 0) {
      await new Promise(r => setTimeout(r, this.delayMs))
    }
    const readBack = await this.storage.readFile(LEASE_KEY)
    if (!readBack) return false

    try {
      const verified = JSON.parse(readBack.toString("utf-8")) as LeaseData
      if (verified.runId !== runId) {
        return { held: true, heldBy: verified.runId }
      }
    } catch {
      return false
    }

    return true
  }

  /**
   * Release the lease. Only deletes if we still hold it (prevents split-brain).
   * TOCTOU: R2 doesn't support conditional delete (DeleteObject with If-Match).
   * Acceptable risk — worst case is deleting a lease that was concurrently
   * re-acquired, causing one extra concurrent run.
   */
  async release(runId: string): Promise<void> {
    const existing = await this.storage.readFile(LEASE_KEY)
    if (!existing) return

    try {
      const lease = JSON.parse(existing.toString("utf-8")) as LeaseData
      if (lease.runId !== runId) return
    } catch {
      return
    }

    await this.storage.deleteFile(LEASE_KEY)
  }
}
