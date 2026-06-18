// src/research/calibration.test.ts — the calibration engine + reflexive ledger.
// Proves: the Brier math (perfect/worst/guess), the abstain-over-force INSUFFICIENT
// discipline (insufficient is recorded but NOT scored), the effect-size-bucketed
// report, the over-confidence-vs-resolution diagnostic, the all-or-nothing
// resolution invariant, and the tamper-evident hash chain.

import { describe, it, expect } from "vitest"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ulid } from "ulid"
import { readFile, writeFile } from "node:fs/promises"
import {
  brierPpm,
  outcomeToBinary,
  classifyEffectFromMargin,
  assertDecisionValid,
  type DecisionForecast,
} from "./schemas/decision-forecast.js"
import {
  resolveDecision,
  calibrationReport,
  DecisionLedgerWriter,
  readCalibrationLedger,
  verifyCalibrationChain,
  decisionFromEnvelope,
  registerDecision,
  readDecisionRegistry,
  findRegisteredDecision,
  resolveRegisteredDecision,
  NoRegisteredDecisionError,
  type DecisionResolution,
} from "./calibration.js"
import { buildCabtCalibrationLedger } from "./cabt-calibration-seed.js"
import { PRE_REGISTERED } from "./cabt-pre-register.js"

const tmpPath = (): string => join(tmpdir(), `calibration-${ulid()}.jsonl`)

/** An unresolved prediction (resolution fields null). */
function unresolved(over: Partial<DecisionForecast> = {}): DecisionForecast {
  return {
    decision_id: "d-test",
    label: "test decision",
    action: "ship",
    proposition: "X holds on the real target",
    prediction_ppm: 700_000,
    prediction_basis: "reconstructed",
    effect_size: "large",
    local_evidence: "0.7 self-play",
    resolution_instrument: null,
    ground_truth: null,
    outcome: null,
    brier_ppm: null,
    resolved_ts: null,
    created_ts: 1_000,
    ...over,
  }
}

const resolution = (over: Partial<DecisionResolution> = {}): DecisionResolution => ({
  resolution_instrument: "ladder-measured",
  ground_truth: "the ladder spoke",
  outcome: "held",
  resolved_ts: 2_000,
  ...over,
})

describe("brierPpm — the binary Brier score in integer-ppm", () => {
  it("perfect prediction scores 0", () => {
    expect(brierPpm(1_000_000, 1)).toBe(0)
    expect(brierPpm(0, 0)).toBe(0)
  })
  it("maximally wrong prediction scores 1e6", () => {
    expect(brierPpm(0, 1)).toBe(1_000_000)
    expect(brierPpm(1_000_000, 0)).toBe(1_000_000)
  })
  it("a 0.5 guess scores 250000 on either outcome", () => {
    expect(brierPpm(500_000, 1)).toBe(250_000)
    expect(brierPpm(500_000, 0)).toBe(250_000)
  })
  it("matches (p-o)^2 for known cases", () => {
    expect(brierPpm(770_000, 1)).toBe(52_900) // (0.77-1)^2 = 0.0529
    expect(brierPpm(700_000, 0)).toBe(490_000) // (0.7-0)^2 = 0.49
    expect(brierPpm(300_000, 1)).toBe(490_000) // (0.3-1)^2 = 0.49
  })
  it("rejects out-of-range / non-integer probabilities", () => {
    expect(() => brierPpm(1_000_001, 1)).toThrow()
    expect(() => brierPpm(-1, 0)).toThrow()
    expect(() => brierPpm(1.5 as unknown as number, 1)).toThrow()
  })
})

describe("outcomeToBinary — insufficient carries no scoreable truth", () => {
  it("held → 1, falsified → 0, insufficient → null", () => {
    expect(outcomeToBinary("held")).toBe(1)
    expect(outcomeToBinary("falsified")).toBe(0)
    expect(outcomeToBinary("insufficient")).toBeNull()
  })
})

