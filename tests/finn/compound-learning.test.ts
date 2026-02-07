// tests/finn/compound-learning.test.ts — Compound Learning Extractor tests (TASK-5.8)
// Self-contained: all types and CompoundLearningExtractor inlined.

import assert from "node:assert/strict"

// ── Inlined types ──────────────────────────────────────────

interface LearningCandidate {
  pattern: string
  source: string
  confidence: number
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
}

interface CompoundLearningConfig {
  minOccurrences?: number
  minConfidence?: number
  maxLearnings?: number
}

// ── Inlined CompoundLearningExtractor ─────────────────────

class CompoundLearningExtractor {
  private config: Required<CompoundLearningConfig>

  constructor(config?: CompoundLearningConfig) {
    this.config = {
      minOccurrences: config?.minOccurrences ?? 3,
      minConfidence: config?.minConfidence ?? 0.7,
      maxLearnings: config?.maxLearnings ?? 50,
    }
  }

  extractCandidates(
    results: Array<{ actionsTaken: string[]; patterns?: string[]; success: boolean }>,
  ): LearningCandidate[] {
    const now = new Date().toISOString()
    const map = new Map<string, { total: number; successes: number; firstSeen: string }>()

    for (const result of results) {
      if (!result.success) continue
      for (const pattern of result.patterns ?? []) {
        const existing = map.get(pattern)
        if (existing) {
          existing.total++
          existing.successes++
        } else {
          map.set(pattern, { total: 1, successes: 1, firstSeen: now })
        }
      }
    }

    for (const result of results) {
      if (result.success) continue
      for (const pattern of result.patterns ?? []) {
        const existing = map.get(pattern)
        if (existing) {
          existing.total++
        }
      }
    }

    return Array.from(map.entries()).map(([pattern, data]) => ({
      pattern,
      source: "review",
      confidence: data.successes / data.total,
      occurrences: data.successes,
      firstSeenAt: data.firstSeen,
      lastSeenAt: now,
    }))
  }

  qualityGate(candidates: LearningCandidate[]): {
    accepted: LearningCandidate[]
    rejected: Array<LearningCandidate & { reason: string }>
  } {
    const accepted: LearningCandidate[] = []
    const rejected: Array<LearningCandidate & { reason: string }> = []

    for (const c of candidates) {
      if (c.confidence < this.config.minConfidence) {
        rejected.push({ ...c, reason: `confidence ${c.confidence} < ${this.config.minConfidence}` })
      } else if (c.occurrences < this.config.minOccurrences) {
        rejected.push({ ...c, reason: `occurrences ${c.occurrences} < ${this.config.minOccurrences}` })
      } else {
        accepted.push(c)
      }
    }

    return { accepted, rejected }
  }

