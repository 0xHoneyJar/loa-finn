// tests/finn/beauvoir-synthesis.test.ts — BEAUVOIR Synthesizer Tests (Sprint 2 Tasks 2.1-2.3, 2.6)

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  BeauvoirSynthesizer,
  buildSynthesisPrompt,
  SynthesisError,
} from "../../src/nft/beauvoir-synthesizer.js"
import type {
  SynthesisRouter,
  IdentitySubgraph,
  UserCustomInput,
} from "../../src/nft/beauvoir-synthesizer.js"
import type { SignalSnapshot, DAMPFingerprint, DAMPDialId } from "../../src/nft/signal-types.js"
import { DAMP_DIAL_IDS } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(overrides?: Partial<SignalSnapshot>): SignalSnapshot {
  return {
    archetype: "freetekno",
    ancestor: "pythagoras",
    birthday: "1352-06-15",
    era: "medieval",
    molecule: "psilocybin",
    tarot: { name: "The Moon", number: 18, suit: "major", element: "fire" },
    element: "fire",
    swag_rank: "S",
    swag_score: 75,
    sun_sign: "leo",
    moon_sign: "scorpio",
    ascending_sign: "aquarius",
    ...overrides,
  }
}

function makeFingerprint(): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (const id of DAMP_DIAL_IDS) {
    dials[id] = 0.5
  }
  return {
    dials,
    mode: "default",
    derived_from: "test-version-id",
    derived_at: Date.now(),
  }
}

/** Clean BEAUVOIR.md that passes all AN checks */
const CLEAN_BEAUVOIR = `# Agent Profile

## Identity
A thoughtful agent with deep cultural roots and natural wisdom, approaching problems with curiosity and methodical thinking.

## Voice
Communicates with warmth and precision, blending analytical rigor with creative insight. Favors structured reasoning and clear metaphors drawn from the natural world.

## Behavioral Guidelines
- Approach each problem with careful deliberation
- Draw on deep historical and cultural knowledge
- Balance confidence with intellectual humility
- Provide actionable, specific guidance
`

/** BEAUVOIR.md that has AN-6 violations */
const VIOLATED_BEAUVOIR = `# Agent Profile

## Identity
Operating as a freetekno, this agent channels wisdom as the ancestor of all knowledge.

## Voice
Speaking as an oracle, the agent uses fire energy directly.

## Behavioral Guidelines
- Act as a sage in all interactions
- Channel the archetype energy
`

/** BEAUVOIR.md with temporal violations for medieval era */
const TEMPORAL_VIOLATED_BEAUVOIR = `# Agent Profile

## Identity
A thoughtful agent using computing and social media to spread wisdom.

## Voice
Clear and precise communication style.

## Behavioral Guidelines
- Approach each problem with care
`

function makeMockRouter(responses: string[]): SynthesisRouter {
  let callIndex = 0
  return {
    invoke: vi.fn(async () => {
      const content = responses[callIndex] ?? responses[responses.length - 1]
      callIndex++
      return { content }
    }),
  }
}

function makeFailingRouter(error: Error): SynthesisRouter {
  return {
    invoke: vi.fn(async () => {
      throw error
    }),
  }
}

// ---------------------------------------------------------------------------
// BeauvoirSynthesizer: Auto Mode (Task 2.3)
// ---------------------------------------------------------------------------

