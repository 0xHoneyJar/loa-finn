// src/cron/kill-switch.ts — Kill switch: file + memory + registry (SDD §5.2, TASK-2.7)

import { stat, writeFile, unlink } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { JobRegistry } from "./job-registry.js"

export class KillSwitch {
  private memoryActive = false
  private stoppedJobs: string[] = []
  private readonly filePath: string
  private readonly registry: JobRegistry

  constructor(opts: { filePath?: string; registry: JobRegistry }) {
    this.filePath = opts.filePath ?? "data/.kill-switch"
    this.registry = opts.registry
  }

  /** Activate kill switch: file + memory + registry + stop running jobs */
  async activate(): Promise<string[]> {
    this.memoryActive = true

    // Write touch file
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `activated=${Date.now()}\n`, "utf-8")

    // Update registry
    await this.registry.setKillSwitch(true)

    // Stop all running jobs
    const stopped: string[] = []
    for (const job of this.registry.getJobs()) {
      if (job.status === "running") {
        const runUlid = job.currentRunUlid
        if (runUlid) {
          await this.registry.releaseRun(job.id, runUlid)
        }
        await this.registry.updateJob(job.id, { status: "disabled", enabled: false })
        stopped.push(job.id)
      }
    }

    this.stoppedJobs = stopped
    return stopped
  }

  /** Deactivate kill switch: remove file, clear memory, update registry */
  async deactivate(): Promise<void> {
    this.memoryActive = false

    // Remove touch file (ignore ENOENT)
    try {
      await unlink(this.filePath)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }

    // Update registry
    await this.registry.setKillSwitch(false)

    // Clear stopped jobs list
    this.stoppedJobs = []
  }

  /** Check if kill switch is active (memory OR file) */
  async isActive(): Promise<boolean> {
    // Fast path: memory flag
    if (this.memoryActive) return true

    // Slow path: check file existence (recovery case)
    try {
      await stat(this.filePath)
      // File exists but memory was false — sync memory (recovery)
      this.memoryActive = true
      return true
    } catch {
      return false
    }
  }

  /** Get list of job IDs stopped during last activation */
  getStoppedJobs(): string[] {
    return this.stoppedJobs
  }
}
