// src/beads/bridge.ts — Interface to beads_rust CLI (SDD §3.5, T-4.7)

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const BR_TIMEOUT_MS = 30_000

export interface BeadUpdate {
  status?: "open" | "in_progress" | "closed"
  addLabels?: string[]
  removeLabels?: string[]
}

export interface Bead {
  id: string
  title: string
  status: string
  labels: string[]
}

export interface BeadsHealth {
  available: boolean
  version?: string
  status: "ok" | "unavailable" | "version_mismatch" | "timeout"
  counts: { open: number; inProgress: number; closed: number }
}

export class BeadsBridgeError extends Error {
  constructor(
    message: string,
    public exitCode: number,
  ) {
    super(message)
    this.name = "BeadsBridgeError"
  }
}

export class BeadsBridge {
  private available = false
  private version: string | undefined
  private healthStatus: BeadsHealth["status"] = "unavailable"

  /** Boot-time check: is br available and compatible? */
  async init(): Promise<void> {
    try {
      const { stdout } = await execFileAsync("br", ["--version"], { timeout: BR_TIMEOUT_MS })
      const match = stdout.trim().match(/(\d+\.\d+\.\d+)/)
      if (match) {
        this.version = match[1]
        // Require >=0.1.7
        const [major, minor, patch] = this.version.split(".").map(Number)
        if (major === 0 && minor === 1 && patch < 7) {
          console.warn(`[beads] br v${this.version} found, requires >=0.1.7`)
          this.healthStatus = "version_mismatch"
          return
        }
      }
      this.available = true
      this.healthStatus = "ok"
    } catch {
      console.log("[beads] br binary not found — beads features disabled")
      this.available = false
      this.healthStatus = "unavailable"
    }
  }

  get isAvailable(): boolean {
    return this.available
  }

  getHealth(): BeadsHealth {
    return {
      available: this.available,
      version: this.version,
      status: this.healthStatus,
      counts: { open: 0, inProgress: 0, closed: 0 },
    }
  }

  async createBead(title: string, labels: string[]): Promise<string | undefined> {
    if (!this.available) return undefined
    try {
      const args = ["create", title]
      if (labels.length > 0) {
        args.push("--labels", labels.join(","))
      }
      const { stdout } = await this.exec(args)
      // Parse bead ID from output
      const match = stdout.match(/bd-[a-z0-9]+/)
      return match?.[0]
    } catch (err) {
      console.error("[beads] create failed:", err)
      return undefined
    }
  }

  async updateBead(id: string, updates: BeadUpdate): Promise<void> {
    if (!this.available) return
    try {
      const args = ["update", id]
      if (updates.status) args.push("--status", updates.status)
      if (updates.addLabels) {
        for (const label of updates.addLabels) {
          args.push("--add-label", label)
        }
      }
      if (updates.removeLabels) {
        for (const label of updates.removeLabels) {
          args.push("--remove-label", label)
        }
      }
      await this.exec(args)
    } catch (err) {
      console.error("[beads] update failed:", err)
    }
  }

  async listBeads(filter?: { status?: string; label?: string }): Promise<Bead[]> {
    if (!this.available) return []
    try {
      const args = ["list", "--json"]
      if (filter?.status) args.push("--status", filter.status)
      if (filter?.label) args.push("--label", filter.label)
      const { stdout } = await this.exec(args)
      return JSON.parse(stdout)
    } catch {
      return []
    }
  }

  private async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync("br", args, {
        timeout: BR_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      })
    } catch (err: any) {
      if (err.code === "ETIMEDOUT") {
        this.healthStatus = "timeout"
      }
      throw new BeadsBridgeError(
        err.stderr || err.message,
        err.code === "ETIMEDOUT" ? -1 : (err.status ?? 1),
      )
    }
  }
}
