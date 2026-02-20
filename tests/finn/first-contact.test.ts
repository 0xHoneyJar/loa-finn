// tests/finn/first-contact.test.ts — First-Contact Message Generation Tests (Sprint 20 Task 20.2)

import { describe, it, expect, vi } from "vitest"
import { buildFirstContactPrompt, generateFirstContact } from "../../src/nft/first-contact.js"
import type { SignalSnapshot } from "../../src/nft/signal-types.js"
import type { SynthesisRouter } from "../../src/nft/beauvoir-synthesizer.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(overrides?: Partial<SignalSnapshot>): SignalSnapshot {
  return {
    archetype: "freetekno",
    ancestor: "greek_philosopher",
    birthday: "-450-06-15",
    era: "ancient",
    molecule: "psilocybin",
    tarot: { name: "The Moon", number: 18, suit: "major", element: "water" },
    element: "water",
    swag_rank: "A",
    swag_score: 72,
    sun_sign: "gemini",
    moon_sign: "scorpio",
    ascending_sign: "aquarius",
    ...overrides,
  }
}

const MOCK_BEAUVOIR = `# TekSophos-4217

## Identity
A presence shaped by the resonance of deep thought and the pulse of sound systems.

## Voice
Speaks in measured cadences with occasional bursts of raw energy.`

function mockRouter(response: string): SynthesisRouter {
  return {
    invoke: vi.fn().mockResolvedValue({ content: response }),
  }
}

function failingRouter(): SynthesisRouter {
  return {
    invoke: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("First-Contact Prompt Builder (Task 20.2)", () => {
  it("includes the canonical name in the prompt", () => {
    const prompt = buildFirstContactPrompt("TekSophos-4217", makeSnapshot(), MOCK_BEAUVOIR)
    expect(prompt).toContain("TekSophos-4217")
  })

  it("includes archetype and ancestor context", () => {
    const prompt = buildFirstContactPrompt("TekSophos-4217", makeSnapshot(), MOCK_BEAUVOIR)
    expect(prompt).toContain("freetekno")
    expect(prompt).toContain("greek_philosopher")
  })

  it("enforces anti-narration rules", () => {
    const prompt = buildFirstContactPrompt("TekSophos-4217", makeSnapshot(), MOCK_BEAUVOIR)
    expect(prompt).toContain("Do NOT self-narrate")
    expect(prompt).toContain("Do NOT mention signals")
  })

  it("truncates long BEAUVOIR documents", () => {
    const longBeauvoir = "x".repeat(3000)
    const prompt = buildFirstContactPrompt("Name-1234", makeSnapshot(), longBeauvoir)
    // Should be truncated to 1500 chars of beauvoir content
    expect(prompt.length).toBeLessThan(3000 + 500) // prompt overhead + truncated
  })
})

describe("First-Contact Generator (Task 20.2)", () => {
  it("returns generated message on success", async () => {
    const router = mockRouter("The resonance finds its name. I am TekSophos-4217.")
    const msg = await generateFirstContact(router, "TekSophos-4217", makeSnapshot(), MOCK_BEAUVOIR)
    expect(msg).toBe("The resonance finds its name. I am TekSophos-4217.")
    expect(router.invoke).toHaveBeenCalledOnce()
  })

  it("returns null on LLM failure (non-fatal)", async () => {
    const router = failingRouter()
    const msg = await generateFirstContact(router, "TekSophos-4217", makeSnapshot(), MOCK_BEAUVOIR)
    expect(msg).toBeNull()
  })

  it("passes custom config to router", async () => {
    const router = mockRouter("Hello.")
    await generateFirstContact(router, "Name-0001", makeSnapshot(), MOCK_BEAUVOIR, {
      maxTokens: 128,
      temperature: 0.5,
    })
    expect(router.invoke).toHaveBeenCalledWith(
      "first-contact-gen",
      expect.any(String),
      expect.objectContaining({ temperature: 0.5, max_tokens: 128 }),
    )
  })
})
