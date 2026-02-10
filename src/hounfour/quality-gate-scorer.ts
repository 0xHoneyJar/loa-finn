// src/hounfour/quality-gate-scorer.ts — Quality Gate Scorer for Ensemble (F9, T-31.3)
//
// Adapter that scores CompletionResult candidates by running them through
// the Ground Truth quality-gates.sh pipeline. Returns gates_passed/gates_total
// as a 0.0-1.0 score for best_of_n ensemble selection.

import { writeFile, unlink, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { CompletionResult } from "./types.js"
import type { ScorerFunction } from "./ensemble.js"

const execFileAsync = promisify(execFile)

export interface QualityGateScorerOptions {
  /** Path to quality-gates.sh script */
  gateScriptPath: string
  /** Timeout per gate run (ms). Default: 30000 */
  timeoutMs?: number
}

/**
 * Scores ensemble candidates by running quality-gates.sh on each.
 * Score = gates_passed / gates_total (0.0-1.0).
 * Gate script failure → score 0.0 (does not throw).
 */
export class QualityGateScorer {
  private gateScriptPath: string
  private timeoutMs: number

  constructor(options: QualityGateScorerOptions) {
    this.gateScriptPath = options.gateScriptPath
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  /** Get the scorer function for use with EnsembleConfig.scorer */
  toScorerFunction(): ScorerFunction {
    return async (result: CompletionResult): Promise<number> => {
      return this.score(result)
    }
  }

  /** Score a single candidate result */
  async score(result: CompletionResult): Promise<number> {
    let tempDir: string | null = null
    let tempFile: string | null = null

    try {
      // Write candidate text to temp file
      tempDir = await mkdtemp(join(tmpdir(), "qg-scorer-"))
      tempFile = join(tempDir, "candidate.md")
      await writeFile(tempFile, result.content, "utf8")

      // Run quality-gates.sh with --json flag
      const { stdout } = await execFileAsync(
        this.gateScriptPath,
        [tempFile, "--json"],
        {
          timeout: this.timeoutMs,
          encoding: "utf8",
          env: { ...process.env, PATH: process.env.PATH },
        },
      )

      // Parse JSON output: extract gates_passed / gates_total
      const output = JSON.parse(stdout.trim())
      const passed = typeof output.gates_passed === "number" ? output.gates_passed : 0
      const total = typeof output.gates_total === "number" ? output.gates_total : 1
      return total > 0 ? passed / total : 0.0
    } catch {
      // Gate script failure → score 0.0
      return 0.0
    } finally {
      // Cleanup temp files
      if (tempFile) await unlink(tempFile).catch(() => {})
      if (tempDir) {
        const { rm } = await import("node:fs/promises")
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}
