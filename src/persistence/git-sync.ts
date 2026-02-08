// src/persistence/git-sync.ts — Git archival sync (SDD §3.3.3, T-3.3 + §3.4 Cycle 005)
// Async git execution via WorkerPool system lane (non-blocking).
// Falls back to execFileSync only if no pool provided (legacy compat).

import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { ulid } from "ulid"
import type { FinnConfig } from "../config.js"
import type { WALManager } from "./upstream.js"
import type { WorkerPool, ExecSpec } from "../agent/worker-pool.js"

/** Validate a git branch name — reject option injection, path traversal, and shell metacharacters. */
function validateBranch(name: string): void {
  if (!name || name.startsWith("-") || name.includes("\0") || name.includes("..") ||
      /[;&|`$(){}!\s\\]/.test(name)) {
    throw new Error(`Invalid git branch: "${name}"`)
  }
}

/** Validate a git remote name — not a ref, just a simple identifier. */
function validateRemote(name: string): void {
  if (!name || name.startsWith("-") || name.includes("\0") || name.includes("..") ||
      /[\s;&|`$(){}!\\\/]/.test(name)) {
    throw new Error(`Invalid git remote: "${name}"`)
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
  private pool: WorkerPool | undefined
  private gitBinaryPath: string

  constructor(
    private config: FinnConfig,
    private wal: WALManager,
    pool?: WorkerPool,
  ) {
    this.cwd = process.cwd()
    this.branch = config.git.archiveBranch
    this.remote = config.git.remote
    this.pool = pool

    // Validate config values at construction time
    if (this.branch) validateBranch(this.branch)
    if (this.remote) validateRemote(this.remote)

    // Resolve git binary path once at construction (SD-006)
    this.gitBinaryPath = this.resolveGitBinary()

    if (config.git.token) {
      this.status = "ok"
    }
  }

  /** Resolve git binary to absolute path via which + realpath. */
  private resolveGitBinary(): string {
    try {
      const raw = execFileSync("which", ["git"], {
        encoding: "utf-8",
        timeout: 5_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/usr/local/bin" },
      }).trim()
      return realpathSync(raw)
    } catch {
      // Fallback to bare "git" — will fail at exec time with a clear error
      return "git"
    }
  }

  /** Attach a WorkerPool after construction (for deferred initialization). */
  setPool(pool: WorkerPool): void {
    this.pool = pool
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
      await this.ensureArchiveBranch()

      // Create temporary worktree on the archive branch
      await this.git("worktree", "add", worktreeDir, this.branch)

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
          await this.gitAt(worktreeDir, "add", "grimoires/loa/")
          filesToStage.push("grimoires/loa/")
        }

        if (existsSync(join(this.cwd, ".beads"))) {
          copyDir(join(this.cwd, ".beads"), join(worktreeDir, ".beads"))
          await this.gitAt(worktreeDir, "add", ".beads/")
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
        await this.gitAt(worktreeDir, "add", "snapshot-manifest.json")
        filesToStage.push("snapshot-manifest.json")

        // Commit in the worktree
        const commitMsg = `chore(sync): auto-sync state [${snapshotId}]`
        await this.gitAt(worktreeDir, "commit", "-m", commitMsg, "--allow-empty")

        const commitHash = (await this.gitAt(worktreeDir, "rev-parse", "HEAD")).trim()

        return {
          commitHash,
          snapshotId,
          filesIncluded: filesToStage,
          walCheckpoint,
        }
      } finally {
        // Always clean up worktree
        try {
          await this.git("worktree", "remove", worktreeDir, "--force")
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
        await this.git("fetch", this.remote, this.branch)
        const localHead = (await this.git("rev-parse", this.branch)).trim()
        const remoteRef = `${this.remote}/${this.branch}`
        const remoteHead = (await this.git("rev-parse", remoteRef)).trim()

        if (localHead !== remoteHead) {
          // Check if local is ahead of remote (fast-forward possible)
          const mergeBase = (await this.git("merge-base", this.branch, remoteRef)).trim()
          if (mergeBase !== remoteHead) {
            console.error("[git-sync] branches have diverged, halting git sync")
            this.status = "conflict"
            return false
          }
        }
      } catch {
        // Remote branch may not exist yet, which is fine
      }

      await this.git("push", this.remote, this.branch)
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
      await this.git("fetch", this.remote, this.branch)
      const remoteRef = `${this.remote}/${this.branch}`

      // Read manifest directly from remote branch (no checkout)
      try {
        const manifestJson = await this.git("show", `${remoteRef}:snapshot-manifest.json`)
        const manifest = JSON.parse(manifestJson)
        const commitHash = (await this.git("rev-parse", remoteRef)).trim()

        // Extract files from remote branch into working directory
        const restorePath = async (remotePath: string, localPath: string) => {
          try {
            const content = await this.git("show", `${remoteRef}:${remotePath}`)
            mkdirSync(dirname(localPath), { recursive: true })
            writeFileSync(localPath, content)
          } catch {
            // File may not exist in snapshot
          }
        }

        await restorePath("snapshot-manifest.json", join(this.cwd, "snapshot-manifest.json"))

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

  private async ensureArchiveBranch(): Promise<void> {
    try {
      await this.git("rev-parse", "--verify", this.branch)
    } catch {
      // Create orphan branch
      await this.git("checkout", "--orphan", this.branch)
      try { await this.git("rm", "-rf", ".") } catch { /* empty repo is fine */ }
      await this.git("commit", "--allow-empty", "-m", "chore: initialize archive branch")
    }
  }

  private async git(...args: string[]): Promise<string> {
    if (this.pool) {
      const spec: ExecSpec = {
        binaryPath: this.gitBinaryPath,
        args,
        cwd: this.cwd,
        timeoutMs: 30_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/usr/local/bin" },
        maxBuffer: 1_048_576,
      }
      const result = await this.pool.exec(spec, "system")
      if (result.exitCode !== 0) {
        throw new Error(`git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr}`)
      }
      return result.stdout
    }
    // Fallback: sync execution when no pool (legacy compat)
    try {
      return execFileSync(this.gitBinaryPath, args, {
        cwd: this.cwd,
        encoding: "utf-8",
        timeout: 30_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/usr/local/bin" },
        maxBuffer: 1_048_576,
      })
    } catch (e: any) {
      const code = typeof e?.status === "number" ? e.status : "unknown"
      const stderr = typeof e?.stderr === "string" ? e.stderr : (Buffer.isBuffer(e?.stderr) ? e.stderr.toString("utf-8") : "")
      throw new Error(`git ${args[0]} failed (exit ${code}): ${stderr || e?.message || String(e)}`)
    }
  }

  private async gitAt(cwd: string, ...args: string[]): Promise<string> {
    if (this.pool) {
      const spec: ExecSpec = {
        binaryPath: this.gitBinaryPath,
        args,
        cwd,
        timeoutMs: 30_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/usr/local/bin" },
        maxBuffer: 1_048_576,
      }
      const result = await this.pool.exec(spec, "system")
      if (result.exitCode !== 0) {
        throw new Error(`git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr}`)
      }
      return result.stdout
    }
    // Fallback: sync execution when no pool (legacy compat)
    try {
      return execFileSync(this.gitBinaryPath, args, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/usr/local/bin" },
        maxBuffer: 1_048_576,
      })
    } catch (e: any) {
      const code = typeof e?.status === "number" ? e.status : "unknown"
      const stderr = typeof e?.stderr === "string" ? e.stderr : (Buffer.isBuffer(e?.stderr) ? e.stderr.toString("utf-8") : "")
      throw new Error(`git ${args[0]} failed (exit ${code}): ${stderr || e?.message || String(e)}`)
    }
  }
}