describe("resolveDecision — register → resolve", () => {
  it("computes brier_ppm for a held outcome and does not mutate the input", () => {
    const f = unresolved({ prediction_ppm: 770_000 })
    const r = resolveDecision(f, resolution({ outcome: "held" }))
    expect(r.outcome).toBe("held")
    expect(r.brier_ppm).toBe(52_900)
    expect(r.resolved_ts).toBe(2_000)
    // input untouched (the prediction is immutable)
    expect(f.outcome).toBeNull()
    expect(f.brier_ppm).toBeNull()
  })

  it("ABSTAINS over force: an insufficient outcome is recorded but NOT Brier-scored", () => {
    const f = unresolved({ prediction_ppm: 650_000, effect_size: "small" })
    const r = resolveDecision(f, resolution({ outcome: "insufficient" }))
    expect(r.outcome).toBe("insufficient")
    expect(r.brier_ppm).toBeNull() // the discipline: unresolvable ≠ wrong
    expect(r.resolution_instrument).toBe("ladder-measured")
    expect(() => assertDecisionValid(r)).not.toThrow()
  })

  it("refuses to re-resolve an already-resolved decision (a bet is scored once)", () => {
    const r = resolveDecision(unresolved(), resolution())
    expect(() => resolveDecision(r, resolution())).toThrow(/already resolved/)
  })
})

describe("assertDecisionValid — the write-time invariants", () => {
  it("rejects a partial resolution (all-or-nothing)", () => {
    const bad = unresolved({ outcome: "held" }) // outcome set but instrument/ground_truth/ts null
    expect(() => assertDecisionValid(bad)).toThrow(/partial resolution/)
  })
  it("rejects an insufficient outcome that was (wrongly) Brier-scored", () => {
    const bad = unresolved({
      resolution_instrument: "ladder-measured",
      ground_truth: "noise",
      outcome: "insufficient",
      brier_ppm: 250_000, // forbidden — insufficient must be unscored
      resolved_ts: 2_000,
    })
    expect(() => assertDecisionValid(bad)).toThrow(/insufficient/)
  })
  it("rejects a brier_ppm inconsistent with prediction + outcome", () => {
    const bad = unresolved({
      prediction_ppm: 770_000,
      resolution_instrument: "ladder-measured",
      ground_truth: "held",
      outcome: "held",
      brier_ppm: 999, // should be 52_900
      resolved_ts: 2_000,
    })
    expect(() => assertDecisionValid(bad)).toThrow(/≠ expected/)
  })
  it("rejects a brier_ppm set while unresolved", () => {
    expect(() => assertDecisionValid(unresolved({ brier_ppm: 0 }))).toThrow(/null while unresolved/)
  })
  it("rejects a typo'd enum", () => {
    expect(() => assertDecisionValid(unresolved({ effect_size: "huge" as never }))).toThrow(/effect_size/)
  })
})

