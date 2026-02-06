// src/persistence/git-sync.ts — Git archival sync (SDD §3.3.3, T-3.3)

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ulid } from "ulid"
import type { FinnConfig } from "../config.js"
import type { WAL } from "./wal.js"

export interface SnapshotResult {
  commitHash: string
  snapshotId: string
  filesIncluded: string[]
  walCheckpoint: string
}

export type GitSyncStatus = "ok" | "conflict" | "error" | "unconfigured"

export class GitSync {
  private cwd: string
  private branch: string
  private remote: string
  private status: GitSyncStatus = "unconfigured"

  constructor(
    private config: FinnConfig,
    private wal: WAL,
  ) {
    this.cwd = process.cwd()
    this.branch = config.git.archiveBranch
    this.remote = config.git.remote
    if (config.git.token) {
      this.status = "ok"
    }
  }

  get isConfigured(): boolean {
    return this.status !== "unconfigured"
  }

  get currentStatus(): GitSyncStatus {
    return this.status
  }

  /** Create an immutable snapshot and commit to the archive branch. */
  async snapshot(): Promise<SnapshotResult | undefined> {
    if (!this.isConfigured) return undefined

    try {
      const snapshotId = ulid()
      const walCheckpoint = (await this.wal.getHeadEntryId()) ?? ""

      // Ensure archive branch exists
      this.ensureArchiveBranch()

      // Save current branch to restore later
      const currentBranch = this.git("rev-parse --abbrev-ref HEAD").trim()

      // Switch to archive branch
      this.git(`checkout ${this.branch}`)

      try {
        // Stage grimoire and beads state
        const filesToStage: string[] = []

        if (existsSync(join(this.cwd, "grimoires/loa"))) {
          this.git("add grimoires/loa/")
          filesToStage.push("grimoires/loa/")
        }

        if (existsSync(join(this.cwd, ".beads"))) {
          this.git("add .beads/")
          filesToStage.push(".beads/")
        }

        // Write snapshot manifest
        const manifest = {
          snapshotId,
          timestamp: Date.now(),
          walCheckpoint,
          bootEpoch: ulid(),
        }
        const manifestPath = "snapshot-manifest.json"
        writeFileSync(join(this.cwd, manifestPath), JSON.stringify(manifest, null, 2))
        this.git(`add ${manifestPath}`)
        filesToStage.push(manifestPath)

        // Commit
        const commitMsg = `chore(sync): auto-sync state [${snapshotId}]`
        this.git(`commit -m "${commitMsg}" --allow-empty`)

        const commitHash = this.git("rev-parse HEAD").trim()

        return {
          commitHash,
          snapshotId,
          filesIncluded: filesToStage,
          walCheckpoint,
        }
      } finally {
        // Always restore original branch
        this.git(`checkout ${currentBranch}`)
      }
    } catch (err) {
      console.error("[git-sync] snapshot failed:", err)
      this.status = "error"
      return undefined
    }
  }

  /** Push archive branch to remote. Fast-forward only. */
  async push(): Promise<boolean> {
    if (!this.isConfigured) return false

    try {
      // Check for divergence
      try {
        this.git(`fetch ${this.remote} ${this.branch}`)
        const localHead = this.git(`rev-parse ${this.branch}`).trim()
        const remoteHead = this.git(`rev-parse ${this.remote}/${this.branch}`).trim()

        if (localHead !== remoteHead) {
          // Check if local is ahead of remote (fast-forward possible)
          const mergeBase = this.git(`merge-base ${this.branch} ${this.remote}/${this.branch}`).trim()
          if (mergeBase !== remoteHead) {
            console.error("[git-sync] branches have diverged, halting git sync")
            this.status = "conflict"
            return false
          }
        }
      } catch {
        // Remote branch may not exist yet, which is fine
      }

      this.git(`push ${this.remote} ${this.branch}`)
      this.status = "ok"
      return true
    } catch (err) {
      console.error("[git-sync] push failed:", err)
      this.status = "error"
      return false
    }
  }

  /** Pull latest snapshot from remote (for recovery). */
  async restore(): Promise<SnapshotResult | undefined> {
    if (!this.isConfigured) return undefined

    try {
      this.git(`fetch ${this.remote} ${this.branch}`)

      const currentBranch = this.git("rev-parse --abbrev-ref HEAD").trim()
      this.git(`checkout ${this.remote}/${this.branch}`)

      try {
        // Read manifest if it exists
        const manifestPath = join(this.cwd, "snapshot-manifest.json")
        if (existsSync(manifestPath)) {
          const { readFileSync } = await import("node:fs")
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
          const commitHash = this.git("rev-parse HEAD").trim()

          return {
            commitHash,
            snapshotId: manifest.snapshotId,
            filesIncluded: ["grimoires/loa/", ".beads/", "snapshot-manifest.json"],
            walCheckpoint: manifest.walCheckpoint,
          }
        }
      } finally {
        this.git(`checkout ${currentBranch}`)
      }

      return undefined
    } catch (err) {
      console.error("[git-sync] restore failed:", err)
      return undefined
    }
  }

  private ensureArchiveBranch(): void {
    try {
      this.git(`rev-parse --verify ${this.branch}`)
    } catch {
      // Create orphan branch
      this.git(`checkout --orphan ${this.branch}`)
      this.git("rm -rf . 2>/dev/null || true")
      this.git(`commit --allow-empty -m "chore: initialize archive branch"`)
    }
  }

  private git(args: string): string {
    return execSync(`git ${args}`, {
      cwd: this.cwd,
      encoding: "utf-8",
      timeout: 30_000,
    })
  }
}
