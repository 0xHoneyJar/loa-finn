// src/research/sensors/index.ts — the sensor registry + the ADAPTER-BOUNDARY
// enforcement (bd-8ywq.8 · Agent R&D Lab V1 · Acceptance Contract G, the
// load-bearing piece).
//
// Contract G resolves the only apparent contradiction in the spec ("no bespoke
// adapters" vs. "build sensors/grok.ts"): it is not a contradiction unless logic
// LEAKS. The rule, made mechanical here:
//
//   · probe.ts dispatches to a sensor ONLY through the stable `SensorFn` seam
//     (`makeRegisteredSensor` below, plus the gemini sensor wired in probe.ts).
//   · A sensor reaches the outside world ONLY through the Cheval invoker (LLM —
//     grok) or an Asson-CLI (data — dune). Provider-specific code lives INSIDE
//     Cheval or INSIDE an Asson command, never in a shim.
//   · There are NO direct provider API calls anywhere in src/research/sensors/.
//
// The third rule is the one that closes the unmetered-call escape hatch, so it
// is ENFORCED statically, not just asserted in prose: `scanForDirectProviderCalls`
// is the boundary check (driven by the co-located boundary test over the shim
// sources). The forbidden-pattern table lives here because the boundary is this
// module's responsibility — which is exactly why the scanner must NOT be pointed
// at index.ts itself (it names the patterns it forbids); the test scans the SHIM
// files (grok.ts, dune.ts, contract.ts).

import { ResearchSensorError } from "../cost-atom-research.js"
import type { ResearchSensor } from "../schemas/index.js"
import type { SensorFn } from "../probe.js"
import { makeGrokSensor, type GrokSensorDeps } from "./grok.js"
import { makeDuneSensor, type DuneSensorDeps } from "./dune.js"

export { SensorUnavailableError } from "./contract.js"
export type { SensorAvailability } from "./contract.js"
export { grokAvailability, makeGrokSensor } from "./grok.js"
export type { GrokSensorDeps, ChevalXaiRoute, ChevalXaiResult } from "./grok.js"
export { duneAvailability, makeDuneSensor } from "./dune.js"
export type { DuneSensorDeps, DuneSpawn, DuneSpawnResult, DuneRunResult } from "./dune.js"

// ---------------------------------------------------------------------------
// The registry — probe.ts routes every non-gemini sensor through here.
// ---------------------------------------------------------------------------

export interface RegisteredSensorDeps {
  grok?: GrokSensorDeps
  dune?: DuneSensorDeps
}

/** Resolve a `SensorFn` for a registered sensor. grok → the Cheval xai shim;
 *  dune → the Asson dune-meter shim. gemini is wired in probe.ts
 *  (`makeGeminiDigSearchSensor`, a subscription dig-search shell — not a
 *  sensors/-dir shim), so reaching it here is a dispatch bug, surfaced as a
 *  typed error rather than a silent wrong-sensor. */
export function makeRegisteredSensor(
  sensor: ResearchSensor,
  deps: RegisteredSensorDeps = {},
): SensorFn {
  switch (sensor) {
    case "grok":
      return makeGrokSensor(deps.grok)
    case "dune":
      return makeDuneSensor(deps.dune)
    case "gemini":
      throw new ResearchSensorError(
        'gemini is wired in probe.ts (makeGeminiDigSearchSensor), not the sensors registry',
      )
    default:
      throw new ResearchSensorError(`unknown sensor "${String(sensor)}"`)
  }
}

// ---------------------------------------------------------------------------
// Adapter-boundary enforcement (Contract G) — the static check.
// ---------------------------------------------------------------------------

/** A provider call that MUST NOT appear in a sensor shim. A shim that named any
 *  of these would be reaching past the Cheval/Asson seam — the unmetered-call
 *  escape hatch Contract G closes. */
export interface ForbiddenPattern {
  pattern: RegExp
  label: string
}

/** The forbidden direct-call patterns. Generic HTTP clients (a sensor must shell
 *  Cheval/Asson, not call out itself) + every provider host the seam exists to
 *  hide. NOTE: this module names these patterns by definition, so the scanner is
 *  pointed at the SHIM files, never at index.ts. */
export const FORBIDDEN_DIRECT_CALL_PATTERNS: ForbiddenPattern[] = [
  { pattern: /\bfetch\s*\(/, label: "direct fetch() call" },
  { pattern: /\baxios\b/, label: "axios HTTP client" },
  { pattern: /\bgot\s*\(/, label: "got HTTP client" },
  { pattern: /\bnode-fetch\b/, label: "node-fetch" },
  { pattern: /api\.x\.ai/, label: "xAI provider host" },
  { pattern: /api\.dune\.com/, label: "Dune provider host" },
  { pattern: /\bdune-api\b/, label: "Dune provider host" },
  { pattern: /generativelanguage\.googleapis/, label: "Google GenAI host" },
  { pattern: /api\.anthropic\.com/, label: "Anthropic provider host" },
  { pattern: /api\.openai\.com/, label: "OpenAI provider host" },
]

export interface BoundaryViolation {
  file: string
  label: string
  line: number
  excerpt: string
}

/** Scan sensor-shim sources for forbidden direct provider calls. Pure over its
 *  input (the caller supplies `{ path → source }`); returns every violation
 *  (file · pattern label · 1-based line · the offending line, trimmed). An empty
 *  result is the boundary holding. */
export function scanForDirectProviderCalls(
  sources: Record<string, string>,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []
  for (const [file, source] of Object.entries(sources)) {
    const lines = source.split("\n")
    for (let i = 0; i < lines.length; i++) {
      for (const { pattern, label } of FORBIDDEN_DIRECT_CALL_PATTERNS) {
        if (pattern.test(lines[i])) {
          violations.push({ file, label, line: i + 1, excerpt: lines[i].trim().slice(0, 120) })
        }
      }
    }
  }
  return violations
}

/** Throw if any sensor shim makes a direct provider call (Contract G). The
 *  co-located boundary test calls this with the shim sources read from disk. */
export function assertNoDirectProviderCalls(sources: Record<string, string>): void {
  const violations = scanForDirectProviderCalls(sources)
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `  ${v.file}:${v.line} — ${v.label}: ${v.excerpt}`)
      .join("\n")
    throw new Error(
      `sensor adapter-boundary violation (Contract G): a shim must reach the outside world ONLY via the Cheval invoker (LLM) or an Asson-CLI (data), never a direct provider call:\n${detail}`,
    )
  }
}
