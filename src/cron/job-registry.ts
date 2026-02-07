// src/cron/job-registry.ts — Job registry persistence via AtomicJsonStore (SDD §5.2)

import { AtomicJsonStore } from "../cron/store.js"
import type { CronJob, CronJobRegistry, CronRunRecord } from "../cron/types.js"
import { appendFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"

export class JobRegistry {
  private store: AtomicJsonStore<CronJobRegistry>
  private data: CronJobRegistry
  private runsDir: string

  constructor(filePath: string, runsDir: string) {
    this.store = new AtomicJsonStore<CronJobRegistry>(filePath)
    this.runsDir = runsDir
    this.data = { version: 1, jobs: [], killSwitch: false, lastModified: Date.now() }
  }

  async init(): Promise<void> {
    const loaded = await this.store.read()
    if (loaded) this.data = loaded
  }

  // CRUD
  getJobs(): CronJob[] { return this.data.jobs }

  getJob(id: string): CronJob | undefined {
    return this.data.jobs.find(j => j.id === id)
  }

  async addJob(job: CronJob): Promise<void> {
    this.data.jobs.push(job)
    this.data.lastModified = Date.now()
    await this.store.write(this.data)
  }

  async updateJob(id: string, updates: Partial<CronJob>): Promise<boolean> {
    const idx = this.data.jobs.findIndex(j => j.id === id)
    if (idx === -1) return false
    this.data.jobs[idx] = { ...this.data.jobs[idx], ...updates, updatedAt: Date.now() }
    this.data.lastModified = Date.now()
    await this.store.write(this.data)
    return true
  }

  async deleteJob(id: string): Promise<boolean> {
    const len = this.data.jobs.length
    this.data.jobs = this.data.jobs.filter(j => j.id !== id)
    if (this.data.jobs.length === len) return false
    this.data.lastModified = Date.now()
    await this.store.write(this.data)
    return true
  }

  // CAS: Compare-and-swap on currentRunUlid
  async tryClaimRun(jobId: string, runUlid: string): Promise<boolean> {
    const job = this.getJob(jobId)
    if (!job) return false
    if (job.currentRunUlid) return false  // Already running
    return this.updateJob(jobId, { currentRunUlid: runUlid, status: "running" })
  }

  async releaseRun(jobId: string, runUlid: string): Promise<boolean> {
    const job = this.getJob(jobId)
    if (!job || job.currentRunUlid !== runUlid) return false
    return this.updateJob(jobId, { currentRunUlid: undefined })
  }

  // Kill switch
  isKillSwitchActive(): boolean { return this.data.killSwitch }

  async setKillSwitch(active: boolean): Promise<void> {
    this.data.killSwitch = active
    this.data.lastModified = Date.now()
    await this.store.write(this.data)
  }

  // Recovery: clear stuck runs older than maxAge
  async recoverStuckJobs(maxAgeMs: number = 2 * 60 * 60 * 1000): Promise<string[]> {
    const recovered: string[] = []
    const now = Date.now()
    for (const job of this.data.jobs) {
      if (job.currentRunUlid && job.lastRunAtMs && (now - job.lastRunAtMs) > maxAgeMs) {
        job.currentRunUlid = undefined
        job.status = "enabled"
        job.lastStatus = "timeout"
        recovered.push(job.id)
      }
    }
    if (recovered.length > 0) {
      this.data.lastModified = now
      await this.store.write(this.data)
    }
    return recovered
  }

  // Run log: append to JSONL
  async appendRunRecord(record: CronRunRecord): Promise<void> {
    const logPath = join(this.runsDir, `${record.jobId}.jsonl`)
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, JSON.stringify(record) + "\n", "utf-8")
  }
}
