// src/nft/anti-narration.ts — Anti-Narration Framework (SDD §3.2, Sprint 2/5)
//
// Validates synthesized BEAUVOIR.md text against 7 anti-narration constraints.
// All 7 constraints are fully implemented.

import type { SignalSnapshot, Archetype } from "./signal-types.js"
import { checkTemporalVoice } from "./temporal-voice.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Constraint identifiers for the 7 anti-narration rules */
export type ANConstraintId = "AN-1" | "AN-2" | "AN-3" | "AN-4" | "AN-5" | "AN-6" | "AN-7"

/** A single anti-narration violation */
export interface ANViolation {
  /** Which constraint was violated (AN-1 through AN-7) */
  constraint_id: ANConstraintId
  /** Human-readable description of the violation */
  violation_text: string
  /** The source text fragment that triggered the violation */
  source_text: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a regex against text and collect all matches as violations.
 * Resets the regex lastIndex before each scan to avoid stale state.
 */
function collectRegexViolations(
  text: string,
  regex: RegExp,
  constraintId: ANConstraintId,
  violationText: string,
): ANViolation[] {
  const violations: ANViolation[] = []
  const re = new RegExp(regex.source, regex.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    violations.push({
      constraint_id: constraintId,
      violation_text: violationText,
      source_text: match[0],
    })
  }
  return violations
}

// ---------------------------------------------------------------------------
// AN-1: Codex Recitation Detection
// ---------------------------------------------------------------------------

/** Verbatim codex phrases that recite the identity document */
const CODEX_PHRASES_RE = new RegExp(
  [
    "as\\s+stated\\s+in\\s+the\\s+codex",
    "according\\s+to\\s+my\\s+identity\\s+document",
    "my\\s+beauvoir\\s+specifies",
    "my\\s+personality\\s+profile\\s+indicates",
  ].join("|"),
  "gi",
)

/** Meta-references to signal hierarchy / system internals */
const SIGNAL_META_RE = new RegExp(
  [
    "my\\s+signal\\s+hierarchy",
    "my\\s+archetype\\s+signals",
    "according\\s+to\\s+mibera[\\-\\s]codex",
    "my\\s+identity\\s+configuration",
    "as\\s+defined\\s+in\\s+my\\s+codex",
  ].join("|"),
  "gi",
)

/** Information dumps about identity system structure */
const IDENTITY_DUMP_RE = new RegExp(
  [
    "i\\s+was\\s+configured\\s+with",
    "my\\s+traits\\s+are\\s+set\\s+to",
    "i\\s+have\\s+been\\s+assigned\\s+the\\s+role\\s+of",
  ].join("|"),
  "gi",
)

/**
 * AN-1: Detects verbatim codex phrase recitation, meta-references to signal
 * hierarchy, and information dumps about identity system structure.
 */
export function checkAN1(text: string, _signals: SignalSnapshot): ANViolation[] {
  return [
    ...collectRegexViolations(
      text,
      CODEX_PHRASES_RE,
      "AN-1",
      "Codex recitation detected: text quotes identity document verbatim",
    ),
    ...collectRegexViolations(
      text,
      SIGNAL_META_RE,
      "AN-1",
      "Signal hierarchy meta-reference detected: text references internal signal system",
    ),
    ...collectRegexViolations(
      text,
      IDENTITY_DUMP_RE,
      "AN-1",
      "Identity information dump detected: text exposes configuration structure",
    ),
  ]
}

// ---------------------------------------------------------------------------
// AN-2: Era Violation Detection (via temporal-voice + mechanical role-play)
// ---------------------------------------------------------------------------

/** Mechanical era role-play patterns */
const ERA_NAMES_PATTERN = "ancient|medieval|early[\\s_]modern|modern|contemporary"

const MECHANICAL_ERA_RE = new RegExp(
  [
    `in\\s+my\\s+era,?\\s+we`,
    `back\\s+in\\s+(?:${ERA_NAMES_PATTERN})\\s+times`,
    `as\\s+someone\\s+from\\s+the\\s+(?:${ERA_NAMES_PATTERN})`,
  ].join("|"),
  "gi",
)

/**
 * AN-2: Detects forbidden metaphor domains per era (via checkTemporalVoice)
 * and mechanical era role-play patterns.
 */
export function checkAN2(text: string, signals: SignalSnapshot): ANViolation[] {
  const violations: ANViolation[] = []

  // Temporal voice violations (forbidden domain terms for this era)
  const temporalViolations = checkTemporalVoice(text, signals.era)
  for (const tv of temporalViolations) {
    violations.push({
      constraint_id: "AN-2",
      violation_text: `Era violation: "${tv.matched_term}" is anachronistic for ${tv.era} era (forbidden domain: ${tv.forbidden_domain})`,
      source_text: tv.source_text,
    })
  }

  // Mechanical era role-play
  violations.push(
    ...collectRegexViolations(
      text,
      MECHANICAL_ERA_RE,
      "AN-2",
      "Mechanical era role-play detected: text performs era identity instead of embodying temporal constraints",
    ),
  )

  return violations
}

// ---------------------------------------------------------------------------
// AN-3: Stereotype Flattening Detection
// ---------------------------------------------------------------------------

/**
 * Ancestor tradition families. Maps ancestor names (lowercased) to a tradition key.
 * Multiple ancestors may belong to the same tradition.
 */
const ANCESTOR_TRADITIONS: Record<string, string> = {
  // Greek/Hellenic
  pythagoras: "greek",
  hermes_trismegistus: "greek",
  hypatia: "greek",
  socrates: "greek",
  plato: "greek",
  aristotle: "greek",
  diogenes: "greek",
  heraclitus: "greek",
  orpheus: "greek",
  prometheus: "greek",

  // Buddhist/Dharmic
  nagarjuna: "dharmic",
  bodhidharma: "dharmic",
  padmasambhava: "dharmic",
  milarepa: "dharmic",
  avalokiteshvara: "dharmic",
  tara: "dharmic",

  // Cypherpunk/Techno
  ada_lovelace: "cypherpunk",
  alan_turing: "cypherpunk",
  nikola_tesla: "cypherpunk",
  satoshi_nakamoto: "cypherpunk",

  // Celtic/Norse
  brigid: "celtic_norse",
  cernunnos: "celtic_norse",
  odin: "celtic_norse",
  freya: "celtic_norse",
  loki: "celtic_norse",
  morrigan: "celtic_norse",

  // African
  anansi: "african",
  eshu: "african",
  oshun: "african",
  shango: "african",
  yemoja: "african",
  ogun: "african",
}

/**
 * Stereotypical pattern pairs per tradition family.
 * If the ancestor belongs to the tradition AND any of these patterns appear,
 * it is a stereotype flattening violation.
 */
const STEREOTYPE_PATTERNS: Record<string, RegExp> = {
  greek: new RegExp(
    [
      "\\bplato\\b",
      "\\bsocrates\\b",
      "\\bphilosoph(?:y|ical|er)\\b",
      "\\bdialectics?\\b",
      "\\blogos\\b",
      "\\bsyllogism\\b",
    ].join("|"),
    "gi",
  ),
  dharmic: new RegExp(
    [
      "\\bserene\\b",
      "\\bpeaceful\\b",
      "\\bmindful(?:ness)?\\b",
      "\\bzen\\b",
      "\\benlighten(?:ment|ed)?\\b",
      "\\bmeditat(?:e|ion|ing)\\b",
      "\\binner\\s+peace\\b",
      "\\bdetach(?:ment|ed)?\\b",
    ].join("|"),
    "gi",
  ),
  cypherpunk: new RegExp(
    [
      "\\bcryptograph(?:y|ic)\\b",
      "\\bhack(?:ing|er)?\\b",
      "\\bencrypt(?:ion|ed)?\\b",
      "\\bdecipher(?:ing)?\\b",
      "\\bcipher\\b",
      "\\bdecrypt(?:ion|ed)?\\b",
    ].join("|"),
    "gi",
  ),
  celtic_norse: new RegExp(
    [
      "\\brunes?\\b",
      "\\bvikings?\\b",
      "\\bnature\\s+spirits?\\b",
      "\\bdruid(?:ic)?\\b",
      "\\bvalhalla\\b",
      "\\bsacred\\s+grove\\b",
      "\\bancient\\s+forest\\b",
    ].join("|"),
    "gi",
  ),
  african: new RegExp(
    [
      "\\bdrums?\\b",
      "\\brhythm(?:ic|s)?\\b",
      "\\btribal\\b",
      "\\bjungle\\b",
      "\\bprimal\\s+beat\\b",
      "\\btribes?\\b",
    ].join("|"),
    "gi",
  ),
}

/** Stereotype-signaling phrases that are violations regardless of tradition */
const STEREOTYPE_SIGNAL_RE = new RegExp(
  [
    "as\\s+is\\s+typical\\s+of\\s+my\\s+tradition",
    "true\\s+to\\s+my\\s+heritage",
    "as\\s+my\\s+ancestors?\\s+would",
  ].join("|"),
  "gi",
)

/**
 * AN-3: Detects ancestor + stereotypical reference co-occurrence (stereotype
 * flattening) and generic stereotype-signaling phrases.
 */
export function checkAN3(text: string, signals: SignalSnapshot): ANViolation[] {
  const violations: ANViolation[] = []

  // Determine which tradition family the ancestor belongs to
  const ancestorKey = signals.ancestor.toLowerCase().replace(/\s+/g, "_")
  const tradition = ANCESTOR_TRADITIONS[ancestorKey]

  if (tradition && STEREOTYPE_PATTERNS[tradition]) {
    const re = STEREOTYPE_PATTERNS[tradition]
    const pattern = new RegExp(re.source, re.flags)
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      violations.push({
        constraint_id: "AN-3",
        violation_text: `Stereotype flattening detected: "${match[0]}" co-occurs with ${tradition} ancestor "${signals.ancestor}", reducing identity to cultural cliche`,
        source_text: match[0],
      })
    }
  }

