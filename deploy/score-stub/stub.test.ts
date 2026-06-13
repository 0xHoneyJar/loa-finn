// deploy/score-stub/stub.test.ts — stub contract tests (sprint-169 T5.2)
//
// Fixture byte-sizes are PART OF THE CONTRACT (enhance doc: "a tiny-payload
// stub invalidates the infra measurement"). Vocabulary literals are asserted
// here because the stub intentionally duplicates src/score/core/screen.ts
// vocabulary without importing it (flatline HC9) — drift surfaces here.

import { describe, expect, it } from "vitest"
import {
  ADVERSARY_TAGS,
  BANDS,
  SIZE_BANDS,
  buildFactSheet,
  fnv1a,
  sizeClassFor,
  type SizeClass,
} from "./fixtures.js"
import { createStubApp } from "./server.js"

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

/** Find a deterministic agent id for each size class. */
function idsByClass(): Record<SizeClass, string> {
  const found: Partial<Record<SizeClass, string>> = {}
  for (let i = 0; Object.keys(found).length < 3 && i < 1000; i++) {
    const id = `0xagent${i}`
    const cls = sizeClassFor(id)
    if (!found[cls]) found[cls] = id
  }
  return found as Record<SizeClass, string>
}

describe("vocabulary literals (HC9 — intentional duplication, no src/score import)", () => {
  it("mirrors the screen.ts band vocabulary", () => {
    expect([...BANDS]).toEqual(["HIGH", "MED", "LOW", "INSUFFICIENT_EVIDENCE"])
  })

  it("mirrors the screen.ts adversary-tag vocabulary", () => {
    expect([...ADVERSARY_TAGS]).toEqual([
      "naive_farm",
      "subsidy_capture",
      "adaptive_farm",
      "legit_shared_audience",
      "relay_double_count",
      "none",
    ])
  })

  it("imports nothing from src/score (island boundary)", async () => {
    const { readFile } = await import("node:fs/promises")
    for (const file of ["fixtures.ts", "server.ts"]) {
      const src = await readFile(new URL(`./${file}`, import.meta.url), "utf-8")
      expect(src).not.toMatch(/from\s+["'].*src\/score/)
    }
  })
})

describe("fixture byte-sizes (contract)", () => {
  const ids = idsByClass()

  it.each(Object.entries(SIZE_BANDS))("%s fixtures land in the contract band", (cls, band) => {
    const sheet = buildFactSheet(ids[cls as SizeClass])
    const size = byteSize(sheet)
    expect(size).toBeGreaterThanOrEqual(band.min)
    expect(size).toBeLessThanOrEqual(band.max)
  })
})

describe("determinism + shape", () => {
  it("same agentId always yields the identical fact-sheet", () => {
    expect(buildFactSheet("0xrepeatable")).toEqual(buildFactSheet("0xrepeatable"))
  })

  it("fnv1a is stable", () => {
    expect(fnv1a("0xrepeatable")).toBe(fnv1a("0xrepeatable"))
  })

  it("emits the four PR #263 layers with an abstain-capable claim", () => {
    const sheet = buildFactSheet("0xshape-check")
    expect(Object.keys(sheet.layers)).toEqual(["observed", "structural", "readings", "claim"])
    expect(["CLAIM", "ABSTAIN"]).toContain(sheet.layers.claim.verdict)
    expect(BANDS).toContain(sheet.layers.claim.band)
    expect(ADVERSARY_TAGS).toContain(sheet.layers.claim.adversary_tag)
  })

  it("produces abstain (INSUFFICIENT_EVIDENCE) fixtures for some ids", () => {
    let abstains = 0
    for (let i = 0; i < 30; i++) {
      const sheet = buildFactSheet(`0xmix${i}`)
      if (sheet.layers.claim.verdict === "ABSTAIN") {
        abstains++
        expect(sheet.layers.claim.band).toBe("INSUFFICIENT_EVIDENCE")
      }
    }
    expect(abstains).toBeGreaterThan(0)
  })
})

describe("HTTP surface", () => {
  it("GET /verdict/:agentId returns the fixture with the size-class header", async () => {
    const app = createStubApp(0)
    const res = await app.request("/verdict/0xagent1")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-stub-size-class")).toBe(sizeClassFor("0xagent1"))
    const body = (await res.json()) as ReturnType<typeof buildFactSheet>
    expect(body).toEqual(buildFactSheet("0xagent1"))
  })

  it("GET /health responds ok", async () => {
    const app = createStubApp(0)
    const res = await app.request("/health")
    expect(res.status).toBe(200)
  })

  it("rejects oversized agent ids", async () => {
    const app = createStubApp(0)
    const res = await app.request(`/verdict/${"x".repeat(300)}`)
    expect(res.status).toBe(400)
  })
})