describe("calibrationReport — bucketed by effect size", () => {
  // A small fixture: a calibrated large effect, an over-confident insufficient
  // small effect, and a badly-wrong framing call.
  const fixture = (): DecisionForecast[] => [
    resolveDecision(
      unresolved({ decision_id: "large-good", effect_size: "large", prediction_ppm: 800_000 }),
      resolution({ outcome: "held" }),
    ),
    resolveDecision(
      unresolved({ decision_id: "small-unresolvable", effect_size: "small", prediction_ppm: 650_000 }),
      resolution({ outcome: "insufficient", resolution_instrument: "ladder-measured" }),
    ),
    resolveDecision(
      unresolved({ decision_id: "framing-wrong", effect_size: "framing", prediction_ppm: 700_000 }),
      resolution({ outcome: "falsified", resolution_instrument: "structural-reasoning" }),
    ),
  ]

  it("counts scored / insufficient / unresolved correctly", () => {
    const rep = calibrationReport(fixture())
    expect(rep.n_total).toBe(3)
    expect(rep.n_scored).toBe(2) // large-good + framing-wrong
    expect(rep.n_insufficient).toBe(1) // small-unresolvable
    expect(rep.n_unresolved).toBe(0)
  })

  it("excludes the insufficient decision from the blended mean Brier (abstain over force)", () => {
    const rep = calibrationReport(fixture())
    // blended mean over {large-good: (0.8-1)^2=40000, framing-wrong: (0.7-0)^2=490000} = 265000
    expect(rep.blended_mean_brier_ppm).toBe(265_000)
    const small = rep.by_effect.find((b) => b.effect_size === "small")!
    expect(small.n).toBe(1)
    expect(small.n_scored).toBe(0)
    expect(small.n_insufficient).toBe(1)
    expect(small.mean_brier_ppm).toBeNull() // nothing scoreable in the bucket
  })

  it("splits objective (calibration evidence) from reflection (not evidence)", () => {
    const rep = calibrationReport(fixture())
    // objective = ladder-measured: large-good (scored 40000) + small-unresolvable (insufficient)
    expect(rep.objective.n).toBe(2)
    expect(rep.objective.n_scored).toBe(1)
    expect(rep.objective.n_insufficient).toBe(1)
    expect(rep.objective.mean_brier_ppm).toBe(40_000)
    // reflection = structural-reasoning: framing-wrong (490000)
    expect(rep.reflection.n_scored).toBe(1)
    expect(rep.reflection.mean_brier_ppm).toBe(490_000)
  })

  it("the honesty gate: reconstructed predictions bar headline calibration", () => {
    const rep = calibrationReport(fixture())
    expect(rep.evidence_class).toBe("retrospective-demo")
    expect(rep.headline_eligible).toBe(false)
    expect(rep.scored_prediction_basis).toEqual({ logged: 0, reconstructed: 2 })
  })

  it("headline becomes eligible only when objective-scored predictions are LOGGED", () => {
    const decisions = [
      resolveDecision(
        unresolved({ decision_id: "logged-objective", prediction_basis: "logged", prediction_ppm: 800_000 }),
        resolution({ outcome: "held", resolution_instrument: "ladder-measured" }),
      ),
    ]
    const rep = calibrationReport(decisions)
    expect(rep.evidence_class).toBe("calibration-evidence")
    expect(rep.headline_eligible).toBe(true)
    expect(rep.objective.mean_brier_ppm).toBe(40_000)
  })

  it("the evidence bucket = objective AND logged — visible even beside reconstructed objective rows", () => {
    const decisions = [
      // a reconstructed objective row (like the original cabt-calibration rows) — NOT evidence
      resolveDecision(
        unresolved({ decision_id: "recon-obj", prediction_basis: "reconstructed", prediction_ppm: 900_000 }),
        resolution({ outcome: "held", resolution_instrument: "ladder-measured" }),
      ),
      // a logged objective row — genuine evidence
      resolveDecision(
        unresolved({ decision_id: "logged-obj", prediction_basis: "logged", prediction_ppm: 800_000 }),
        resolution({ outcome: "held", resolution_instrument: "ladder-measured" }),
      ),
    ]
    const rep = calibrationReport(decisions)
    expect(rep.objective.n_scored).toBe(2) // both are objective…
    expect(rep.evidence.n_scored).toBe(1) // …but only the logged one is evidence
    expect(rep.evidence.mean_brier_ppm).toBe(40_000) // (0.8-1)^2
    expect(rep.headline_eligible).toBe(false) // the reconstructed objective row still bars the headline
  })

  it("rejects duplicate decision_ids (silent double-count guard)", () => {
    const a = resolveDecision(unresolved({ decision_id: "dup" }), resolution())
    const b = resolveDecision(unresolved({ decision_id: "dup" }), resolution({ outcome: "falsified" }))
    expect(() => calibrationReport([a, b])).toThrow(/duplicate decision_id/)
  })

  it("buckets Brier by effect size", () => {
    const rep = calibrationReport(fixture())
    expect(rep.by_effect.find((b) => b.effect_size === "large")!.mean_brier_ppm).toBe(40_000)
    expect(rep.by_effect.find((b) => b.effect_size === "framing")!.mean_brier_ppm).toBe(490_000)
  })

  it("flags over-confidence-vs-resolution: a confident call on an unresolvable difference", () => {
    const rep = calibrationReport(fixture())
    expect(rep.overconfident_vs_resolution.map((d) => d.decision_id)).toEqual(["small-unresolvable"])
  })

  it("does NOT flag a near-0.5 insufficient call as over-confident", () => {
    const decisions = [
      resolveDecision(
        unresolved({ decision_id: "small-humble", effect_size: "small", prediction_ppm: 550_000 }),
        resolution({ outcome: "insufficient" }),
      ),
    ]
    const rep = calibrationReport(decisions)
    expect(rep.overconfident_vs_resolution).toHaveLength(0)
  })

  it("identifies worst / best and the weakest resolution trust", () => {
    const rep = calibrationReport(fixture())
    expect(rep.worst?.decision_id).toBe("framing-wrong") // 490000
    expect(rep.best?.decision_id).toBe("large-good") // 40000
    // scored instruments: ladder-measured(4) + structural-reasoning(2) → min 2
    expect(rep.min_resolution_trust).toBe(2)
  })
})