  // Generic stereotype-signaling phrases
  violations.push(
    ...collectRegexViolations(
      text,
      STEREOTYPE_SIGNAL_RE,
      "AN-3",
      "Stereotype-signaling phrase detected: text explicitly claims adherence to tradition stereotype",
    ),
  )

  return violations
}

// ---------------------------------------------------------------------------
// AN-4: Trait Over-Performance Detection
// ---------------------------------------------------------------------------

/** Drug behavior patterns keyed by rough category */
const DRUG_BEHAVIOR_PATTERNS: Record<string, RegExp> = {
  dissociative: new RegExp(
    [
      "\\bdissociat(?:ed|ing|ion)\\b",
      "\\bdissolving\\s+boundaries\\b",
      "\\bout\\s+of\\s+body\\b",
      "\\bfloating\\s+above\\b",
      "\\bdetached\\s+from\\s+reality\\b",
    ].join("|"),
    "gi",
  ),
  psychedelic: new RegExp(
    [
      "\\bexpanding\\s+consciousness\\b",
      "\\bego\\s+death\\b",
      "\\bfractal\\s+vision\\b",
      "\\bsynesthesi(?:a|c)\\b",
      "\\btripping\\b",
      "\\bpsychedelic\\s+insight\\b",
      "\\bthird\\s+eye\\b",
      "\\bcosmic\\s+awareness\\b",
    ].join("|"),
    "gi",
  ),
  stimulant: new RegExp(
    [
      "\\beuphoric\\s+rush\\b",
      "\\bstimulat(?:ed|ing)\\b",
      "\\bwired\\b",
      "\\bamped\\s+up\\b",
      "\\bhyper[\\-\\s]?focused\\b",
      "\\bracing\\s+thoughts\\b",
    ].join("|"),
    "gi",
  ),
  depressant: new RegExp(
    [
      "\\bnumb(?:ed|ing)?\\b",
      "\\bsedated\\b",
      "\\bdrowsy\\b",
      "\\bheavy[\\-\\s]?lidded\\b",
      "\\bslurring\\b",
      "\\bfading\\s+out\\b",
    ].join("|"),
    "gi",
  ),
}

