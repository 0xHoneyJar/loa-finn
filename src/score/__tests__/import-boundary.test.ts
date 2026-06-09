// src/score/__tests__/import-boundary.test.ts — FR-4 hard import boundary.
//
// The Phase-1 spike must be a pure, read-only forensic core: it imports NOTHING from the
// demand-gated runtime (LLM/hounfour, wallet/x402-payment, Bedrock, credential broker,
// persistence) and pulls in NO new npm dependency. We enforce this statically by scanning
// every non-test source file under src/score and asserting each import is either a
// relative path (within score) or a node: builtin — nothing else.

import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCORE_DIR = join(__dirname, "..") // src/score

function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue // skip tests
      collectSources(full, acc)
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full)
    }
  }
  return acc
}

function importSources(code: string): string[] {
  const out: string[] = []
  const re = /(?:from|import)\s+["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) out.push(m[1])
  return out
}

// Explicit blocklist for a clearer failure message than "non-relative import".
const FORBIDDEN = [
  /hounfour/,
  /\/x402\b/,
  /persistence/,
  /\/billing\b/,
  /\/credits\b/,
  /\/gateway\b/,
  /\/agent\b/,
  /\/safety\b/,
  /bedrock/i,
  /anthropic/i,
  /wallet/i,
]

describe("FR-4 import boundary — src/score is a pure read-only island", () => {
  const sources = collectSources(SCORE_DIR)

  it("there are score source files to check", () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it("imports nothing from demand-gated modules (LLM / wallet / x402 / persistence / bedrock)", () => {
    const violations: string[] = []
    for (const file of sources) {
      for (const src of importSources(readFileSync(file, "utf8"))) {
        if (FORBIDDEN.some((re) => re.test(src))) {
          violations.push(`${file.replace(SCORE_DIR, "src/score")} → ${src}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it("every import is a relative path or a node: builtin (no new npm deps)", () => {
    const violations: string[] = []
    for (const file of sources) {
      for (const src of importSources(readFileSync(file, "utf8"))) {
        const ok = src.startsWith("./") || src.startsWith("../") || src.startsWith("node:")
        if (!ok) violations.push(`${file.replace(SCORE_DIR, "src/score")} → ${src}`)
      }
    }
    expect(violations).toEqual([])
  })
})