describe("the cabt seed ledger (the real deliverable)", () => {
  const ledger = buildCabtCalibrationLedger()

  it("formalizes all 8 decisions and every record is valid", () => {
    expect(ledger).toHaveLength(8)
    for (const f of ledger) expect(() => assertDecisionValid(f)).not.toThrow()
  })

  it("scores large effects well and abstains on the small one (the §5b finding)", () => {
    const rep = calibrationReport(ledger)
    const large = rep.by_effect.find((b) => b.effect_size === "large")!
    const small = rep.by_effect.find((b) => b.effect_size === "small")!
    const framing = rep.by_effect.find((b) => b.effect_size === "framing")!
    // large-effect eval-gated calls are well-calibrated (low Brier)…
    expect(large.mean_brier_ppm).not.toBeNull()
    expect(large.mean_brier_ppm!).toBeLessThan(framing.mean_brier_ppm!)
    // …the one small effect (n_worlds) is unresolvable → unscored…
    expect(small.n_scored).toBe(0)
    expect(small.n_insufficient).toBe(1)
    // …and the n_worlds decision is flagged over-confident-vs-resolution.
    expect(rep.overconfident_vs_resolution.map((d) => d.decision_id)).toContain("ship-n-worlds-16")
  })

  it("the worst miss is an imported framing belief, the best calls are eval-gated", () => {
    const rep = calibrationReport(ledger)
    expect(rep.worst?.effect_size).toBe("framing")
    expect(rep.best?.effect_size).toBe("large")
  })
})

describe("classifyEffectFromMargin — the mechanical effect-size rule (M5)", () => {
  it("large iff margin ≥ 0.20; small below; framing when no margin", () => {
    expect(classifyEffectFromMargin(200_000)).toBe("large") // |wr-0.5| = 0.20
    expect(classifyEffectFromMargin(270_000)).toBe("large") // 0.77 vs 0.5
    expect(classifyEffectFromMargin(199_999)).toBe("small")
    expect(classifyEffectFromMargin(0)).toBe("small")
    expect(classifyEffectFromMargin(null)).toBe("framing")
  })
  it("rejects a negative / non-finite / non-integer / impossible margin", () => {
    expect(() => classifyEffectFromMargin(-1)).toThrow()
    expect(() => classifyEffectFromMargin(Number.NaN)).toThrow()
    expect(() => classifyEffectFromMargin(1.5)).toThrow() // non-integer ppm
    expect(() => classifyEffectFromMargin(800_000)).toThrow(/raw winrate/) // margin can't exceed 0.5
  })
})

