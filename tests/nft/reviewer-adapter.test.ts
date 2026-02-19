// tests/nft/reviewer-adapter.test.ts — PersonalityReviewerAdapter Tests (Sprint 29 Task 29.3)
//
// Tests: anti-narration golden test (Cypherpunk -> no identity labels in output),
// schema validation, emphasis derivation, flatline bridge integration.

import { describe, it, expect } from "vitest"
import {
  PersonalityReviewerAdapter,
  checkAntiNarration,
  deriveEmphasis,
} from "../../src/nft/reviewer-adapter.js"
import type {
  PersonalityReviewInput,
  ReviewerPerspective,
  ReviewEmphasis,
} from "../../src/nft/reviewer-adapter.js"
import {
  injectPersonalityPerspective,
  validatePersonalityFlatlineConfig,
  createDefaultFlatlineConfig,
} from "../../src/nft/flatline-bridge.js"
import type { DAMPFingerprint, DAMPDialId } from "../../src/nft/signal-types.js"
import { DAMP_DIAL_IDS } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeFingerprint(overrides?: Partial<Record<DAMPDialId, number>>): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (const id of DAMP_DIAL_IDS) {
    dials[id] = 0.5
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      dials[key as DAMPDialId] = value
    }
  }
  return {
    dials,
    mode: "default",
    derived_from: "test-sha",
    derived_at: Date.now(),
  }
}

function makeCypherpunkInput(fingerprint?: DAMPFingerprint | null): PersonalityReviewInput {
  return {
    personality_id: "honeybears:42",
    archetype: "freetekno",
    ancestor: "cypherpunk",
    era: "contemporary",
    element: "air",
    fingerprint: fingerprint ?? makeFingerprint(),
  }
}

function makeMiladyInput(): PersonalityReviewInput {
  return {
    personality_id: "bears:99",
    archetype: "milady",
    ancestor: "japanese_aesthetic",
    era: "modern",
    element: "water",
    fingerprint: makeFingerprint(),
  }
}

function makeChicagoDetroitInput(): PersonalityReviewInput {
  return {
    personality_id: "bears:77",
    archetype: "chicago_detroit",
    ancestor: "yoruba_babalawo",
    era: "medieval",
    element: "earth",
    fingerprint: makeFingerprint(),
  }
}

function makeAcidhouseInput(): PersonalityReviewInput {
  return {
    personality_id: "bears:55",
    archetype: "acidhouse",
    ancestor: "sufi_mystic",
    era: "ancient",
    element: "fire",
    fingerprint: makeFingerprint(),
  }
}

// ---------------------------------------------------------------------------
// GOLDEN TEST: Anti-Narration — Cypherpunk Input
// ---------------------------------------------------------------------------

describe("GOLDEN TEST: Anti-narration — Cypherpunk input", () => {
  const adapter = new PersonalityReviewerAdapter()

  it("Cypherpunk input MUST NOT produce 'Cypherpunk' in system_prompt_fragment", () => {
    const input = makeCypherpunkInput()
    const perspective = adapter.buildPerspective(input)

    const lower = perspective.system_prompt_fragment.toLowerCase()
    expect(lower).not.toContain("cypherpunk")
  })

  it("Cypherpunk input MUST NOT produce 'archetype' in system_prompt_fragment", () => {
    const input = makeCypherpunkInput()
    const perspective = adapter.buildPerspective(input)

    const lower = perspective.system_prompt_fragment.toLowerCase()
    expect(lower).not.toContain("archetype")
  })

  it("Cypherpunk input MUST NOT produce 'ancestor' in system_prompt_fragment", () => {
    const input = makeCypherpunkInput()
    const perspective = adapter.buildPerspective(input)

    const lower = perspective.system_prompt_fragment.toLowerCase()
    expect(lower).not.toContain("ancestor")
  })

  it("Cypherpunk input MUST NOT produce 'freetekno' in system_prompt_fragment", () => {
    const input = makeCypherpunkInput()
    const perspective = adapter.buildPerspective(input)

    const lower = perspective.system_prompt_fragment.toLowerCase()
    expect(lower).not.toContain("freetekno")
  })

  it("system_prompt_fragment is non-empty and contains behavioral guidance", () => {
    const input = makeCypherpunkInput()
    const perspective = adapter.buildPerspective(input)

    expect(perspective.system_prompt_fragment.length).toBeGreaterThan(50)
    // Should contain behavioral language, not identity labels
    expect(perspective.system_prompt_fragment.toLowerCase()).toContain("decentralization")
  })
})

