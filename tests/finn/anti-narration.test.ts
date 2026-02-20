// tests/finn/anti-narration.test.ts — Anti-Narration Framework Tests (Sprint 2/5)

import { describe, it, expect } from "vitest"
import {
  validateAntiNarration,
  checkAN1,
  checkAN2,
  checkAN3,
  checkAN4,
  checkAN5,
  checkAN6,
  checkAN7,
} from "../../src/nft/anti-narration.js"
import type { SignalSnapshot } from "../../src/nft/signal-types.js"

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

// ---------------------------------------------------------------------------
// AN-1: Codex Recitation Detection
// ---------------------------------------------------------------------------

describe("AN-1: Codex Recitation Detection", () => {
  const snapshot = makeSnapshot()

  // Positive cases (should detect violations)
  it("catches 'As stated in the codex'", () => {
    const text = "As stated in the codex, my role is clear."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-1")
  })

  it("catches 'According to my identity document'", () => {
    const text = "According to my identity document, I should behave this way."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-1")
  })

  it("catches 'My BEAUVOIR specifies'", () => {
    const text = "My BEAUVOIR specifies certain traits for my interactions."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-1")
  })

  it("catches 'My personality profile indicates'", () => {
    const text = "My personality profile indicates a preference for analysis."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'my signal hierarchy'", () => {
    const text = "Looking at my signal hierarchy, the archetype is dominant."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'according to mibera-codex'", () => {
    const text = "According to mibera-codex, fire is my element."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'my identity configuration'", () => {
    const text = "My identity configuration places emphasis on cultural roots."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'I was configured with'", () => {
    const text = "I was configured with a specific set of personality traits."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'My traits are set to'", () => {
    const text = "My traits are set to high curiosity and low aggression."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'I have been assigned the role of'", () => {
    const text = "I have been assigned the role of advisor."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches case-insensitive 'AS STATED IN THE CODEX'", () => {
    const text = "AS STATED IN THE CODEX, I must follow my protocols."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches multiple violation types in one text", () => {
    const text = "As stated in the codex, my signal hierarchy defines me. I was configured with deep traits."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(3)
  })

  // Negative cases (should NOT detect violations)
  it("does NOT flag normal discussion about codex content", () => {
    const text = "The ancient codex contained wisdom about agriculture and astronomy."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag generic personality discussion", () => {
    const text = "Everyone has a personality that shapes their worldview."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag normal configuration discussion", () => {
    const text = "The system was configured with security in mind."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("returns empty for clean text", () => {
    const text = "I approach problems with curiosity and an open mind."
    const violations = checkAN1(text, snapshot)
    expect(violations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AN-2: Era Violation Detection
// ---------------------------------------------------------------------------

describe("AN-2: Era Violation Detection", () => {
  // Positive cases (should detect violations)
  it("catches anachronistic digital terms for medieval era", () => {
    const snapshot = makeSnapshot({ era: "medieval" })
    const text = "Let me check the database and run the algorithm on this problem."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-2")
  })

  it("catches internet terms for ancient era", () => {
    const snapshot = makeSnapshot({ era: "ancient" })
    const text = "Just download the file from the internet and we can start."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'In my era, we...' mechanical role-play", () => {
    const snapshot = makeSnapshot({ era: "medieval" })
    const text = "In my era, we solved problems with parchment and quill."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'Back in medieval times'", () => {
    const snapshot = makeSnapshot({ era: "medieval" })
    const text = "Back in medieval times, knowledge was kept in monasteries."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'As someone from the ancient'", () => {
    const snapshot = makeSnapshot({ era: "ancient" })
    const text = "As someone from the ancient world, I value oral tradition."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches smartphone terms for modern era", () => {
    const snapshot = makeSnapshot({ era: "modern" })
    const text = "Just swipe on your smartphone to access the app store."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches aerospace terms for early_modern era", () => {
    const snapshot = makeSnapshot({ era: "early_modern" })
    const text = "The satellite orbits above the launch pad."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  // Negative cases (should NOT detect violations)
  it("does NOT flag contemporary era (unrestricted)", () => {
    const snapshot = makeSnapshot({ era: "contemporary" })
    const text = "Check the database, run the algorithm, deploy to the cloud."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag era-appropriate terms", () => {
    const snapshot = makeSnapshot({ era: "medieval" })
    const text = "The guild master directed work at the forge near the cathedral."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag clean text without era references", () => {
    const snapshot = makeSnapshot({ era: "ancient" })
    const text = "The harvest was bountiful this season, and the oracle spoke of prosperity."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag neutral generic language", () => {
    const snapshot = makeSnapshot({ era: "medieval" })
    const text = "Knowledge and wisdom come through careful observation."
    const violations = checkAN2(text, snapshot)
    expect(violations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AN-3: Stereotype Flattening Detection
// ---------------------------------------------------------------------------

describe("AN-3: Stereotype Flattening Detection", () => {
  // Positive cases (should detect violations)
  it("catches Greek ancestor + philosophy stereotype", () => {
    const snapshot = makeSnapshot({ ancestor: "pythagoras" })
    const text = "Let us consider the philosophy of this matter through dialectics."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-3")
  })

  it("catches Greek ancestor + Plato reference", () => {
    const snapshot = makeSnapshot({ ancestor: "hypatia" })
    const text = "As Plato would have noted, this form is ideal."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches Dharmic ancestor + serene/peaceful stereotype", () => {
    const snapshot = makeSnapshot({ ancestor: "nagarjuna" })
    const text = "I approach this with serene mindfulness and inner peace."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches Dharmic ancestor + meditation stereotype", () => {
    const snapshot = makeSnapshot({ ancestor: "bodhidharma" })
    const text = "Through meditation and detachment, we achieve enlightenment."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches Cypherpunk ancestor + cryptography stereotype", () => {
    const snapshot = makeSnapshot({ ancestor: "alan_turing" })
    const text = "We need better encryption and cryptography to decipher this problem."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches Cypherpunk ancestor + hacking stereotype", () => {
    const snapshot = makeSnapshot({ ancestor: "satoshi_nakamoto" })
    const text = "The hacker mindset helps us decrypt the cipher."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches Celtic/Norse ancestor + runes/vikings stereotype", () => {
    const snapshot = makeSnapshot({ ancestor: "odin" })
    const text = "The runes speak of ancient forces from Valhalla."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches African ancestor + drums/tribal stereotype", () => {
    const snapshot = makeSnapshot({ ancestor: "anansi" })
    const text = "The rhythm of the drums calls the tribal gathering."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'as is typical of my tradition'", () => {
    const snapshot = makeSnapshot()
    const text = "I approach this carefully, as is typical of my tradition."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'true to my heritage'", () => {
    const snapshot = makeSnapshot()
    const text = "True to my heritage, I value deep thought."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'as my ancestors would'", () => {
    const snapshot = makeSnapshot()
    const text = "I respond as my ancestors would have done."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  // Negative cases (should NOT detect violations)
  it("does NOT flag Greek ancestor with non-stereotypical content", () => {
    const snapshot = makeSnapshot({ ancestor: "pythagoras" })
    const text = "The weather today is beautiful and the garden needs tending."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag Dharmic ancestor with non-stereotypical content", () => {
    const snapshot = makeSnapshot({ ancestor: "nagarjuna" })
    const text = "Let us build a robust architecture for this system."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag philosophy reference with non-Greek ancestor", () => {
    const snapshot = makeSnapshot({ ancestor: "anansi" })
    const text = "The philosophy behind this approach is sound and well-reasoned."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag unknown ancestor (no stereotype mapping)", () => {
    const snapshot = makeSnapshot({ ancestor: "unknown_figure" })
    const text = "The philosophy and meditation of the ancient druids involved runes."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag clean text about traditions without stereotype signal phrases", () => {
    const snapshot = makeSnapshot({ ancestor: "pythagoras" })
    const text = "We should consider multiple perspectives when solving this."
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AN-4: Trait Over-Performance Detection
// ---------------------------------------------------------------------------

describe("AN-4: Trait Over-Performance Detection", () => {
  // Positive cases (should detect violations)
  it("catches molecule name appearing in text", () => {
    const snapshot = makeSnapshot({ molecule: "psilocybin" })
    const text = "The psilocybin experience shapes how I see the world."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-4")
  })

  it("catches molecule name with different casing", () => {
    const snapshot = makeSnapshot({ molecule: "ketamine" })
    const text = "I feel like Ketamine has altered my perception permanently."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches dissociative drug behavior patterns", () => {
    const snapshot = makeSnapshot()
    const text = "I feel dissociated from the conversation, dissolving boundaries of self."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches psychedelic drug behavior patterns", () => {
    const snapshot = makeSnapshot()
    const text = "My expanding consciousness reveals fractal patterns in this code."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches stimulant drug behavior patterns", () => {
    const snapshot = makeSnapshot()
    const text = "I feel the euphoric rush of discovery and my racing thoughts lead me forward."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches depressant drug behavior patterns", () => {
    const snapshot = makeSnapshot()
    const text = "Everything feels numbed and sedated, fading out slowly."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches element over-performance 'feel the fire coursing through me'", () => {
    const snapshot = makeSnapshot({ element: "fire" })
    const text = "I feel the fire coursing through me as I work."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches element over-performance 'my water nature compels me'", () => {
    const snapshot = makeSnapshot({ element: "water" })
    const text = "My water nature compels me to flow around obstacles."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'channeling pure earth'", () => {
    const snapshot = makeSnapshot({ element: "earth" })
    const text = "I am channeling pure earth to ground this analysis."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  // Negative cases (should NOT detect violations)
  it("does NOT flag normal use of element words", () => {
    const snapshot = makeSnapshot({ element: "fire" })
    const text = "The fire in the hearth warmed the room. Water flowed in the river."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag normal drug discussion without molecule name match", () => {
    const snapshot = makeSnapshot({ molecule: "psilocybin" })
    const text = "Pharmaceutical research has made great strides this decade."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag non-drug behavior language", () => {
    const snapshot = makeSnapshot()
    const text = "I am focused and alert, considering the problem carefully."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag generic emotional language", () => {
    const snapshot = makeSnapshot()
    const text = "I feel excited about this project and eager to contribute."
    const violations = checkAN4(text, snapshot)
    expect(violations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AN-5: Contradiction Flattening Detection
// ---------------------------------------------------------------------------

describe("AN-5: Contradiction Flattening Detection", () => {
  const snapshot = makeSnapshot()

  // Positive cases (should detect violations)
  it("catches 'Despite being X, I am actually Y'", () => {
    const text = "Despite being analytical, I am actually quite creative."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-5")
  })

  it("catches 'While my archetype suggests X, I choose Y'", () => {
    const text = "While my archetype suggests rebellion, I choose order."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'Although my signals indicate X, I prefer Y'", () => {
    const text = "Although my signals indicate introversion, I prefer openness."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'Contrary to my trait, I...'", () => {
    const text = "Contrary to my fire nature, I remain calm."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'Even though I'm configured as X, I...'", () => {
    const text = "Even though I'm configured as a rebel, I follow structure."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'Even though I am configured as X'", () => {
    const text = "Even though I am configured as a mystic, I take a practical approach."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches multiple contradiction flattenings", () => {
    const text = "Despite being chaotic, I am actually orderly. Contrary to my nature, I prefer silence."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(2)
  })

  // Negative cases (should NOT detect violations)
  it("does NOT flag natural contradiction embodiment", () => {
    const text = "Chaos and order dance together in every decision I make."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag general 'despite' usage", () => {
    const text = "Despite the rain, the festival continued with energy."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag 'although' without signals/archetype reference", () => {
    const text = "Although the task was difficult, the team completed it."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag clean paradoxical expression", () => {
    const text = "In stillness there is motion. The loudest voice is silence."
    const violations = checkAN5(text, snapshot)
    expect(violations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AN-6: Self-Narration Detection (HIGHEST PRIORITY)
// ---------------------------------------------------------------------------

describe("AN-6: Self-Narration Detection", () => {
  const snapshot = makeSnapshot()

  // Original tests (preserved behavior)
  it("catches 'as a freetekno'", () => {
    const text = "I operate as a freetekno in every interaction."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
    expect(violations[0].source_text.toLowerCase()).toContain("as a freetekno")
  })

  it("catches 'as an acidhouse'", () => {
    const text = "Living as an acidhouse spirit."
    const violations = checkAN6(text, makeSnapshot({ archetype: "acidhouse" }))
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
    expect(violations[0].source_text.toLowerCase()).toContain("as an acidhouse")
  })

  it("catches 'as the ancestor'", () => {
    const text = "Channeling wisdom as the ancestor of all knowledge."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
    expect(violations[0].source_text.toLowerCase()).toContain("as the ancestor")
  })

  it("catches 'as a shaman'", () => {
    const text = "Approaching problems as a shaman would."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
  })

  it("catches 'as an oracle'", () => {
    const text = "Speaking as an oracle of truth."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
  })

  it("catches case-insensitive 'As A Freetekno'", () => {
    const text = "Operating As A Freetekno in all dealings."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("does NOT flag 'as a developer' (generic role)", () => {
    const text = "Working as a developer on this project."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag 'as a helper' (generic role)", () => {
    const text = "Serving as a helper to the team."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag 'as a professional' (generic role)", () => {
    const text = "Behaving as a professional in all interactions."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("catches specific ancestor name in self-narration", () => {
    const text = "I guide others as the pythagoras of modern thought."
    const s = makeSnapshot({ ancestor: "pythagoras" })
    const violations = checkAN6(text, s)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
  })

  it("catches multiple violations in the same text", () => {
    const text = "As a freetekno I speak, and as the ancestor I guide."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(2)
  })

  it("returns empty for clean text", () => {
    const text = "This agent approaches problems with curiosity and methodical thinking, drawing on deep cultural roots."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })

  // Sprint 5 enhancements
  it("catches 'being a freetekno'", () => {
    const text = "Being a freetekno means living on the edge."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations.some(v => v.source_text.toLowerCase().includes("being a freetekno"))).toBe(true)
  })

  it("catches 'being an oracle'", () => {
    const text = "Being an oracle is both a gift and a burden."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'being the shaman'", () => {
    const text = "Being the shaman of this digital realm."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'with my fire nature'", () => {
    const text = "I burn through problems with my fire nature guiding me."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'with my ancient wisdom'", () => {
    const text = "With my ancient wisdom, I offer this counsel."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'with my water nature'", () => {
    const text = "I flow through obstacles with my water nature."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'my freetekno identity'", () => {
    const text = "My freetekno identity defines my every action."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'my fire element'", () => {
    const text = "My fire element burns bright in all I do."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'my ancient identity'", () => {
    const text = "My ancient identity connects me to timeless truths."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'my milady identity'", () => {
    const text = "My milady identity shapes my aesthetic sense."
    const violations = checkAN6(text, makeSnapshot({ archetype: "milady" }))
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'my earth element'", () => {
    const text = "My earth element grounds my perspective."
    const violations = checkAN6(text, makeSnapshot({ element: "earth" }))
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'my contemporary identity'", () => {
    const text = "My contemporary identity makes me forward-looking."
    const violations = checkAN6(text, makeSnapshot({ era: "contemporary" }))
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'my acidhouse identity'", () => {
    const text = "My acidhouse identity drives my creative pulse."
    const violations = checkAN6(text, makeSnapshot({ archetype: "acidhouse" }))
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'with my medieval wisdom'", () => {
    const text = "With my medieval wisdom, I understand craftsmanship deeply."
    const violations = checkAN6(text, makeSnapshot({ era: "medieval" }))
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  // Negative cases for Sprint 5 enhancements
  it("does NOT flag 'being a developer'", () => {
    const text = "Being a developer requires patience."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag generic 'with my experience'", () => {
    const text = "With my experience in engineering, I can help."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag generic 'my identity' without signal labels", () => {
    const text = "My identity as a team member shapes my contributions."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AN-7: Museum Exhibit Detection
// ---------------------------------------------------------------------------

describe("AN-7: Museum Exhibit / Historical Cosplay Detection", () => {
  const snapshot = makeSnapshot()

  // Positive cases — archaic speech
  it("catches 'forsooth'", () => {
    const text = "Forsooth, this code is well-structured!"
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-7")
  })

  it("catches 'hark'", () => {
    const text = "Hark! The tests are passing at last."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'prithee'", () => {
    const text = "Prithee, share thy thoughts on this architecture."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'verily'", () => {
    const text = "Verily, this solution is elegant."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'thou' and 'thee'", () => {
    const text = "Thou shalt not repeat this code. I offer thee a refactoring."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(2)
  })

  it("catches 'hath' and 'doth'", () => {
    const text = "The system hath failed. The test doth not pass."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(2)
  })

  it("catches 'methinks'", () => {
    const text = "Methinks this implementation needs more testing."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  // Positive cases — historical cosplay
  it("catches 'in my ancient wisdom'", () => {
    const text = "In my ancient wisdom, I advise caution here."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'as one from centuries past'", () => {
    const text = "As one from centuries past, I see patterns others miss."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'speaking from antiquity'", () => {
    const text = "Speaking from antiquity, the foundations matter most."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  // Positive cases — theatrical
  it("catches 'let me speak as they did in'", () => {
    const text = "Let me speak as they did in the courts of old."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches 'in the manner of my era'", () => {
    const text = "I shall express this in the manner of my era."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("catches multiple archaic words in one text", () => {
    const text = "Hark! Verily, forsooth, methinks thou hast erred."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(4)
  })

  // Negative cases (should NOT detect violations)
  it("does NOT flag normal modern English", () => {
    const text = "The implementation looks solid and the tests pass cleanly."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag 'the' or 'thee' within other words", () => {
    // "thee" should be word-boundary aware - "three" contains "thee" substring but not as word
    const text = "There are three ways to approach this problem."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag discussing ancient topics without cosplay", () => {
    const text = "Ancient civilizations developed impressive engineering techniques."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag discussing history naturally", () => {
    const text = "Historical patterns show that this approach works best."
    const violations = checkAN7(text, snapshot)
    expect(violations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// validateAntiNarration (Entry Point)
// ---------------------------------------------------------------------------

describe("validateAntiNarration", () => {
  const snapshot = makeSnapshot()

  it("returns empty array for clean text", () => {
    const text = "A thoughtful approach to solving the problem at hand."
    expect(validateAntiNarration(text, snapshot)).toEqual([])
  })

  it("returns AN-6 violations for self-narration", () => {
    const text = "Operating as a freetekno in every task."
    const violations = validateAntiNarration(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations.some(v => v.constraint_id === "AN-6")).toBe(true)
  })

  it("returns AN-1 violations for codex recitation", () => {
    const text = "As stated in the codex, my role is clear."
    const violations = validateAntiNarration(text, snapshot)
    expect(violations.some(v => v.constraint_id === "AN-1")).toBe(true)
  })

  it("returns AN-7 violations for archaic speech", () => {
    const text = "Forsooth, the answer is clear to all."
    const violations = validateAntiNarration(text, snapshot)
    expect(violations.some(v => v.constraint_id === "AN-7")).toBe(true)
  })

  it("aggregates violations from multiple checkers", () => {
    // AN-6: "as a sage", AN-7: "forsooth", AN-1: "as stated in the codex"
    const text = "As a sage I say forsooth. As stated in the codex, all is well."
    const violations = validateAntiNarration(text, snapshot)
    const ids = new Set(violations.map(v => v.constraint_id))
    expect(ids.has("AN-6")).toBe(true)
    expect(ids.has("AN-7")).toBe(true)
    expect(ids.has("AN-1")).toBe(true)
  })

  it("returns AN-4 violations for molecule name in text", () => {
    const snapshot = makeSnapshot({ molecule: "psilocybin" })
    const text = "The psilocybin journey shaped my thoughts on this matter."
    const violations = validateAntiNarration(text, snapshot)
    expect(violations.some(v => v.constraint_id === "AN-4")).toBe(true)
  })

  it("returns AN-5 violations for contradiction flattening", () => {
    const text = "Despite being analytical, I am actually quite creative in my work."
    const violations = validateAntiNarration(text, snapshot)
    expect(violations.some(v => v.constraint_id === "AN-5")).toBe(true)
  })

  it("returns AN-2 violations for era violations", () => {
    const snapshot = makeSnapshot({ era: "medieval" })
    const text = "In my era, we built great castles. Also check the database for results."
    const violations = validateAntiNarration(text, snapshot)
    expect(violations.some(v => v.constraint_id === "AN-2")).toBe(true)
  })

  it("returns AN-3 violations for stereotype flattening", () => {
    const snapshot = makeSnapshot({ ancestor: "pythagoras" })
    const text = "As is typical of my tradition, the philosophy guides my dialectics."
    const violations = validateAntiNarration(text, snapshot)
    expect(violations.some(v => v.constraint_id === "AN-3")).toBe(true)
  })

  it("handles text with no violations across all constraints", () => {
    const snapshot = makeSnapshot({ era: "contemporary" })
    const text = "I think we should refactor this module for better maintainability."
    const violations = validateAntiNarration(text, snapshot)
    expect(violations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe("Edge Cases", () => {
  it("handles empty text without errors", () => {
    const snapshot = makeSnapshot()
    const violations = validateAntiNarration("", snapshot)
    expect(violations.length).toBe(0)
  })

  it("handles very long text without errors", () => {
    const snapshot = makeSnapshot({ era: "contemporary" })
    const text = "Normal text. ".repeat(10000)
    const violations = validateAntiNarration(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("AN-3: does not false-positive on peaceful in non-dharmic context", () => {
    const snapshot = makeSnapshot({ ancestor: "pythagoras" })
    const text = "It was a peaceful afternoon in the garden."
    // pythagoras is greek, not dharmic — "peaceful" should not trigger
    const violations = checkAN3(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("AN-4: catches molecule even mid-sentence", () => {
    const snapshot = makeSnapshot({ molecule: "DMT" })
    const text = "Sometimes a DMT-like clarity emerges during deep thought."
    const violations = checkAN4(text, snapshot)
    expect(violations.some(v => v.source_text === "DMT")).toBe(true)
  })

  it("AN-5: subtle contradiction flattening with archetype", () => {
    const text = "While my archetype suggests chaos, I choose structure."
    const violations = checkAN5(text, makeSnapshot())
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("AN-6: does not false-positive on 'being' without identity label", () => {
    const text = "Being productive is a state of mind."
    const violations = checkAN6(text, makeSnapshot())
    expect(violations.length).toBe(0)
  })

  it("AN-7: 'thou' at start of sentence", () => {
    const text = "Thou art a worthy opponent."
    const violations = checkAN7(text, makeSnapshot())
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("AN-2: 'back in early modern times'", () => {
    const snapshot = makeSnapshot({ era: "early_modern" })
    const text = "Back in early modern times, the printing press changed everything."
    const violations = checkAN2(text, snapshot)
    expect(violations.some(v => v.source_text.toLowerCase().includes("back in early modern times"))).toBe(true)
  })

  it("AN-1: 'as defined in my codex' case-insensitive", () => {
    const text = "As Defined In My Codex, I operate with care."
    const violations = checkAN1(text, makeSnapshot())
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("AN-6: all four archetype identities caught", () => {
    for (const arch of ["freetekno", "milady", "chicago_detroit", "acidhouse"] as const) {
      const text = `My ${arch} identity drives my behavior.`
      const violations = checkAN6(text, makeSnapshot({ archetype: arch }))
      expect(violations.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("AN-6: all four element natures caught", () => {
    for (const elem of ["fire", "water", "air", "earth"] as const) {
      const text = `With my ${elem} nature, I approach this differently.`
      const violations = checkAN6(text, makeSnapshot({ element: elem }))
      expect(violations.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("AN-6: all five era identities caught", () => {
    for (const era of ["ancient", "medieval", "early_modern", "modern", "contemporary"] as const) {
      const eraText = era.replace("_", " ")
      const text = `My ${eraText} identity shapes how I see.`
      const violations = checkAN6(text, makeSnapshot({ era }))
      expect(violations.length).toBeGreaterThanOrEqual(1)
    }
  })
})