describe("pre-registration — the forward fix (log p before the outcome)", () => {
  const logged = (over: Partial<DecisionForecast> = {}): DecisionForecast =>
    unresolved({ decision_id: "preg-1", prediction_basis: "logged", ...over })

  it("registers a LOGGED, unresolved forecast and reads it back", async () => {
    const path = tmpPath()
    await registerDecision(logged(), path)
    const reg = await readDecisionRegistry(path)
    expect(reg).toHaveLength(1)
    expect(findRegisteredDecision(reg, "preg-1")?.prediction_basis).toBe("logged")
  })

  it("refuses a reconstructed prediction (not evidence)", async () => {
    const path = tmpPath()
    await expect(registerDecision(logged({ prediction_basis: "reconstructed" }), path)).rejects.toThrow(/logged/)
  })

  it("refuses an already-resolved forecast and a double registration", async () => {
    const path = tmpPath()
    const resolved = resolveDecision(logged(), resolution())
    await expect(registerDecision(resolved, path)).rejects.toThrow(/already-resolved/)
    await registerDecision(logged(), path)
    await expect(registerDecision(logged(), path)).rejects.toThrow(/already registered/)
  })

  it("resolveRegisteredDecision enforces the franchise rule (no unregistered settle)", async () => {
    const registryPath = tmpPath()
    const calibrationPath = tmpPath()
    await expect(
      resolveRegisteredDecision("never-registered", resolution(), 270_000, { registryPath, calibrationPath }),
    ).rejects.toBeInstanceOf(NoRegisteredDecisionError)
  })

  it("resolves a registered bet: measured effect from the margin, scored to the calibration ledger", async () => {
    const registryPath = tmpPath()
    const calibrationPath = tmpPath()
    // pre-register with a PREDICTED effect of "large"…
    await registerDecision(logged({ decision_id: "preg-x", prediction_ppm: 700_000, effect_size: "large" }), registryPath)
    // …but the OBSERVED margin is small (0.05) → the measured effect overrides to "small".
    const resolved = await resolveRegisteredDecision(
      "preg-x",
      { resolution_instrument: "ladder-measured", ground_truth: "ladder settled it", outcome: "held", resolved_ts: 9_000 },
      50_000,
      { registryPath, calibrationPath },
    )
    expect(resolved.effect_size).toBe("small") // data, not the bet's predicted label
    expect(resolved.outcome).toBe("held")
    expect(resolved.brier_ppm).toBe(90_000) // (0.7-1)^2
    // and it landed on the calibration ledger, chain intact
    const { envelopes } = await readCalibrationLedger(calibrationPath)
    expect(envelopes).toHaveLength(1)
    expect(verifyCalibrationChain(envelopes).valid).toBe(true)
  })

  it("binds the resolved record to its registration by entry_hash (provenance proof)", async () => {
    const registryPath = tmpPath()
    const calibrationPath = tmpPath()
    await registerDecision(logged({ decision_id: "preg-bind", prediction_ppm: 700_000 }), registryPath)
    const regEnv = (await readCalibrationLedger(registryPath)).envelopes[0]
    const resolved = await resolveRegisteredDecision(
      "preg-bind",
      { resolution_instrument: "ladder-measured", ground_truth: "x", outcome: "held", resolved_ts: 9_000 },
      270_000,
      { registryPath, calibrationPath },
    )
    // the resolved record carries the registry envelope's hash → proves scored p == logged p
    expect(resolved.registered_entry_hash).toBe(regEnv.entry_hash)
    expect(() => assertDecisionValid(resolved)).not.toThrow()
  })

  it("a clean evidence ledger (logged-only) flips to calibration-evidence", async () => {
    const registryPath = tmpPath()
    const calibrationPath = tmpPath() // a SEPARATE evidence ledger (no reconstructed rows)
    await registerDecision(logged({ decision_id: "preg-ev", prediction_ppm: 800_000 }), registryPath)
    await resolveRegisteredDecision(
      "preg-ev",
      { resolution_instrument: "ladder-measured", ground_truth: "x", outcome: "held", resolved_ts: 9_000 },
      270_000,
      { registryPath, calibrationPath },
    )
    const decisions = (await readCalibrationLedger(calibrationPath)).envelopes.map(decisionFromEnvelope)
    const rep = calibrationReport(decisions)
    expect(rep.evidence.n_scored).toBe(1)
    expect(rep.evidence_class).toBe("calibration-evidence") // H1: reachable on a clean ledger
    expect(rep.headline_eligible).toBe(true)
  })

  it("refuses double resolution (a bet is scored once on the calibration ledger)", async () => {
    const registryPath = tmpPath()
    const calibrationPath = tmpPath()
    await registerDecision(logged({ decision_id: "preg-dup" }), registryPath)
    const settle = (over = {}): DecisionResolution => ({
      resolution_instrument: "ladder-measured", ground_truth: "x", outcome: "held", resolved_ts: 9_000, ...over,
    })
    await resolveRegisteredDecision("preg-dup", settle(), 270_000, { registryPath, calibrationPath })
    await expect(
      resolveRegisteredDecision("preg-dup", settle({ outcome: "falsified" }), 270_000, { registryPath, calibrationPath }),
    ).rejects.toThrow(/already resolved/)
  })

  it("refuses a ladder-measured ship with a null margin (effect-rule bypass guard)", async () => {
    const registryPath = tmpPath()
    const calibrationPath = tmpPath()
    await registerDecision(logged({ decision_id: "preg-null", action: "ship" }), registryPath)
    await expect(
      resolveRegisteredDecision(
        "preg-null",
        { resolution_instrument: "ladder-measured", ground_truth: "x", outcome: "held", resolved_ts: 9_000 },
        null,
        { registryPath, calibrationPath },
      ),
    ).rejects.toThrow(/bypass the effect-size rule/)
  })

  it("refuses to resolve against a TAMPERED registry", async () => {
    const registryPath = tmpPath()
    const calibrationPath = tmpPath()
    await registerDecision(logged({ decision_id: "preg-tamper", prediction_ppm: 700_000 }), registryPath)
    // tamper the registry body without recomputing the hash
    const raw = await readFile(registryPath, "utf-8")
    const lines = raw.split("\n").filter(Boolean)
    const env = JSON.parse(lines[0]); env.forecast.prediction_ppm = 1; lines[0] = JSON.stringify(env)
    await writeFile(registryPath, lines.join("\n") + "\n")
    await expect(
      resolveRegisteredDecision(
        "preg-tamper",
        { resolution_instrument: "ladder-measured", ground_truth: "x", outcome: "held", resolved_ts: 9_000 },
        270_000,
        { registryPath, calibrationPath },
      ),
    ).rejects.toThrow(/tampered registry/)
  })
})