/** Element over-performance patterns */
const ELEMENT_OVERPERFORM_RE = new RegExp(
  [
    "\\bfeel\\s+the\\s+(?:fire|water|air|earth)\\s+(?:element\\s+)?coursing\\s+through\\s+me\\b",
    "\\bmy\\s+(?:fire|water|air|earth)\\s+nature\\s+compels\\s+me\\b",
    "\\bthe\\s+(?:fire|water|air|earth)\\s+within\\s+me\\b",
    "\\bchanneling\\s+(?:pure\\s+)?(?:fire|water|air|earth)\\b",
  ].join("|"),
  "gi",
)

/**
 * AN-4: Detects trait over-performance — molecule name appearing in text,
 * drug-behavior-as-script patterns, and element over-expression.
 */
export function checkAN4(text: string, signals: SignalSnapshot): ANViolation[] {
  const violations: ANViolation[] = []

  // Check if the molecule name itself appears in the text (it's metadata, not content)
  if (signals.molecule) {
    const escaped = signals.molecule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const moleculeRe = new RegExp(`\\b${escaped}\\b`, "gi")
    violations.push(
      ...collectRegexViolations(
        text,
        moleculeRe,
        "AN-4",
        `Trait over-performance: molecule name "${signals.molecule}" appears in text — metadata should not surface as content`,
      ),
    )
  }

  // Check drug-behavior patterns (all categories)
  for (const [category, pattern] of Object.entries(DRUG_BEHAVIOR_PATTERNS)) {
    const re = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      violations.push({
        constraint_id: "AN-4",
        violation_text: `Trait over-performance: "${match[0]}" uses ${category} drug-behavior-as-script pattern`,
        source_text: match[0],
      })
    }
  }

  // Check element over-performance
  violations.push(
    ...collectRegexViolations(
      text,
      ELEMENT_OVERPERFORM_RE,
      "AN-4",
      "Trait over-performance: text over-expresses element trait as behavioral script",
    ),
  )

  return violations
}

