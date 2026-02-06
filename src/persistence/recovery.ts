// src/persistence/recovery.ts — Boot-time recovery cascade (SDD §3.3.4, T-3.4)

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ulid } from "ulid"
import type { FinnConfig } from "../config.js"
import type { WAL, WALEntry } from "./wal.js"
import type { ObjectStoreSync, R2Checkpoint } from "./r2-sync.js"
import type { GitSync, SnapshotResult } from "./git-sync.js"

export type RecoveryMode = "strict" | "degraded" | "clean"
export type RecoverySource = "r2" | "git" | "template" | "local"

export interface RecoveryResult {
  source: RecoverySource
  mode: RecoveryMode
  filesRestored: number
  walEntriesReplayed: number
  duration: number
  conflicts?: ConflictInfo[]
}

export interface ConflictInfo {
  walHeadId: string
  remoteHeadId: string
  bootEpoch: string
  resolution: "operator" | "readonly" | "template"
}

const DEFAULT_BEAUVOIR = `# BEAUVOIR.md

You are a Loa agent — a persistent, self-healing AI assistant.

## Core Behaviors
- Think before acting
- Prefer simple solutions
- Verify before proceeding
- Learn from every interaction
`

export type WALEntryHandler = (entry: WALEntry) => void

export class RecoveryCascade {
  private bootEpoch: string
  private onEntry?: WALEntryHandler

  constructor(
    private config: FinnConfig,
    private wal: WAL,
    private r2Sync: ObjectStoreSync,
    private gitSync: GitSync,
    onEntry?: WALEntryHandler,
  ) {
    this.bootEpoch = ulid()
    this.onEntry = onEntry
  }

  /** Execute the recovery cascade. Priority: R2 → Git → Template. */
  async recover(mode: RecoveryMode = "strict"): Promise<RecoveryResult> {
    const start = Date.now()

    // Check if local WAL has entries (maybe we just restarted cleanly)
    const localHead = await this.wal.getHeadEntryId()
    if (localHead) {
      // Local state exists — replay WAL entries through handler
      const replayCount = await this.replayWAL()
      return {
        source: "local",
        mode,
        filesRestored: 0,
        walEntriesReplayed: replayCount,
        duration: Date.now() - start,
      }
    }

    // Try R2 (warm, <5s)
    if (this.r2Sync.isConfigured) {
      try {
        const checkpoint = await this.r2Sync.restore(this.config.dataDir)
        if (checkpoint) {
          const replayCount = await this.replayWAL()

          // Check for conflicts
          const conflict = await this.detectConflict(checkpoint.walHeadEntryId)
          const conflicts = conflict ? [conflict] : undefined

          if (conflict && mode === "strict") {
            return {
              source: "r2",
              mode: "strict",
              filesRestored: checkpoint.objects.length,
              walEntriesReplayed: replayCount,
              duration: Date.now() - start,
              conflicts,
            }
          }

          return {
            source: "r2",
            mode,
            filesRestored: checkpoint.objects.length,
            walEntriesReplayed: replayCount,
            duration: Date.now() - start,
            conflicts,
          }
        }
      } catch (err) {
        console.error("[recovery] R2 recovery failed:", err)
      }
    }

    // Try Git (cold, <30s)
    if (this.gitSync.isConfigured) {
      try {
        const snapshot = await this.gitSync.restore()
        if (snapshot) {
          const replayCount = await this.replayWAL()
          return {
            source: "git",
            mode: mode === "strict" ? "degraded" : mode,
            filesRestored: snapshot.filesIncluded.length,
            walEntriesReplayed: replayCount,
            duration: Date.now() - start,
          }
        }
      } catch (err) {
        console.error("[recovery] Git recovery failed:", err)
      }
    }

    // Template fallback (clean start)
    this.createTemplateState()
    return {
      source: "template",
      mode: "clean",
      filesRestored: 0,
      walEntriesReplayed: 0,
      duration: Date.now() - start,
    }
  }

  /** Create valid empty state from template. */
  private createTemplateState(): void {
    const dataDir = this.config.dataDir
    const dirs = [
      join(dataDir, "sessions"),
      join(dataDir, "wal"),
      "grimoires/loa/memory",
      "grimoires/loa/a2a/trajectory",
    ]

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true })
    }

    // Write default BEAUVOIR.md if missing
    const beauvoirPath = this.config.beauvoirPath
    if (!existsSync(beauvoirPath)) {
      mkdirSync(join(beauvoirPath, ".."), { recursive: true })
      writeFileSync(beauvoirPath, DEFAULT_BEAUVOIR)
    }

    // Write empty NOTES.md
    const notesPath = join("grimoires/loa", "NOTES.md")
    if (!existsSync(notesPath)) {
      writeFileSync(notesPath, "# NOTES.md\n\n## Learnings\n\n## Blockers\n")
    }
  }

  /** Replay all WAL entries through the handler and return count. */
  private async replayWAL(): Promise<number> {
    let count = 0
    for await (const entry of this.wal.replay()) {
      if (this.onEntry) {
        this.onEntry(entry)
      }
      count++
    }
    return count
  }

  /** Detect conflicts between local and remote state. */
  private async detectConflict(remoteHeadId: string): Promise<ConflictInfo | undefined> {
    const localHead = await this.wal.getHeadEntryId()
    if (!localHead) return undefined

    if (localHead !== remoteHeadId) {
      return {
        walHeadId: localHead,
        remoteHeadId,
        bootEpoch: this.bootEpoch,
        resolution: "operator",
      }
    }

    return undefined
  }
}
