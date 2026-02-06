// src/learning/compound.ts — Compound learning cycle (SDD §3.6, T-4.6, T-7.7)
// Uses upstream LearningStore for persistence, WALManager for trajectory logging.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { WALManager } from "../persistence/upstream.js"
import { LearningStore } from "../persistence/upstream.js"
import { walPath } from "../persistence/wal-path.js"

export interface TrajectoryEntry {
  timestamp: number
  sessionId: string
  type: "message" | "tool_start" | "tool_end"
  tool?: string
  role?: string
  text?: string
  args?: unknown
  result?: string
  isError?: boolean
}

export interface CandidateLearning {
  trigger: string
  context: string
  resolution: string
  confidence: number
  sourceSessionId: string
}

export interface QualifiedLearning {
  id: string
  trigger: string
  context: string
  resolution: string
  confidence: number
  qualityScore: number
  timestamp: number
}

export class CompoundLearning {
  private trajectoryDir: string
  private learningStore: LearningStore

  constructor(
    private dataDir: string,
    private wal: WALManager,
  ) {
    this.trajectoryDir = join("grimoires/loa/a2a/trajectory")
    mkdirSync(this.trajectoryDir, { recursive: true })

    // Initialize upstream LearningStore (disk-backed, WAL logged separately)
    this.learningStore = new LearningStore({
      basePath: join("grimoires/loa"),
    })
  }

  /** Log a trajectory entry for the current session. */
  logEntry(entry: TrajectoryEntry): void {
    const date = new Date(entry.timestamp).toISOString().split("T")[0]
    const filePath = join(this.trajectoryDir, `${date}.jsonl`)
    appendFileSync(filePath, JSON.stringify(entry) + "\n")
  }

  /** Extract candidate learnings from a session's trajectory. */
  async extract(sessionId: string): Promise<CandidateLearning[]> {
    const candidates: CandidateLearning[] = []

    // Read today's trajectory
    const date = new Date().toISOString().split("T")[0]
    const filePath = join(this.trajectoryDir, `${date}.jsonl`)
    if (!existsSync(filePath)) return candidates

    const content = readFileSync(filePath, "utf-8")
    const entries = content
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TrajectoryEntry)
      .filter((e) => e.sessionId === sessionId)

    // Pattern: error followed by successful retry
    for (let i = 0; i < entries.length - 1; i++) {
      if (entries[i].type === "tool_end" && entries[i].isError) {
        // Look for successful follow-up
        for (let j = i + 1; j < Math.min(i + 5, entries.length); j++) {
          if (
            entries[j].type === "tool_end" &&
            !entries[j].isError &&
            entries[j].tool === entries[i].tool
          ) {
            candidates.push({
              trigger: `tool:${entries[i].tool}:error`,
              context: entries[i].result?.slice(0, 200) ?? "error occurred",
              resolution: `Retry with: ${entries[j].args ? JSON.stringify(entries[j].args).slice(0, 200) : "adjusted args"}`,
              confidence: 0.6,
              sourceSessionId: sessionId,
            })
            break
          }
        }
      }
    }

    return candidates
  }

  /** Evaluate candidates against quality gates (3+ of 4 must pass). */
  evaluate(candidates: CandidateLearning[]): QualifiedLearning[] {
    return candidates
      .map((c) => {
        let gates = 0

        // Gate 1: Depth — has trigger + context + resolution
        if (c.trigger && c.context && c.resolution) gates++

        // Gate 2: Reusability — not hyper-specific
        if (!c.trigger.includes("session") && c.confidence > 0.4) gates++

        // Gate 3: Trigger clarity — follows pattern
        if (c.trigger.match(/^(tool|pattern):.+/)) gates++

        // Gate 4: Confidence threshold
        if (c.confidence >= 0.5) gates++

        const qualityScore = gates / 4

        if (gates >= 3) {
          return {
            id: `learning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            trigger: c.trigger,
            context: c.context,
            resolution: c.resolution,
            confidence: c.confidence,
            qualityScore,
            timestamp: Date.now(),
          } satisfies QualifiedLearning
        }
        return null
      })
      .filter((l): l is QualifiedLearning => l !== null)
  }

  /** Persist qualified learnings via upstream LearningStore + WAL. */
  async persist(learnings: QualifiedLearning[]): Promise<void> {
    for (const learning of learnings) {
      // Store in LearningStore (writes to disk)
      const stored = await this.learningStore.addLearning({
        source: "error-cycle",
        trigger: learning.trigger,
        pattern: learning.context,
        solution: learning.resolution,
        target: "openclaw", // Not "loa" to skip self-improvement approval flow
      })

      // Also log to WAL for upstream sync
      const data = Buffer.from(JSON.stringify(stored))
      const filename = stored.id.replace(/[^a-zA-Z0-9_-]/g, "-")
      await this.wal.append("write", walPath("learnings", filename), data)
    }
  }

  /** Load recent learnings formatted for system prompt injection. */
  async loadForContext(limit = 20): Promise<string> {
    // Load from upstream LearningStore
    const store = await this.learningStore.loadStore()
    const active = store.learnings
      .filter((l) => l.status === "active" || l.status === "pending")
      .slice(0, limit)

    if (active.length > 0) {
      const lines = active.map(
        (l) => `- **${l.trigger}**: ${l.solution}`,
      )
      return `## Recent Learnings from Prior Sessions\n${lines.join("\n")}`
    }

    // Fallback: read from NOTES.md for backward compatibility
    const notesPath = join("grimoires/loa", "NOTES.md")
    try {
      const content = await readFile(notesPath, "utf-8")
      const learningsSection = content.split("## Learnings")[1]?.split("## ")[0]
      if (!learningsSection?.trim()) return ""

      const lines = learningsSection.trim().split("\n").filter(Boolean).slice(0, limit)
      if (lines.length === 0) return ""

      return `## Recent Learnings from Prior Sessions\n${lines.join("\n")}`
    } catch {
      return ""
    }
  }

  /** Get the underlying LearningStore for advanced queries. */
  getStore(): LearningStore {
    return this.learningStore
  }
}
