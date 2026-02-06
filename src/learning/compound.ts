// src/learning/compound.ts — Compound learning cycle (SDD §3.6, T-4.6)

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ulid } from "ulid"
import type { WAL } from "../persistence/wal.js"

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

  constructor(
    private dataDir: string,
    private wal: WAL,
  ) {
    this.trajectoryDir = join("grimoires/loa/a2a/trajectory")
    mkdirSync(this.trajectoryDir, { recursive: true })
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
            id: ulid(),
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

  /** Persist qualified learnings to NOTES.md and WAL. */
  async persist(learnings: QualifiedLearning[]): Promise<void> {
    if (learnings.length === 0) return

    const notesPath = join("grimoires/loa", "NOTES.md")

    // Append learnings to NOTES.md
    let content = ""
    try {
      content = await readFile(notesPath, "utf-8")
    } catch {
      content = "# NOTES.md\n\n## Learnings\n"
    }

    const newEntries = learnings
      .map(
        (l) =>
          `- **${l.trigger}**: ${l.resolution} (confidence: ${l.confidence.toFixed(2)}, quality: ${l.qualityScore.toFixed(2)})`,
      )
      .join("\n")

    if (content.includes("## Learnings")) {
      content = content.replace("## Learnings", `## Learnings\n${newEntries}`)
    } else {
      content += `\n## Learnings\n${newEntries}\n`
    }

    await writeFile(notesPath, content)

    // Log to WAL
    for (const learning of learnings) {
      this.wal.append("memory", "create", `learnings/${learning.id}`, learning)
    }
  }

  /** Load recent learnings formatted for system prompt injection. */
  async loadForContext(limit = 20): Promise<string> {
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
}