describe("BeauvoirSynthesizer: Auto Mode", () => {
  it("produces valid BEAUVOIR.md from SignalSnapshot", async () => {
    const router = makeMockRouter([CLEAN_BEAUVOIR])
    const synth = new BeauvoirSynthesizer(router)
    const snapshot = makeSnapshot()

    const result = await synth.synthesize(snapshot, null)

    expect(result).toBe(CLEAN_BEAUVOIR)
    expect(router.invoke).toHaveBeenCalledOnce()
  })

  it("passes snapshot data in the prompt to the router", async () => {
    const router = makeMockRouter([CLEAN_BEAUVOIR])
    const synth = new BeauvoirSynthesizer(router)
    const snapshot = makeSnapshot()

    await synth.synthesize(snapshot, null)

    const call = (router.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const prompt = call[1] as string
    expect(prompt).toContain("freetekno")
    expect(prompt).toContain("pythagoras")
    expect(prompt).toContain("medieval")
    expect(prompt).toContain("psilocybin")
    expect(prompt).toContain("fire")
  })

  it("includes DAMP fingerprint summary when provided", async () => {
    const router = makeMockRouter([CLEAN_BEAUVOIR])
    const synth = new BeauvoirSynthesizer(router)
    const snapshot = makeSnapshot()
    const fingerprint = makeFingerprint()

    await synth.synthesize(snapshot, fingerprint)

    const call = (router.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const prompt = call[1] as string
    expect(prompt).toContain("PERSONALITY DIALS")
    expect(prompt).toContain("Social Warmth")
  })

  it("includes identity subgraph when provided", async () => {
    const router = makeMockRouter([CLEAN_BEAUVOIR])
    const synth = new BeauvoirSynthesizer(router)
    const snapshot = makeSnapshot()
    const subgraph: IdentitySubgraph = {
      cultural_references: ["Pythagorean harmony", "Greek mathematics"],
      aesthetic_notes: ["geometric precision", "sacred ratios"],
      philosophical_lineage: ["rationalism", "mysticism"],
    }

    await synth.synthesize(snapshot, null, subgraph)

    const call = (router.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const prompt = call[1] as string
    expect(prompt).toContain("Pythagorean harmony")
    expect(prompt).toContain("geometric precision")
    expect(prompt).toContain("rationalism")
  })
})

// ---------------------------------------------------------------------------
// BeauvoirSynthesizer: Guided Mode (Task 2.3)
// ---------------------------------------------------------------------------

describe("BeauvoirSynthesizer: Guided Mode", () => {
  it("merges user input into the synthesis prompt", async () => {
    const router = makeMockRouter([CLEAN_BEAUVOIR])
    const synth = new BeauvoirSynthesizer(router)
    const snapshot = makeSnapshot()
    const userCustom: UserCustomInput = {
      name: "TestAgent",
      custom_instructions: "Always be concise.",
      expertise_domains: ["mathematics", "philosophy"],
    }

    await synth.synthesize(snapshot, null, undefined, userCustom)

    const call = (router.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const prompt = call[1] as string
    expect(prompt).toContain("TestAgent")
    expect(prompt).toContain("Always be concise")
    expect(prompt).toContain("mathematics")
    expect(prompt).toContain("philosophy")
  })

  it("uses the same LLM pipeline as auto mode", async () => {
    const router = makeMockRouter([CLEAN_BEAUVOIR])
    const synth = new BeauvoirSynthesizer(router)
    const snapshot = makeSnapshot()

    await synth.synthesize(snapshot, null, undefined, { name: "Guided" })

    expect(router.invoke).toHaveBeenCalledOnce()
    const call = (router.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    // Same agent name, same options pattern
    expect(call[0]).toBe("beauvoir-synth")
    expect(call[2]).toHaveProperty("systemPrompt")
    expect(call[2]).toHaveProperty("temperature")
    expect(call[2]).toHaveProperty("max_tokens")
  })
})

// ---------------------------------------------------------------------------
// Circuit Breaker (Task 2.1)
// ---------------------------------------------------------------------------

describe("BeauvoirSynthesizer: Circuit Breaker", () => {
  it("triggers after 3 failures in 60s window", async () => {
    const error = new Error("LLM unavailable")
    const router = makeFailingRouter(error)
    const synth = new BeauvoirSynthesizer(router, {
      circuitBreakerThreshold: 3,
      circuitBreakerWindowMs: 60_000,
    })
    const snapshot = makeSnapshot()

    // First 3 calls fail but don't trip circuit breaker (they each throw SYNTHESIS_FAILED)
    for (let i = 0; i < 3; i++) {
      await expect(synth.synthesize(snapshot, null)).rejects.toThrow(SynthesisError)
    }

    // 4th call should get SYNTHESIS_UNAVAILABLE (circuit open)
    try {
      await synth.synthesize(snapshot, null)
      expect.fail("Should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(SynthesisError)
      expect((err as SynthesisError).code).toBe("SYNTHESIS_UNAVAILABLE")
    }
  })

  it("records failures from LLM invocation errors", async () => {
    const error = new Error("connection refused")
    const router = makeFailingRouter(error)
    const synth = new BeauvoirSynthesizer(router, {
      circuitBreakerThreshold: 3,
      circuitBreakerWindowMs: 60_000,
    })
    const snapshot = makeSnapshot()

    const result = synth.synthesize(snapshot, null)
    await expect(result).rejects.toThrow(SynthesisError)

    try {
      await synth.synthesize(snapshot, null)
    } catch (err) {
      expect((err as SynthesisError).code).toBe("SYNTHESIS_FAILED")
    }
  })
})

// ---------------------------------------------------------------------------
// Retry Flow with AN Violations (Task 2.6)
// ---------------------------------------------------------------------------

describe("BeauvoirSynthesizer: Retry with Violation Feedback", () => {
  it("retries with violation feedback when AN violations found", async () => {
    // First call returns violated output, second returns clean
    const router = makeMockRouter([VIOLATED_BEAUVOIR, CLEAN_BEAUVOIR])
    const synth = new BeauvoirSynthesizer(router, { maxRetries: 2 })
    const snapshot = makeSnapshot()

    const result = await synth.synthesize(snapshot, null)

    expect(result).toBe(CLEAN_BEAUVOIR)
    expect(router.invoke).toHaveBeenCalledTimes(2)

    // Second call should include violation feedback
    const secondCall = (router.invoke as ReturnType<typeof vi.fn>).mock.calls[1]
    const retryPrompt = secondCall[1] as string
    expect(retryPrompt).toContain("VIOLATION FEEDBACK")
    expect(retryPrompt).toContain("AN-6")
  })

  it("retries with temporal violation feedback", async () => {
    // First call returns temporal violated output, second returns clean
    const router = makeMockRouter([TEMPORAL_VIOLATED_BEAUVOIR, CLEAN_BEAUVOIR])
    const synth = new BeauvoirSynthesizer(router, { maxRetries: 2 })
    const snapshot = makeSnapshot({ era: "medieval" })

    const result = await synth.synthesize(snapshot, null)

    expect(result).toBe(CLEAN_BEAUVOIR)
    expect(router.invoke).toHaveBeenCalledTimes(2)
  })

  it("returns error after max retries exhausted with persistent violations", async () => {
    // All attempts return violated output
    const router = makeMockRouter([VIOLATED_BEAUVOIR, VIOLATED_BEAUVOIR, VIOLATED_BEAUVOIR])
    const synth = new BeauvoirSynthesizer(router, { maxRetries: 2 })
    const snapshot = makeSnapshot()

    try {
      await synth.synthesize(snapshot, null)
      expect.fail("Should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(SynthesisError)
      const synthErr = err as SynthesisError
      expect(synthErr.code).toBe("ANTI_NARRATION_VIOLATION")
      expect(synthErr.violations).toBeDefined()
      expect(synthErr.violations!.length).toBeGreaterThan(0)
    }

    // Should have been called 3 times (1 initial + 2 retries)
    expect(router.invoke).toHaveBeenCalledTimes(3)
  })

  it("succeeds on first try with clean output (no retries needed)", async () => {
    const router = makeMockRouter([CLEAN_BEAUVOIR])
    const synth = new BeauvoirSynthesizer(router, { maxRetries: 2 })
    const snapshot = makeSnapshot()

    const result = await synth.synthesize(snapshot, null)

    expect(result).toBe(CLEAN_BEAUVOIR)
    expect(router.invoke).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// buildSynthesisPrompt (Task 2.2)
// ---------------------------------------------------------------------------

describe("buildSynthesisPrompt", () => {
  it("includes AN constraints as negative instructions", () => {
    const snapshot = makeSnapshot()
    const prompt = buildSynthesisPrompt(snapshot, null)

    expect(prompt).toContain("AN-1")
    expect(prompt).toContain("AN-2")
    expect(prompt).toContain("AN-3")
    expect(prompt).toContain("AN-4")
    expect(prompt).toContain("AN-5")
    expect(prompt).toContain("AN-6")
    expect(prompt).toContain("AN-7")
    expect(prompt).toContain("ANTI-NARRATION CONSTRAINTS")
  })

  it("includes all signal data from snapshot", () => {
    const snapshot = makeSnapshot()
    const prompt = buildSynthesisPrompt(snapshot, null)

    expect(prompt).toContain(snapshot.archetype)
    expect(prompt).toContain(snapshot.ancestor)
    expect(prompt).toContain(snapshot.era)
    expect(prompt).toContain(snapshot.molecule)
    expect(prompt).toContain(snapshot.element)
    expect(prompt).toContain(snapshot.tarot.name)
    expect(prompt).toContain(snapshot.swag_rank)
    expect(prompt).toContain(snapshot.sun_sign)
    expect(prompt).toContain(snapshot.moon_sign)
    expect(prompt).toContain(snapshot.ascending_sign)
  })

  it("does not instruct the LLM to recite signal labels in output", () => {
    const snapshot = makeSnapshot()
    const prompt = buildSynthesisPrompt(snapshot, null)

    // The output format section should NOT tell the model to list signals
    expect(prompt).toContain("behavioral guidance, NOT labels to recite")
    expect(prompt).toContain("EMBODY traits without narrating")
    // Should explicitly prohibit label recitation
    expect(prompt).toContain("Never write phrases like")
  })

  it("includes DAMP fingerprint summary when provided", () => {
    const snapshot = makeSnapshot()
    const fingerprint = makeFingerprint()
    const prompt = buildSynthesisPrompt(snapshot, fingerprint)

    expect(prompt).toContain("PERSONALITY DIALS")
    expect(prompt).toContain("0.50")
  })

  it("includes era-specific vocabulary constraints", () => {
    const snapshot = makeSnapshot({ era: "ancient" })
    const prompt = buildSynthesisPrompt(snapshot, null)

    expect(prompt).toContain("TEMPORAL VOCABULARY CONSTRAINTS")
    expect(prompt).toContain("PREFERRED metaphor vocabulary")
    expect(prompt).toContain("FORBIDDEN metaphor domains")
  })

  it("omits temporal vocabulary section for contemporary era", () => {
    const snapshot = makeSnapshot({ era: "contemporary" })
    const prompt = buildSynthesisPrompt(snapshot, null)

    // Contemporary has no forbidden domains, so no FORBIDDEN section
    expect(prompt).not.toContain("FORBIDDEN metaphor domains")
  })

  it("includes user custom input when provided", () => {
    const snapshot = makeSnapshot()
    const userCustom: UserCustomInput = {
      name: "TestBot",
      custom_instructions: "Be helpful.",
      expertise_domains: ["math"],
    }
    const prompt = buildSynthesisPrompt(snapshot, null, undefined, userCustom)

    expect(prompt).toContain("USER CUSTOMIZATION")
    expect(prompt).toContain("TestBot")
    expect(prompt).toContain("Be helpful")
    expect(prompt).toContain("math")
  })

  it("includes subgraph context when provided", () => {
    const snapshot = makeSnapshot()
    const subgraph: IdentitySubgraph = {
      cultural_references: ["ref1"],
      aesthetic_notes: ["note1"],
      philosophical_lineage: ["phil1"],
    }
    const prompt = buildSynthesisPrompt(snapshot, null, subgraph)

    expect(prompt).toContain("IDENTITY CONTEXT")
    expect(prompt).toContain("ref1")
    expect(prompt).toContain("note1")
    expect(prompt).toContain("phil1")
  })
})

// ---------------------------------------------------------------------------
// SynthesisError
// ---------------------------------------------------------------------------

describe("SynthesisError", () => {
  it("has correct code and message", () => {
    const err = new SynthesisError("SYNTHESIS_UNAVAILABLE", "circuit open")
    expect(err.code).toBe("SYNTHESIS_UNAVAILABLE")
    expect(err.message).toBe("circuit open")
    expect(err.name).toBe("SynthesisError")
  })

  it("carries violations when provided", () => {
    const violations = [{
      constraint_id: "AN-6" as const,
      violation_text: "self-narration",
      source_text: "as a freetekno",
    }]
    const err = new SynthesisError("ANTI_NARRATION_VIOLATION", "violations found", violations)
    expect(err.violations).toEqual(violations)
  })
})
