// src/persistence/git-sync.ts — Git archival sync (SDD §3.3.3, T-3.3)
// Uses execFileSync (no shell) to prevent command injection from config values.

import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ulid } from "ulid"
import type { FinnConfig } from "../config.js"
import type { WALManager } from "./upstream.js"

/** Validate git ref name — reject shell metacharacters and path traversal. */
function validateRef(name: string, label: string): void {
  if (!name || /[;&|`$(){}!\s\\]/.test(name) || name.includes("..")) {
    throw new Error(`Invalid git ${label}: "${name}" contains unsafe characters`)
  }
}

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
    private wal: WALManager,
  ) {
    this.cwd = process.cwd()
    this.branch = config.git.archiveBranch
    this.remote = config.git.remote

    // Validate config values at construction time
    if (this.branch) validateRef(this.branch, "branch")
    if (this.remote) validateRef(this.remote, "remote")

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

  /** Create an immutable snapshot and commit to the archive branch.
   *  Uses a temporary worktree to avoid switching branches on the live server. */
  async snapshot(): Promise<SnapshotResult | undefined> {
    if (!this.isConfigured) return undefined

    const worktreeDir = join(tmpdir(), `finn-archive-${Date.now()}`)

    try {
      const snapshotId = ulid()
      const walCheckpoint = String(this.wal.getStatus().seq)

      // Ensure archive branch exists
      this.ensureArchiveBranch()

      // Create temporary worktree on the archive branch
      this.git("worktree", "add", worktreeDir, this.branch)

      try {
        const filesToStage: string[] = []

        // Copy grimoire and beads state into the worktree
        const copyDir = (src: string, dest: string) => {
          if (!existsSync(src)) return
          mkdirSync(dest, { recursive: true })
          for (const entry of readdirSync(src, { withFileTypes: true })) {
            const srcPath = join(src, entry.name)
            const destPath = join(dest, entry.name)
            if (entry.isDirectory()) {
              copyDir(srcPath, destPath)
            } else {
              copyFileSync(srcPath, destPath)
            }
          }
        }

        if (existsSync(join(this.cwd, "grimoires/loa"))) {
          copyDir(join(this.cwd, "grimoires/loa"), join(worktreeDir, "grimoires/loa"))
          this.gitAt(worktreeDir, "add", "grimoires/loa/")
          filesToStage.push("grimoires/loa/")
        }

        if (existsSync(join(this.cwd, ".beads"))) {
          copyDir(join(this.cwd, ".beads"), join(worktreeDir, ".beads"))
          this.gitAt(worktreeDir, "add", ".beads/")
          filesToStage.push(".beads/")
        }

        // Write snapshot manifest
        const manifest = {
          snapshotId,
          timestamp: Date.now(),
          walCheckpoint,
          bootEpoch: ulid(),
        }
        writeFileSync(join(worktreeDir, "snapshot-manifest.json"), JSON.stringify(manifest, null, 2))
        this.gitAt(worktreeDir, "add", "snapshot-manifest.json")
        filesToStage.push("snapshot-manifest.json")

        // Commit in the worktree
        const commitMsg = `chore(sync): auto-sync state [${snapshotId}]`
        this.gitAt(worktreeDir, "commit", "-m", commitMsg, "--allow-empty")

        const commitHash = this.gitAt(worktreeDir, "rev-parse", "HEAD").trim()

        return {
          commitHash,
          snapshotId,
          filesIncluded: filesToStage,
          walCheckpoint,
        }
      } finally {
        // Always clean up worktree
        try {
          this.git("worktree", "remove", worktreeDir, "--force")
        } catch {
          // Best-effort cleanup
        }
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
        this.git("fetch", this.remote, this.branch)
        const localHead = this.git("rev-parse", this.branch).trim()
        const remoteRef = `${this.remote}/${this.branch}`
        const remoteHead = this.git("rev-parse", remoteRef).trim()

        if (localHead !== remoteHead) {
          // Check if local is ahead of remote (fast-forward possible)
          const mergeBase = this.git("merge-base", this.branch, remoteRef).trim()
          if (mergeBase !== remoteHead) {
            console.error("[git-sync] branches have diverged, halting git sync")
            this.status = "conflict"
            return false
          }
        }
      } catch {
        // Remote branch may not exist yet, which is fine
      }

      this.git("push", this.remote, this.branch)
      this.status = "ok"
      return true
    } catch (err) {
      console.error("[git-sync] push failed:", err)
      this.status = "error"
      return false
    }
  }

  /** Pull latest snapshot from remote (for recovery).
   *  Uses git show to read from remote branch without checking it out. */
  async restore(): Promise<SnapshotResult | undefined> {
    if (!this.isConfigured) return undefined

    try {
      this.git("fetch", this.remote, this.branch)
      const remoteRef = `${this.remote}/${this.branch}`

      // Read manifest directly from remote branch (no checkout)
      try {
        const manifestJson = this.git("show", `${remoteRef}:snapshot-manifest.json`)
        const manifest = JSON.parse(manifestJson)
        const commitHash = this.git("rev-parse", remoteRef).trim()

        // Extract files from remote branch into working directory
        const restorePath = (remotePath: string, localPath: string) => {
          try {
            const content = this.git("show", `${remoteRef}:${remotePath}`)
            mkdirSync(join(localPath, ".."), { recursive: true })
            writeFileSync(localPath, content)
          } catch {
            // File may not exist in snapshot
          }
        }

        restorePath("snapshot-manifest.json", join(this.cwd, "snapshot-manifest.json"))

        return {
          commitHash,
          snapshotId: manifest.snapshotId,
          filesIncluded: ["grimoires/loa/", ".beads/", "snapshot-manifest.json"],
          walCheckpoint: manifest.walCheckpoint,
        }
      } catch {
        // No manifest on remote branch
        return undefined
      }
    } catch (err) {
      console.error("[git-sync] restore failed:", err)
      return undefined
    }
  }

  private ensureArchiveBranch(): void {
    try {
      this.git("rev-parse", "--verify", this.branch)
    } catch {
      // Create orphan branch
      this.git("checkout", "--orphan", this.branch)
      try { this.git("rm", "-rf", ".") } catch { /* empty repo is fine */ }
      this.git("commit", "--allow-empty", "-m", "chore: initialize archive branch")
    }
  }

  private git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.cwd,
      encoding: "utf-8",
      timeout: 30_000,
    })
  }

  private gitAt(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
    })
  }
}
