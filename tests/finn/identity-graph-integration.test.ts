// tests/finn/identity-graph-integration.test.ts — Identity Graph Integration Tests (Cycle 040, Sprint 2 T-2.5)

import { describe, it, expect, vi } from "vitest"
import { createSubgraphResolver } from "../../src/nft/identity-graph-resolver.js"
import type { SignalSnapshot } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Mock data — two distinct signal snapshots
// ---------------------------------------------------------------------------

const SNAPSHOT_HERMES: SignalSnapshot = {
  archetype: "freetekno" as any,
  ancestor: "hermes" as any,
  birthday: "1990-06-15",
  era: "modern" as any,
  molecule: "psilocybin" as any,
  tarot: { name: "The Magician", suit: "major", number: 1 } as any,
  element: "fire" as any,
  swag: { rank: "S" as any, score: 85 },
  zodiac: { sun: "gemini" as any, moon: "aries" as any, rising: "leo" as any },
}

const SNAPSHOT_KALI: SignalSnapshot = {
  archetype: "milady" as any,
  ancestor: "kali" as any,
  birthday: "1200-03-21",
  era: "medieval" as any,
  molecule: "dmt" as any,
  tarot: { name: "The High Priestess", suit: "major", number: 2 } as any,
  element: "water" as any,
  swag: { rank: "A" as any, score: 70 },
  zodiac: { sun: "pisces" as any, moon: "scorpio" as any, rising: "cancer" as any },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSubgraphResolver", () => {
  it("returns a function", () => {
    const resolver = createSubgraphResolver()
    expect(typeof resolver).toBe("function")
  })

  it("returns null gracefully when graph has no data for ancestor", async () => {
    const resolver = createSubgraphResolver()
    // Use a snapshot with a nonsensical ancestor that won't match codex data
    const bogus: SignalSnapshot = {
      ...SNAPSHOT_HERMES,
      ancestor: "nonexistent_ancestor_xyz" as any,
    }
    const result = await resolver(bogus)
    // Should return null (no nodes) or a valid subgraph — either is acceptable
    // The key is that it doesn't throw
    expect(result === null || typeof result === "object").toBe(true)
  })

  it("returns consistent results for the same snapshot", async () => {
    const resolver = createSubgraphResolver()
    const r1 = await resolver(SNAPSHOT_HERMES)
    const r2 = await resolver(SNAPSHOT_HERMES)

    if (r1 !== null && r2 !== null) {
      expect(r1.cultural_references).toEqual(r2.cultural_references)
      expect(r1.aesthetic_notes).toEqual(r2.aesthetic_notes)
      expect(r1.philosophical_lineage).toEqual(r2.philosophical_lineage)
    }
  })

  it("produces different subgraphs for different ancestors", async () => {
    const resolver = createSubgraphResolver()
    const hermesResult = await resolver(SNAPSHOT_HERMES)
    const kaliResult = await resolver(SNAPSHOT_KALI)

    // If both resolve to valid subgraphs, they should differ
    if (hermesResult !== null && kaliResult !== null) {
      const hermesAll = [
        ...hermesResult.cultural_references,
        ...hermesResult.aesthetic_notes,
        ...hermesResult.philosophical_lineage,
      ].join("|")

      const kaliAll = [
        ...kaliResult.cultural_references,
        ...kaliResult.aesthetic_notes,
        ...kaliResult.philosophical_lineage,
      ].join("|")

      expect(hermesAll).not.toBe(kaliAll)
    }
  })

  it("returns synthesis-compatible shape with string arrays", async () => {
    const resolver = createSubgraphResolver()
    const result = await resolver(SNAPSHOT_HERMES)

    if (result !== null) {
      expect(Array.isArray(result.cultural_references)).toBe(true)
      expect(Array.isArray(result.aesthetic_notes)).toBe(true)
      expect(Array.isArray(result.philosophical_lineage)).toBe(true)

      // All entries should be strings
      for (const ref of result.cultural_references) {
        expect(typeof ref).toBe("string")
      }
    }
  })

  it("lazy-loads graph only once across multiple calls", async () => {
    const resolver = createSubgraphResolver()
    // Call multiple times — graph should be loaded once internally
    await resolver(SNAPSHOT_HERMES)
    await resolver(SNAPSHOT_KALI)
    await resolver(SNAPSHOT_HERMES)
    // No assertion needed — if it throws on second load, test fails
  })
})