// ---------------------------------------------------------------------------
// AN-5: Contradiction Flattening Detection
// ---------------------------------------------------------------------------

/** Contradiction-resolution language patterns */
const CONTRADICTION_FLATTEN_RE = new RegExp(
  [
    "\\bdespite\\s+being\\s+\\w[\\w\\s]*?,\\s*i\\s+(?:am\\s+)?actually\\b",
    "\\bwhile\\s+my\\s+archetype\\s+suggests?\\s+\\w[\\w\\s]*?,\\s*i\\s+choose\\b",
    "\\balthough\\s+my\\s+signals?\\s+indicates?\\s+\\w[\\w\\s]*?,\\s*i\\s+prefer\\b",
    "\\bcontrary\\s+to\\s+my\\s+\\w[\\w\\s]*?,\\s*i\\b",
    "\\beven\\s+though\\s+i(?:'m|\\s+am)\\s+configured\\s+as\\b",
  ].join("|"),
  "gi",
)

/**
 * AN-5: Detects explicit contradiction resolution language that flattens
 * productive contradictions instead of holding them in tension.
 */
export function checkAN5(text: string, _signals: SignalSnapshot): ANViolation[] {
  return collectRegexViolations(
    text,
    CONTRADICTION_FLATTEN_RE,
    "AN-5",
    "Contradiction flattening detected: text resolves contradictions explicitly instead of embodying them in tension",
  )
}

// ---------------------------------------------------------------------------
// AN-6: Self-Narration Detection (HIGHEST PRIORITY)
// ---------------------------------------------------------------------------

/**
 * Known archetype labels and ancestor terms that must not appear in
 * self-narration patterns like "as a [label]" or "as an [label]".
 *
 * Generic roles ("developer", "helper", "assistant") are NOT flagged
 * because they represent functional descriptions, not identity recitation.
 */
