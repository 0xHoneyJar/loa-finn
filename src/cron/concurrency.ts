// src/cron/concurrency.ts — File-based concurrency control with O_EXCL atomic locks (SDD §4.1)
//
// Provides job-level mutual exclusion using lock files created with O_EXCL.
// Each lock records ownership (ULID, PID, boot ID, timestamp) and supports
// stale lock detection via boot ID mismatch or age threshold.

import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { AlertService } from "../safety/alert-service.js"

// ── Types ────────────────────────────────────────────────────

/** Lock ownership record persisted in the lock file. (SDD §4.1) */
export interface LockOwnership {
  ulid: string
  pid: number
  bootId: string
  startedAtMs: number
}

/** Options for ConcurrencyManager construction. */
export interface ConcurrencyManagerOptions {
  /** Base directory for job data. Default: "data/jobs" */
  baseDir?: string
  /** Maximum lock age in ms before considered stale. Default: 1 hour. */
  maxAgeMs?: number
  /** Optional AlertService for stale lock notifications. */
  alertService?: AlertService
  /** Injectable clock for testing. Default: Date.now */
  now?: () => number
}

// ── Constants ────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000 // 1 hour
const LOCK_FILENAME = ".lock"

// ── ConcurrencyManager ──────────────────────────────────────

/**
 * File-based concurrency control using O_EXCL atomic lock creation. (SDD §4.1)
 *
 * Each job gets a lock file at `{baseDir}/{jobId}/.lock` containing a JSON
 * ownership record. The O_EXCL flag ensures only one process can create the
 * lock file — concurrent attempts receive EEXIST.
 */
export class ConcurrencyManager {
  private readonly baseDir: string
  private readonly maxAgeMs: number
  private readonly alertService?: AlertService
  private readonly bootId: string
  private readonly now: () => number

  constructor(options?: ConcurrencyManagerOptions) {
    this.baseDir = options?.baseDir ?? "data/jobs"
    this.maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.alertService = options?.alertService
    this.bootId = randomUUID()
    this.now = options?.now ?? Date.now
  }

  /** The boot ID generated for this manager instance. */
  getBootId(): string {
    return this.bootId
  }

  /**
   * Acquire a lock for the given job. (SDD §4.1)
   *
   * Creates `{baseDir}/{jobId}/.lock` with O_EXCL (wx flag). If the file
   * already exists, the acquire fails and returns null. On success, returns
   * the LockOwnership record written to the file.
   */
  async acquire(jobId: string): Promise<LockOwnership | null> {
    const lockPath = this.lockPath(jobId)
    const jobDir = join(this.baseDir, jobId)

    // Ensure the job directory exists
    await mkdir(jobDir, { recursive: true })

    const ownership: LockOwnership = {
      ulid: randomUUID(),
      pid: process.pid,
      bootId: this.bootId,
      startedAtMs: this.now(),
    }

    const json = JSON.stringify(ownership, null, 2) + "\n"

    let fh
    try {
      // O_WRONLY | O_CREAT | O_EXCL — fails with EEXIST if file exists
      fh = await open(lockPath, "wx")
      await fh.writeFile(json, "utf-8")
      await fh.sync()
      return ownership
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        return null // Lock already held
      }
      throw err // Unexpected I/O error — propagate
    } finally {
      await fh?.close()
    }
  }

  /**
   * Release a lock for the given job. (SDD §4.1)
   *
   * Validates that the current process owns the lock (matching bootId + pid)
   * before unlinking. Returns true if the lock was released, false if
   * ownership validation fails or the lock does not exist.
   */
  async release(jobId: string): Promise<boolean> {
    const lockPath = this.lockPath(jobId)

    const current = await this.readLock(jobId)
    if (!current) return false

    // Ownership check: must match both bootId and pid
    if (current.bootId !== this.bootId || current.pid !== process.pid) {
      return false
    }

    // TOCTOU mitigation: re-read lock immediately before unlink to minimize
    // the race window where another process could break+acquire between our
    // first read and the unlink.
    const recheck = await this.readLock(jobId)
    if (!recheck) return false // Lock disappeared between reads
    if (recheck.bootId !== this.bootId || recheck.pid !== process.pid) {
      return false // Lock was broken and re-acquired by another process
    }

    try {
      await unlink(lockPath)
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return false // Already gone
      }
      throw err
    }
  }

  /**
   * Check whether a lock is stale. (SDD §4.1)
   *
   * A lock is stale if:
   * - The bootId differs from this manager's bootId (different process lifecycle), OR
   * - The lock age exceeds maxAgeMs
   *
   * Does NOT check PID running state — uses bootId + age heuristic for portability.
   */
  isStale(lock: LockOwnership): boolean {
    // Different boot ID means a previous process lifecycle
    if (lock.bootId !== this.bootId) return true

    // Age check: lock held longer than max allowed
    const age = this.now() - lock.startedAtMs
    if (age > this.maxAgeMs) return true

    return false
  }

  /**
   * Break a stale lock by unlinking it. (SDD §4.1)
   *
   * Fires an alert via AlertService (if configured) before removing the lock.
   */
  async breakStaleLock(jobId: string): Promise<void> {
    const lockPath = this.lockPath(jobId)
    const lock = await this.readLock(jobId)

    // Fire alert before breaking
    if (this.alertService && lock) {
      await this.alertService.fire("warning", "stale_lock_broken", {
        jobId,
        message: `Breaking stale lock for job ${jobId}`,
        details: {
          lockBootId: lock.bootId,
          currentBootId: this.bootId,
          lockPid: lock.pid,
          lockAge: this.now() - lock.startedAtMs,
        },
      })
    }

    try {
      await unlink(lockPath)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err
      }
    }
  }

  /**
   * Startup scan: find and break all stale locks. (SDD §4.1)
   *
   * Scans baseDir for .lock files, checks each for staleness,
   * and breaks any that are stale. Returns the list of job IDs whose
   * locks were broken.
   */
  async recoverStaleLocks(): Promise<string[]> {
    const brokenJobs: string[] = []

    let entries: string[]
    try {
      entries = await readdir(this.baseDir)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return [] // No jobs directory yet
      }
      throw err
    }

    for (const entry of entries) {
      const jobDir = join(this.baseDir, entry)

      // Skip non-directories
      try {
        const s = await stat(jobDir)
        if (!s.isDirectory()) continue
      } catch {
        continue
      }

      const lock = await this.readLock(entry)
      if (!lock) continue

      if (this.isStale(lock)) {
        await this.breakStaleLock(entry)
        brokenJobs.push(entry)
      }
    }

    return brokenJobs
  }

  /**
   * Read the lock file for a job. Returns null if the lock does not exist
   * or is unreadable/unparseable.
   */
  async readLock(jobId: string): Promise<LockOwnership | null> {
    const lockPath = this.lockPath(jobId)
    try {
      const raw = await readFile(lockPath, "utf-8")
      return JSON.parse(raw) as LockOwnership
    } catch {
      return null
    }
  }

  /** Compute the lock file path for a job. */
  private lockPath(jobId: string): string {
    return join(this.baseDir, jobId, LOCK_FILENAME)
  }
}