// ---------------------------------------------------------------------------
// Anti-Narration: All Archetypes
// ---------------------------------------------------------------------------

describe("Anti-narration across all archetypes", () => {
  const adapter = new PersonalityReviewerAdapter()

  const inputs = [
    { name: "freetekno/cypherpunk", input: makeCypherpunkInput() },
    { name: "milady/japanese_aesthetic", input: makeMiladyInput() },
    { name: "chicago_detroit/yoruba_babalawo", input: makeChicagoDetroitInput() },
    { name: "acidhouse/sufi_mystic", input: makeAcidhouseInput() },
  ]

  for (const { name, input } of inputs) {
    it(`${name}: no forbidden terms in system_prompt_fragment`, () => {
      const perspective = adapter.buildPerspective(input)
      const violations = checkAntiNarration(perspective.system_prompt_fragment)
      expect(violations).toEqual([])
    })

    it(`${name}: no archetype label in output`, () => {
      const perspective = adapter.buildPerspective(input)
      const lower = perspective.system_prompt_fragment.toLowerCase()
      expect(lower).not.toContain(input.archetype.toLowerCase())
    })

    it(`${name}: no ancestor name in output`, () => {
      const perspective = adapter.buildPerspective(input)
      const lower = perspective.system_prompt_fragment.toLowerCase()
      // Check both underscore and space variants
      expect(lower).not.toContain(input.ancestor.toLowerCase())
      expect(lower).not.toContain(input.ancestor.toLowerCase().replace(/_/g, " "))
    })
  }
})

// ---------------------------------------------------------------------------
// Anti-Narration: checkAntiNarration function
// ---------------------------------------------------------------------------

describe("checkAntiNarration", () => {
  it("detects archetype labels", () => {
    const violations = checkAntiNarration("This is a freetekno approach")
    expect(violations).toContain("freetekno")
  })

  it("detects ancestor names", () => {
    const violations = checkAntiNarration("Channeling pythagoras wisdom")
    expect(violations).toContain("pythagoras")
  })

  it("detects system terms", () => {
    const violations = checkAntiNarration("Based on dAMP dial values")
    expect(violations.length).toBeGreaterThan(0)
  })

  it("returns empty array for clean text", () => {
    const violations = checkAntiNarration(
      "Prioritizes analytical rigor and evidence-based reasoning. " +
      "Values practical solutions and clear communication.",
    )
    expect(violations).toEqual([])
  })

  it("case insensitive detection", () => {
    expect(checkAntiNarration("MILADY style")).toContain("milady")
    expect(checkAntiNarration("AcIdHoUsE vibe")).toContain("acidhouse")
  })
})

// ---------------------------------------------------------------------------
// ReviewerPerspective Schema Validation
// ---------------------------------------------------------------------------