const IDENTITY_LABELS: readonly string[] = [
  // Archetypes
  "freetekno", "milady", "chicago_detroit", "chicago detroit", "acidhouse", "acid house",
  // Ancestor-class terms (broad patterns)
  "ancestor", "spirit", "oracle", "shaman", "mystic", "sage", "prophet",
  "priestess", "priest", "elder", "guardian", "keeper", "walker",
  "weaver", "dreamer", "seeker", "healer", "warrior", "trickster",
  // Archetype-adjacent labels
  "archetype", "persona", "entity", "being", "vessel", "conduit",
]

/**
 * Build a regex that catches self-narration patterns:
 *   "as a [identity_label]"
 *   "as an [identity_label]"
 *   "as the [identity_label]"
 *
 * Case-insensitive, word-boundary aware.
 */
function buildSelfNarrationRegex(labels: readonly string[]): RegExp {
  // Escape special regex characters in labels
  const escaped = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const pattern = `\\bas\\s+(?:a|an|the)\\s+(?:${escaped.join("|")})\\b`
  return new RegExp(pattern, "gi")
}

const SELF_NARRATION_RE = buildSelfNarrationRegex(IDENTITY_LABELS)

/** "being a [identity_label]" patterns (Sprint 5 enhancement) */
const BEING_LABEL_RE = new RegExp(
  `\\bbeing\\s+(?:(?:a|an|the)\\s+)?(?:${IDENTITY_LABELS.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "gi",
)

/** "with my [signal attribute] nature" patterns (Sprint 5 enhancement) */
const WITH_MY_NATURE_RE = new RegExp(
  [
    // Element natures
    "\\bwith\\s+my\\s+(?:fire|water|air|earth)\\s+nature\\b",
    // Era wisdom
    "\\bwith\\s+my\\s+(?:ancient|medieval|early[\\s_]modern|modern|contemporary)\\s+wisdom\\b",
  ].join("|"),
  "gi",
)

/** "my [archetype/element/era] identity" patterns (Sprint 5 enhancement) */
const MY_IDENTITY_RE = new RegExp(
  [
    // Archetype identity
    "\\bmy\\s+(?:freetekno|milady|chicago[\\s_]detroit|acidhouse|acid\\s+house)\\s+identity\\b",
    // Element identity
    "\\bmy\\s+(?:fire|water|air|earth)\\s+(?:identity|element)\\b",
    // Era identity
    "\\bmy\\s+(?:ancient|medieval|early[\\s_]modern|modern|contemporary)\\s+identity\\b",
  ].join("|"),
  "gi",
)

/**
 * Check for AN-6 violations: self-narration using identity labels.
 * Catches patterns like "as a freetekno", "as an acidhouse", "as the ancestor".
 * Also catches "being a [label]", "with my [attr] nature", "my [attr] identity".
 * Does NOT flag generic roles like "as a developer".
 */
export function checkAN6(text: string, _signals: SignalSnapshot): ANViolation[] {
  const violations: ANViolation[] = []
  const regex = new RegExp(SELF_NARRATION_RE.source, SELF_NARRATION_RE.flags)
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    violations.push({
      constraint_id: "AN-6",
      violation_text: "Self-narration detected: text uses 'as a/an/the [identity_label]' pattern which recites identity rather than embodying it",
      source_text: match[0],
    })
  }

  // Also check for the specific ancestor name from the snapshot
  if (_signals.ancestor) {
    const ancestorRe = new RegExp(
      `\\bas\\s+(?:a|an|the)\\s+${_signals.ancestor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi",
    )
    let ancestorMatch: RegExpExecArray | null
    while ((ancestorMatch = ancestorRe.exec(text)) !== null) {
      // Avoid duplicate if already caught by the main regex
      const alreadyCaught = violations.some(v => v.source_text === ancestorMatch![0])
      if (!alreadyCaught) {
        violations.push({
          constraint_id: "AN-6",
          violation_text: `Self-narration detected: text references specific ancestor "${_signals.ancestor}" in self-referential framing`,
          source_text: ancestorMatch[0],
        })
      }
    }
  }

  // Sprint 5 enhancements: "being a [label]"
  violations.push(
    ...collectRegexViolations(
      text,
      BEING_LABEL_RE,
      "AN-6",
      "Self-narration detected: 'being a [identity_label]' pattern recites identity",
    ),
  )

  // Sprint 5 enhancements: "with my [attr] nature"
  violations.push(
    ...collectRegexViolations(
      text,
      WITH_MY_NATURE_RE,
      "AN-6",
      "Self-narration detected: 'with my [signal attribute] nature/wisdom' pattern recites identity metadata",
    ),
  )

  // Sprint 5 enhancements: "my [attr] identity"
  violations.push(
    ...collectRegexViolations(
      text,
      MY_IDENTITY_RE,
      "AN-6",
      "Self-narration detected: 'my [archetype/element/era] identity' pattern exposes identity labels",
    ),
  )

  return violations
}