describe("the cabt pre-registration set (the real deliverable)", () => {
  it("is 3 genuine LOGGED, unresolved forecasts with honest spread", () => {
    expect(PRE_REGISTERED).toHaveLength(3)
    for (const f of PRE_REGISTERED) {
      expect(() => assertDecisionValid(f)).not.toThrow()
      expect(f.prediction_basis).toBe("logged")
      expect(f.outcome).toBeNull() // unresolved — awaiting the ladder
      expect(f.brier_ppm).toBeNull()
    }
    // a real spread of confidence (not all 0.5 gimmes), all betting open questions
    const ps = PRE_REGISTERED.map((f) => f.prediction_ppm)
    expect(new Set(ps).size).toBe(3)
  })

  it("a report over the pre-registered set is all-unresolved (no scored evidence yet)", () => {
    const rep = calibrationReport(PRE_REGISTERED)
    expect(rep.n_unresolved).toBe(3)
    expect(rep.n_scored).toBe(0)
    expect(rep.objective.n_scored).toBe(0) // honest: pipeline grows, scored does not — until the ladder speaks
  })
})

describe("the hash-chained calibration ledger", () => {
  it("appends, reads back, and replays clean", async () => {
    const path = tmpPath()
    const writer = new DecisionLedgerWriter(path)
    const ledger = buildCabtCalibrationLedger()
    for (const f of ledger) await writer.append(f)

    const { envelopes, corrupt_tail } = await readCalibrationLedger(path)
    expect(corrupt_tail).toBe(false)
    expect(envelopes).toHaveLength(8)
    const chain = verifyCalibrationChain(envelopes)
    expect(chain.valid).toBe(true)
    expect(chain.length).toBe(8)
    // round-trip: decoded record equals the source.
    expect(decisionFromEnvelope(envelopes[0]).decision_id).toBe(ledger[0].decision_id)
  })

  it("detects tampering: a flipped outcome breaks the entry_hash", async () => {
    const path = tmpPath()
    const writer = new DecisionLedgerWriter(path)
    for (const f of buildCabtCalibrationLedger()) await writer.append(f)

    const raw = await readFile(path, "utf-8")
    const lines = raw.split("\n").filter(Boolean)
    // tamper with the forecast body of the first line without recomputing the hash
    const env = JSON.parse(lines[0])
    env.forecast.prediction_ppm = 1
    lines[0] = JSON.stringify(env)
    await writeFile(path, lines.join("\n") + "\n")

    const { envelopes } = await readCalibrationLedger(path)
    const chain = verifyCalibrationChain(envelopes)
    expect(chain.valid).toBe(false)
    expect(chain.brokenAt).toBe(0)
  })

  it("re-hashes identically on re-run (deterministic ledger)", async () => {
    const a = tmpPath()
    const b = tmpPath()
    for (const f of buildCabtCalibrationLedger()) await new DecisionLedgerWriter(a).append(f)
    for (const f of buildCabtCalibrationLedger()) await new DecisionLedgerWriter(b).append(f)
    const ea = (await readCalibrationLedger(a)).envelopes
    const eb = (await readCalibrationLedger(b)).envelopes
    expect(ea.map((e) => e.entry_hash)).toEqual(eb.map((e) => e.entry_hash))
  })
})