  toPersistable(
    accepted: LearningCandidate[],
  ): Array<{ id: string; pattern: string; source: string; confidence: number; createdAt: string }> {
    const now = new Date().toISOString()
    const bounded = accepted.slice(0, this.config.maxLearnings)

    return bounded.map((c) => ({
      id: `cl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pattern: c.pattern,
      source: c.source,
      confidence: c.confidence,
      createdAt: now,
    }))
  }

  getConfig(): Required<CompoundLearningConfig> {
    return this.config
  }
}

// ── Test harness ───────────────────────────────────────────

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

// ── Tests ──────────────────────────────────────────────────

async function main() {
  console.log("Compound Learning Extractor Tests")
  console.log("==================================")

  console.log("\n--- extractCandidates ---")

  await test("extractCandidates: groups by pattern and counts occurrences", () => {
    const ext = new CompoundLearningExtractor()
    const candidates = ext.extractCandidates([
      { actionsTaken: ["lint"], patterns: ["missing-semicolon"], success: true },
      { actionsTaken: ["lint"], patterns: ["missing-semicolon"], success: true },
      { actionsTaken: ["lint"], patterns: ["missing-semicolon", "unused-import"], success: true },
    ])
    const semicolon = candidates.find(c => c.pattern === "missing-semicolon")
    const unused = candidates.find(c => c.pattern === "unused-import")
    assert.ok(semicolon, "should find missing-semicolon pattern")
    assert.equal(semicolon!.occurrences, 3)
    assert.ok(unused, "should find unused-import pattern")
    assert.equal(unused!.occurrences, 1)
  })

  await test("extractCandidates: ignores failed results", () => {
    const ext = new CompoundLearningExtractor()
    const candidates = ext.extractCandidates([
      { actionsTaken: ["review"], patterns: ["only-in-failure"], success: false },
    ])
    // Pattern only appeared in failed results, never in success, so not extracted
    assert.equal(candidates.length, 0)
  })

  await test("extractCandidates: confidence based on success rate", () => {
    const ext = new CompoundLearningExtractor()
    const candidates = ext.extractCandidates([
      { actionsTaken: ["lint"], patterns: ["flaky-pattern"], success: true },
      { actionsTaken: ["lint"], patterns: ["flaky-pattern"], success: true },
      { actionsTaken: ["lint"], patterns: ["flaky-pattern"], success: false },
      { actionsTaken: ["lint"], patterns: ["flaky-pattern"], success: false },
    ])
    assert.equal(candidates.length, 1)
    // 2 successes out of 4 total appearances
    assert.equal(candidates[0].confidence, 0.5)
    assert.equal(candidates[0].occurrences, 2)
  })

  console.log("\n--- qualityGate ---")

  await test("qualityGate: accepts candidates above thresholds", () => {
    const ext = new CompoundLearningExtractor({ minOccurrences: 2, minConfidence: 0.6 })
    const now = new Date().toISOString()
    const { accepted } = ext.qualityGate([
      { pattern: "good", source: "review", confidence: 0.9, occurrences: 5, firstSeenAt: now, lastSeenAt: now },
    ])
    assert.equal(accepted.length, 1)
    assert.equal(accepted[0].pattern, "good")
  })

  await test("qualityGate: rejects low confidence", () => {
    const ext = new CompoundLearningExtractor({ minOccurrences: 1, minConfidence: 0.8 })
    const now = new Date().toISOString()
    const { accepted, rejected } = ext.qualityGate([
      { pattern: "low-conf", source: "review", confidence: 0.5, occurrences: 10, firstSeenAt: now, lastSeenAt: now },
    ])
    assert.equal(accepted.length, 0)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].pattern, "low-conf")
  })

  await test("qualityGate: rejects low occurrences", () => {
    const ext = new CompoundLearningExtractor({ minOccurrences: 5, minConfidence: 0.5 })
    const now = new Date().toISOString()
    const { accepted, rejected } = ext.qualityGate([
      { pattern: "rare", source: "review", confidence: 0.9, occurrences: 2, firstSeenAt: now, lastSeenAt: now },
    ])
    assert.equal(accepted.length, 0)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].pattern, "rare")
  })

  await test("qualityGate: rejection includes reason", () => {
    const ext = new CompoundLearningExtractor({ minOccurrences: 3, minConfidence: 0.7 })
    const now = new Date().toISOString()
    const { rejected } = ext.qualityGate([
      { pattern: "bad", source: "review", confidence: 0.3, occurrences: 1, firstSeenAt: now, lastSeenAt: now },
    ])
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0].reason.includes("confidence"), "reason should mention confidence")
    assert.ok(rejected[0].reason.length > 0, "reason should not be empty")
  })

  console.log("\n--- toPersistable ---")

  await test("toPersistable: generates ID and timestamp", () => {
    const ext = new CompoundLearningExtractor()
    const now = new Date().toISOString()
    const persisted = ext.toPersistable([
      { pattern: "test-pattern", source: "review", confidence: 0.85, occurrences: 5, firstSeenAt: now, lastSeenAt: now },
    ])
    assert.equal(persisted.length, 1)
    assert.ok(persisted[0].id.startsWith("cl-"), "ID should start with 'cl-'")
    assert.equal(persisted[0].pattern, "test-pattern")
    assert.equal(persisted[0].confidence, 0.85)
    const parsed = new Date(persisted[0].createdAt)
    assert.ok(!isNaN(parsed.getTime()), "createdAt should be valid ISO date")
  })

  console.log("\n--- config & limits ---")

  await test("config defaults: minOccurrences=3, minConfidence=0.7, maxLearnings=50", () => {
    const ext = new CompoundLearningExtractor()
    const cfg = ext.getConfig()
    assert.equal(cfg.minOccurrences, 3)
    assert.equal(cfg.minConfidence, 0.7)
    assert.equal(cfg.maxLearnings, 50)
  })

  await test("toPersistable: respects maxLearnings limit", () => {
    const ext = new CompoundLearningExtractor({ maxLearnings: 2 })
    const now = new Date().toISOString()
    const candidates: LearningCandidate[] = [
      { pattern: "p1", source: "review", confidence: 0.9, occurrences: 5, firstSeenAt: now, lastSeenAt: now },
      { pattern: "p2", source: "review", confidence: 0.8, occurrences: 4, firstSeenAt: now, lastSeenAt: now },
      { pattern: "p3", source: "review", confidence: 0.7, occurrences: 3, firstSeenAt: now, lastSeenAt: now },
    ]
    const persisted = ext.toPersistable(candidates)
    assert.equal(persisted.length, 2, "should cap at maxLearnings=2")
    assert.equal(persisted[0].pattern, "p1")
    assert.equal(persisted[1].pattern, "p2")
  })

  console.log("\nDone.")
}

main()
