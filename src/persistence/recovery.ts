// src/persistence/recovery.ts — Boot-time recovery using upstream RecoveryEngine (T-7.3)

import { mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import type { FinnConfig } from "../config.js"
import type { WALManager } from "./upstream.js"
import { RecoveryEngine, TemplateRecoverySource, GitRecoverySource } from "./upstream.js"
import type { IRecoverySource, RecoveryState, GitRestoreClient } from "./upstream.js"
import type { ObjectStoreSync } from "./r2-sync.js"
import type { GitSync } from "./git-sync.js"

export type RecoveryMode = "strict" | "degraded" | "clean"

export interface RecoveryResult {
  source: string
  mode: RecoveryMode
  state: RecoveryState
  filesRestored: number
  walEntriesReplayed: number
  duration: number
}

const DEFAULT_BEAUVOIR = `# BEAUVOIR.md

You are a Loa agent — a persistent, self-healing AI assistant.

## Core Behaviors
- Think before acting
- Prefer simple solutions
- Verify before proceeding
- Learn from every interaction
`

/**
 * R2RecoverySource — adapts ObjectStoreSync.restore() to IRecoverySource.
 * When T-7.4 implements ICheckpointStorage, this can switch to MountRecoverySource.
 */
class R2RecoverySource implements IRecoverySource {
  readonly name = "r2"

  constructor(
    private r2Sync: ObjectStoreSync,
    private dataDir: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.r2Sync.isConfigured
  }

  async restore(): Promise<Map<string, Buffer> | null> {
    // r2Sync.restore() downloads files to disk directly
    const checkpoint = await this.r2Sync.restore(this.dataDir)
    if (!checkpoint) return null

    // Return file keys as the restored set (data already on disk)
    const files = new Map<string, Buffer>()
    for (const obj of checkpoint.objects) {
      files.set(obj.key, Buffer.alloc(0))
    }
    return files.size > 0 ? files : null
  }
}

/**
 * FinnGitRestoreClient — adapts GitSync to upstream GitRestoreClient interface (T-7.5).
 * Used by upstream GitRecoverySource for git-based recovery.
 */
class FinnGitRestoreClient implements GitRestoreClient {
  constructor(private gitSync: GitSync) {}

  async isAvailable(): Promise<boolean> {
    return this.gitSync.isConfigured
  }

  async cloneOrPull(): Promise<boolean> {
    // GitSync.restore() fetches and reads from remote branch
    const snapshot = await this.gitSync.restore()
    return snapshot !== undefined
  }

  async listFiles(): Promise<string[]> {
    const snapshot = await this.gitSync.restore()
    return snapshot?.filesIncluded ?? []
  }

  async getFile(path: string): Promise<Buffer | null> {
    // Git restore writes files to disk; return empty buffer as marker
    return Buffer.alloc(0)
  }
}

/** Build the default template file set. */
function buildTemplates(config: FinnConfig): Map<string, Buffer> {
  const templates = new Map<string, Buffer>()
  templates.set(config.beauvoirPath, Buffer.from(DEFAULT_BEAUVOIR))
  templates.set("grimoires/loa/NOTES.md", Buffer.from("# NOTES.md\n\n## Learnings\n\n## Blockers\n"))
  return templates
}

/** Ensure directories exist for recovered files. */
function ensureDirectories(config: FinnConfig): void {
  const dirs = [
    join(config.dataDir, "sessions"),
    join(config.dataDir, "wal"),
    "grimoires/loa/memory",
    "grimoires/loa/a2a/trajectory",
  ]
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Write recovered files to disk. */
function writeFiles(files: Map<string, Buffer>): number {
  let count = 0
  for (const [path, data] of files) {
    if (data.length === 0) continue // Skip empty (git already wrote them)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
    count++
  }
  return count
}

/**
 * Run boot-time recovery using upstream RecoveryEngine.
 *
 * Priority: local WAL → R2 → Git → Template
 */
export async function runRecovery(
  config: FinnConfig,
  wal: WALManager,
  r2Sync: ObjectStoreSync,
  gitSync: GitSync,
): Promise<RecoveryResult> {
  const start = Date.now()

  // Ensure base directories exist
  ensureDirectories(config)

  // Check if local WAL has entries (clean restart — no remote recovery needed)
  const walStatus = wal.getStatus()
  if (walStatus.seq > 0) {
    let replayCount = 0
    await wal.replay(async () => { replayCount++ })
    return {
      source: "local",
      mode: "strict",
      state: "RUNNING",
      filesRestored: 0,
      walEntriesReplayed: replayCount,
      duration: Date.now() - start,
    }
  }

  // Build recovery sources
  const sources: IRecoverySource[] = []

  if (r2Sync.isConfigured) {
    sources.push(new R2RecoverySource(r2Sync, config.dataDir))
  }

  if (gitSync.isConfigured) {
    sources.push(new GitRecoverySource(new FinnGitRestoreClient(gitSync)))
  }

  // Template fallback (always available)
  sources.push(new TemplateRecoverySource(buildTemplates(config)))

  // Run recovery engine
  const engine = new RecoveryEngine({
    sources,
    onEvent: (event, data) => {
      console.log(`[recovery] ${event}`, data ? JSON.stringify(data) : "")
    },
    onStateChange: (from, to) => {
      console.log(`[recovery] ${from} -> ${to}`)
    },
  })

  const result = await engine.run()

  // Write restored files to disk
  let filesRestored = 0
  if (result.files) {
    filesRestored = writeFiles(result.files)
  }

  // Determine mode based on source
  let mode: RecoveryMode = "strict"
  if (result.state === "DEGRADED" || result.state === "LOOP_DETECTED") {
    mode = "clean"
  } else if (result.source === "git" || result.source === "template") {
    mode = result.source === "template" ? "clean" : "degraded"
  }

  // Replay any WAL entries that were restored
  let replayCount = 0
  const postStatus = wal.getStatus()
  if (postStatus.seq > 0) {
    await wal.replay(async () => { replayCount++ })
  }

  return {
    source: result.source ?? "template",
    mode,
    state: result.state,
    filesRestored,
    walEntriesReplayed: replayCount,
    duration: Date.now() - start,
  }
}