describe("ReviewerPerspective schema", () => {
  const adapter = new PersonalityReviewerAdapter()

  it("has required fields populated", () => {
    const input = makeCypherpunkInput()
    const perspective = adapter.buildPerspective(input)

    expect(perspective.perspective_id).toBe("personality:honeybears:42")
    expect(perspective.label).toContain("honeybears:42")
    expect(perspective.system_prompt_fragment).toBeTruthy()
    expect(perspective.emphasis).toBeTruthy()
  })

  it("emphasis has all 5 dimensions", () => {
    const input = makeCypherpunkInput()
    const perspective = adapter.buildPerspective(input)

    expect(typeof perspective.emphasis.correctness).toBe("number")
    expect(typeof perspective.emphasis.creativity).toBe("number")
    expect(typeof perspective.emphasis.pragmatism).toBe("number")
    expect(typeof perspective.emphasis.security).toBe("number")
    expect(typeof perspective.emphasis.clarity).toBe("number")
  })

  it("emphasis values are in [0, 1]", () => {
    const input = makeCypherpunkInput()
    const perspective = adapter.buildPerspective(input)

    for (const value of Object.values(perspective.emphasis)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Emphasis Derivation
// ---------------------------------------------------------------------------

describe("Emphasis derivation from dAMP", () => {
  it("returns balanced defaults when fingerprint is null", () => {
    const emphasis = deriveEmphasis(null)

    expect(emphasis.correctness).toBe(0.5)
    expect(emphasis.creativity).toBe(0.5)
    expect(emphasis.pragmatism).toBe(0.5)
    expect(emphasis.security).toBe(0.5)
    expect(emphasis.clarity).toBe(0.5)
  })

  it("high analytical dials increase correctness emphasis", () => {
    const fp = makeFingerprint({
      cg_analytical_intuitive: 0.9,
      cg_detail_orientation: 0.9,
      ep_evidence_threshold: 0.9,
      ep_first_principles: 0.9,
    })
    const emphasis = deriveEmphasis(fp)

    expect(emphasis.correctness).toBeGreaterThan(0.7)
  })

  it("high creativity dials increase creativity emphasis", () => {
    const fp = makeFingerprint({
      cr_divergent_thinking: 0.95,
      cr_originality_drive: 0.95,
      cr_experimentation_bias: 0.95,
      cr_playfulness: 0.95,
    })
    const emphasis = deriveEmphasis(fp)

    expect(emphasis.creativity).toBeGreaterThan(0.8)
  })

  it("high pragmatism dials increase pragmatism emphasis", () => {
    const fp = makeFingerprint({
      cv_feasibility_weight: 0.9,
      cv_pragmatism: 0.9,
      cv_scope_discipline: 0.9,
      cv_decision_speed: 0.9,
    })
    const emphasis = deriveEmphasis(fp)

    expect(emphasis.pragmatism).toBeGreaterThan(0.7)
  })

  it("low risk tolerance increases security emphasis", () => {
    const fp = makeFingerprint({
      ep_evidence_threshold: 0.9,
      as_boundary_setting: 0.9,
      ag_risk_tolerance: 0.1, // Low risk tolerance = high security
    })
    const emphasis = deriveEmphasis(fp)

    expect(emphasis.security).toBeGreaterThan(0.7)
  })

  it("high directness + low verbosity increases clarity emphasis", () => {
    const fp = makeFingerprint({
      cs_directness: 0.9,
      cs_verbosity: 0.1, // Low verbosity = high clarity
      id_narrative_coherence: 0.9,
    })
    const emphasis = deriveEmphasis(fp)

    expect(emphasis.clarity).toBeGreaterThan(0.7)
  })
})

// ---------------------------------------------------------------------------
// Null Fingerprint Handling
// ---------------------------------------------------------------------------

describe("Null fingerprint handling", () => {
  it("produces valid perspective with null fingerprint", () => {
    const adapter = new PersonalityReviewerAdapter()
    const input: PersonalityReviewInput = {
      personality_id: "test:null-fp",
      archetype: "freetekno",
      ancestor: "cypherpunk",
      era: "contemporary",
      element: "air",
      fingerprint: null,
    }

    const perspective = adapter.buildPerspective(input)

    expect(perspective.system_prompt_fragment).toBeTruthy()
    expect(perspective.emphasis.correctness).toBe(0.5)
    expect(perspective.emphasis.creativity).toBe(0.5)
    // Anti-narration still enforced
    const violations = checkAntiNarration(perspective.system_prompt_fragment)
    expect(violations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Flatline Bridge Integration
// ---------------------------------------------------------------------------

describe("Flatline bridge integration", () => {
  const adapter = new PersonalityReviewerAdapter()

  it("injects perspective into flatline config", () => {
    const perspective = adapter.buildPerspective(makeCypherpunkInput())
    const baseConfig = createDefaultFlatlineConfig()

    const result = injectPersonalityPerspective(baseConfig, perspective)

    expect(result.perspective_injected).toBe(true)
    expect(result.perspective_id).toBe(perspective.perspective_id)
    expect(result.config.personality_perspective).toBe(perspective)
    expect(result.config.system_prompt_additions).toContain(perspective.system_prompt_fragment)
  })

  it("null perspective does not modify config", () => {
    const baseConfig = createDefaultFlatlineConfig()

    const result = injectPersonalityPerspective(baseConfig, null)

    expect(result.perspective_injected).toBe(false)
    expect(result.perspective_id).toBeNull()
    expect(result.config.personality_perspective).toBeNull()
  })

  it("preserves existing system_prompt_additions", () => {
    const baseConfig = createDefaultFlatlineConfig()
    baseConfig.system_prompt_additions = ["Existing addition"]

    const perspective = adapter.buildPerspective(makeMiladyInput())
    const result = injectPersonalityPerspective(baseConfig, perspective)

    expect(result.config.system_prompt_additions).toContain("Existing addition")
    expect(result.config.system_prompt_additions).toContain(perspective.system_prompt_fragment)
  })

  it("injected fragment passes anti-narration check", () => {
    const perspective = adapter.buildPerspective(makeChicagoDetroitInput())
    const baseConfig = createDefaultFlatlineConfig()
    const result = injectPersonalityPerspective(baseConfig, perspective)

    // Check every system_prompt_addition for forbidden terms
    for (const addition of result.config.system_prompt_additions ?? []) {
      const violations = checkAntiNarration(addition)
      expect(violations).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// Flatline Config Validation
// ---------------------------------------------------------------------------

describe("Flatline config validation", () => {
  it("valid config returns no errors", () => {
    const config = createDefaultFlatlineConfig()
    const errors = validatePersonalityFlatlineConfig(config)
    expect(errors).toEqual([])
  })

  it("empty models array is invalid", () => {
    const config = createDefaultFlatlineConfig([])
    config.models = []
    const errors = validatePersonalityFlatlineConfig(config)
    expect(errors.length).toBeGreaterThan(0)
  })

  it("consensus_threshold > 1 is invalid", () => {
    const config = createDefaultFlatlineConfig()
    config.consensus_threshold = 1.5
    const errors = validatePersonalityFlatlineConfig(config)
    expect(errors.some(e => e.includes("consensus_threshold"))).toBe(true)
  })

  it("max_iterations < 1 is invalid", () => {
    const config = createDefaultFlatlineConfig()
    config.max_iterations = 0
    const errors = validatePersonalityFlatlineConfig(config)
    expect(errors.some(e => e.includes("max_iterations"))).toBe(true)
  })

  it("personality_perspective with empty fragment is invalid", () => {
    const config = createDefaultFlatlineConfig()
    config.personality_perspective = {
      perspective_id: "test",
      label: "Test",
      system_prompt_fragment: "",
      emphasis: { correctness: 0.5, creativity: 0.5, pragmatism: 0.5, security: 0.5, clarity: 0.5 },
    }
    const errors = validatePersonalityFlatlineConfig(config)
    expect(errors.some(e => e.includes("system_prompt_fragment"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Default Flatline Config
// ---------------------------------------------------------------------------

describe("Default flatline config", () => {
  it("has sensible defaults", () => {
    const config = createDefaultFlatlineConfig()

    expect(config.models).toEqual(["claude-sonnet-4", "gpt-4.1"])
    expect(config.consensus_threshold).toBe(0.7)
    expect(config.max_iterations).toBe(3)
    expect(config.personality_perspective).toBeNull()
  })

  it("accepts custom models", () => {
    const config = createDefaultFlatlineConfig(["custom-model"])
    expect(config.models).toEqual(["custom-model"])
  })
})