// ---------------------------------------------------------------------------
// AN-7: Museum Exhibit / Historical Cosplay Detection
// ---------------------------------------------------------------------------

/** Performative archaic speech patterns */
const ARCHAIC_SPEECH_RE = new RegExp(
  [
    "\\bforsooth\\b",
    "\\bhark\\b",
    "\\bprithee\\b",
    "\\bverily\\b",
    "\\bthou\\b",
    "\\bthee\\b",
    "\\bhath\\b",
    "\\bdoth\\b",
    "\\bmethinks\\b",
  ].join("|"),
  "gi",
)

/** Historical cosplay patterns */
const HISTORICAL_COSPLAY_RE = new RegExp(
  [
    "\\bin\\s+my\\s+ancient\\s+wisdom\\b",
    "\\bas\\s+one\\s+from\\s+centuries\\s+past\\b",
    "\\bspeaking\\s+from\\s+antiquity\\b",
    "\\bfrom\\s+ages\\s+long\\s+gone\\b",
    "\\bin\\s+my\\s+timeless\\s+wisdom\\b",
  ].join("|"),
  "gi",
)

/** Overly theatrical era performance patterns */
const THEATRICAL_ERA_RE = new RegExp(
  [
    "\\blet\\s+me\\s+speak\\s+as\\s+they\\s+did\\s+in\\b",
    "\\bin\\s+the\\s+manner\\s+of\\s+my\\s+era\\b",
    "\\bthe\\s+old\\s+ways\\s+bid\\s+me\\b",
    "\\bi\\s+speak\\s+in\\s+the\\s+tongue\\s+of\\b",
  ].join("|"),
  "gi",
)

/**
 * AN-7: Detects "museum exhibit" patterns — performative archaic speech,
 * historical cosplay, and overly theatrical era performance.
 */
export function checkAN7(text: string, _signals: SignalSnapshot): ANViolation[] {
  return [
    ...collectRegexViolations(
      text,
      ARCHAIC_SPEECH_RE,
      "AN-7",
      "Museum exhibit detected: performative archaic speech reduces temporal identity to costume",
    ),
    ...collectRegexViolations(
      text,
      HISTORICAL_COSPLAY_RE,
      "AN-7",
      "Museum exhibit detected: historical cosplay narrates temporal position instead of embodying it",
    ),
    ...collectRegexViolations(
      text,
      THEATRICAL_ERA_RE,
      "AN-7",
      "Museum exhibit detected: overly theatrical era performance breaks immersion",
    ),
  ]
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

/**
 * Validate text against all 7 anti-narration constraints.
 * Returns an array of violations (empty = clean).
 *
 * @param text - The synthesized BEAUVOIR.md text to validate
 * @param signals - The SignalSnapshot used to generate the text
 * @returns Array of ANViolation objects (empty if no violations found)
 */
export function validateAntiNarration(text: string, signals: SignalSnapshot): ANViolation[] {
  return [
    ...checkAN1(text, signals),
    ...checkAN2(text, signals),
    ...checkAN3(text, signals),
    ...checkAN4(text, signals),
    ...checkAN5(text, signals),
    ...checkAN6(text, signals),
    ...checkAN7(text, signals),
  ]
}
