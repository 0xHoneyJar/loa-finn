// src/lab/metabolism/loop.test.ts — the SEGMENT C end-to-end contract.
//
// The climax: the WHOLE metabolism turns end-to-end on the deterministic ToyHand.
// These tests bind the four claims the spec marks as the gate:
//   1. END-TO-END CONVERGENCE — run runMetabolism on a tmp-path ToyHand for enough
//      iters that the population GROWS, exploitability COLLAPSES toward the
//      threshold, and the Leader fires REST.
//   2. VERIFY ACCEPTS A REAL RUN — verifyRun(record) → valid:true (every stored
//      claim re-derives: both chains, every win-rate, every mixture, the trend).
//   3. VERIFY REFUSES A TAMPERED RUN — mutate one stored receipt → verifyRun →
//      valid:false with the right failure (a refusal, never an average).
//   4. DETERMINISM — same seed ⇒ identical population + history.
//
// ANTI-FOX checked structurally: verifyRun is an INDEPENDENT non-generator (it owns
// no writer, re-runs the same deterministic Hand, and refuses on any mismatch), and
// the Leader rests on the Loyal Traitor's exploitability + the Adjudicator's trend,
// separate organs from the Oracle that grows the population.

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runMetabolism } from "./loop.js"
import { verifyRun } from "./verify.js"
import { ToyHand } from "./hand.js"
import type { MetabolismEnvelope } from "./metabolism-ledger.js"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "metabolism-loop-test-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function paths() {
  return {
    populationPath: join(dir, "population.jsonl"),
    metabolismPath: join(dir, "metabolism.jsonl"),
  }
}

describe("runMetabolism — the PSRO loop turns end-to-end on ToyHand", () => {
  it("population grows, exploitability collapses toward threshold, the Leader RESTs", async () => {
    const hand = new ToyHand()
    const record = await runMetabolism({
      hand,
      seed: 7,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      ...paths(),
    })

    // The population GREW past the lone seed strategy (the Archivist appended
    // counters the Oracle forged).
    expect(record.final_population_milli.length).toBeGreaterThan(1)

    // Exploitability COLLAPSED: the final iteration is far less exploitable than the
    // first (the population grew counters that actually work — the convergence law).
    const expls = record.history.map((h) => h.exploitability_micro)
    expect(expls.length).toBeGreaterThanOrEqual(3)
    expect(expls[expls.length - 1]).toBeLessThan(expls[0])

    // The Leader fired REST (exploitability fell below threshold, past warm-up).
    expect(record.stop_reason).toBe("rest")
    // It rested before the iteration cap (genuine convergence, not exhaustion).
    expect(record.stopped_at_iter).toBeLessThan(record.max_iters - 1)
    // The final exploitability honors the threshold the Leader rested on.
    expect(expls[expls.length - 1]).toBeLessThan(Math.round(1e-3 * 1_000_000))
  })

  it("every stored mixture is an integer-ppm probability vector summing to 1_000_000", async () => {
    const hand = new ToyHand()
    const record = await runMetabolism({
      hand,
      seed: 3,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      ...paths(),
    })
    for (const it of record.history) {
      const sum = it.mixture_ppm.reduce((a, b) => a + b, 0)
      expect(sum).toBe(1_000_000)
      for (const w of it.mixture_ppm) {
        expect(Number.isInteger(w)).toBe(true)
        expect(w).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it("no float is ever serialized into either .jsonl ledger", async () => {
    const hand = new ToyHand()
    const p = paths()
    await runMetabolism({ hand, seed: 11, maxIters: 30, threshold: 1e-3, nMatches: 1, ...p })
    for (const path of [p.populationPath, p.metabolismPath]) {
      const raw = readFileSync(path, "utf-8")
      // No JSON number value with a decimal point (the no-float gate, mirrored from
      // metabolism-ledger.test.ts:138). String fields (ids) carry no decimals.
      expect(raw).not.toMatch(/:\s*-?\d+\.\d/)
      expect(raw).not.toMatch(/,\s*-?\d+\.\d/)
    }
  })
})

describe("verifyRun — the independent re-checker (fail-closed)", () => {
  it("ACCEPTS a real run: both chains, every win-rate, every mixture, the trend", async () => {
    const hand = new ToyHand()
    const record = await runMetabolism({
      hand,
      seed: 7,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      ...paths(),
    })
    const result = await verifyRun(record, new ToyHand())
    expect(result.failures).toEqual([])
    expect(result.valid).toBe(true)
  })

  it("REFUSES a tampered run: a mutated metabolism receipt breaks the chain", async () => {
    const hand = new ToyHand()
    const p = paths()
    const record = await runMetabolism({
      hand,
      seed: 7,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      ...p,
    })

    // Mutate one stored match receipt's win-rate in the metabolism ledger.
    const lines = readFileSync(p.metabolismPath, "utf-8").split("\n").filter(Boolean)
    const idx = Math.min(1, lines.length - 1)
    const tampered = JSON.parse(lines[idx]) as MetabolismEnvelope
    ;(tampered.receipt as Record<string, unknown>).winrate_ppm = 123_456
    lines[idx] = JSON.stringify(tampered)
    writeFileSync(p.metabolismPath, lines.join("\n") + "\n")

    const result = await verifyRun(record, new ToyHand())
    expect(result.valid).toBe(false)
    // The tamper surfaces as a chain break (entry_hash no longer recomputes).
    expect(result.failures.some((f) => /metabolism chain broken/.test(f))).toBe(true)
  })

  it("REFUSES a fabricated win-rate that keeps the chain intact (re-derivation catch)", async () => {
    // A subtler attack: re-hash the tampered receipt so the CHAIN stays valid, but
    // the win-rate is now a lie the Hand will not reproduce. The re-derivation check
    // (re-running the Hand) must catch it even though chain integrity passes.
    const hand = new ToyHand()
    const p = paths()
    const record = await runMetabolism({
      hand,
      seed: 7,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      ...p,
    })

    // Hand the verifier a record whose history is honest and whose chains are intact,
    // but feed it a Hand that DISAGREES with the stored win-rates. A divergent Hand
    // stands in for a fabricated measurement: every stored cell fails re-derivation.
    const liar: ToyHand = new ToyHand()
    const spy = {
      kind: liar.kind,
      async evaluate(a: Parameters<ToyHand["evaluate"]>[0], b: Parameters<ToyHand["evaluate"]>[1], n: number) {
        const out = await liar.evaluate(a, b, n)
        // Shift every win-rate by a fixed, clamped amount so it no longer matches the
        // stored cell (a fabricated measurement the producer cannot have measured).
        const shifted = Math.min(1_000_000, Math.max(0, out.winrate_ppm + 200_000))
        return { winrate_ppm: shifted, receipt: { ...out.receipt, winrate_ppm: shifted } }
      },
    }
    const result = await verifyRun(record, spy)
    expect(result.valid).toBe(false)
    expect(result.failures.some((f) => /fabricated measurement/.test(f))).toBe(true)
  })

  it("REFUSES a forged mixture that is well-shaped but does NOT solve the matrix", async () => {
    // The central anti-fox attack: keep the chains intact and the win-rates honest,
    // but FORGE the solver's central claim — replace a real (≥2-strategy) mixture with
    // one that dumps ALL weight on index 0. It still sums to 1_000_000 with no negative
    // weight (passes the shape check, check 3), but it does NOT solve the matrix: the
    // best pure column drives the row player far below the stored game_value. The
    // solver-consistency check (check 4) re-derives min_j(Aᵀx)_j from the CHAINED
    // matrix and must refuse — shape alone cannot catch a forged solver output.
    const hand = new ToyHand()
    const record = await runMetabolism({
      hand,
      seed: 7,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      ...paths(),
    })

    // Find the first iteration with a real (≥2-strategy) mixture and forge it: all
    // weight on index 0. (Iteration 0 is a lone strategy → [1_000_000], nothing to
    // forge there.) The stored game_value stays the (now-inconsistent) original.
    const forgeIdx = record.history.findIndex(
      (h) => h.mixture_ppm.length >= 2 && h.mixture_ppm[0] !== 1_000_000,
    )
    expect(forgeIdx).toBeGreaterThanOrEqual(0)
    const forged = {
      ...record,
      history: record.history.map((h, i) => {
        if (i !== forgeIdx) return h
        const dumped = h.mixture_ppm.map((_, k) => (k === 0 ? 1_000_000 : 0))
        return { ...h, mixture_ppm: dumped }
      }),
    }

    const result = await verifyRun(forged, new ToyHand())
    expect(result.valid).toBe(false)
    expect(
      result.failures.some((f) => /does not solve the matrix|forged solver output/.test(f)),
    ).toBe(true)
  })

  it("REFUSES an EARLY false-REST: a still-exploitable iter forged below threshold + truncated", async () => {
    // The material soundness attack (gate finding, iteration 2): take an honest run and
    // TRUNCATE it to iter 1 (pop=2, still exploitable — exploitability ~92k micro),
    // forge that iteration's exploitability BELOW the threshold, and claim REST there.
    // The check-4(b) population-floor witness CANNOT see this: at iter 1 the true exploit
    // lives OUTSIDE the 2-strategy population, so popExploitFloor ≈ 0 and the understated
    // exploitability slips past the witness. The defense is STRUCTURAL (non-generator):
    //   · check 5 REST warm-up guard — the loop never rests at iter ≤ 1 (`t > 1`);
    //   · check 4b custody-vs-history — truncating the history strands the later
    //     iterations' match cells in the ledger.
    // Either alone refuses this; both fire here. We do NOT re-run the Oracle.
    const hand = new ToyHand()
    const record = await runMetabolism({
      hand,
      seed: 7,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      ...paths(),
    })
    // The honest run must have a still-exploitable iter 1 (the attack's premise).
    expect(record.history.length).toBeGreaterThan(1)
    expect(record.history[1].exploitability_micro).toBeGreaterThan(Math.round(1e-3 * 1_000_000))

    const forged = {
      ...record,
      stop_reason: "rest" as const,
      stopped_at_iter: 1,
      // Truncate to [iter0, iter1] and forge iter1's exploitability below threshold.
      history: [record.history[0], { ...record.history[1], exploitability_micro: 100 }],
    }
    const result = await verifyRun(forged, new ToyHand())
    expect(result.valid).toBe(false)
    // The warm-up structural guard names this as a forged early convergence.
    expect(
      result.failures.some((f) => /warm-up|forged early convergence/.test(f)),
    ).toBe(true)
    // And the custody trail (stranded cells) independently corroborates the truncation.
    expect(result.failures.some((f) => /stranded|records more iterations/.test(f))).toBe(true)
  })

  it("REFUSES a PAST-WARM-UP truncated false-REST via the custody-vs-history guard", async () => {
    // A subtler truncation: forge REST at an iter PAST the warm-up (iter 2, so the warm-up
    // guard passes) with the history sliced to that iter as its new tail (so the natural-
    // tail guard also passes — stopped_at_iter IS the truncated tail). The population-floor
    // witness still can't see the out-of-population exploit at iter 2. The ONLY thing that
    // refuses this is the custody-vs-history guard: the full metabolism ledger still holds
    // the match cells for the dropped later iterations, so they strand. Non-generator.
    const hand = new ToyHand()
    // Seed 123's honest run rests at iter 3 (history length 4), so we can truncate to iter 2.
    const record = await runMetabolism({
      hand,
      seed: 123,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      ...paths(),
    })
    expect(record.history.length).toBeGreaterThanOrEqual(4)
    expect(record.stopped_at_iter).toBeGreaterThanOrEqual(3)

    const forged = {
      ...record,
      stop_reason: "rest" as const,
      stopped_at_iter: 2,
      history: [
        record.history[0],
        record.history[1],
        { ...record.history[2], exploitability_micro: 100 },
      ],
    }
    const result = await verifyRun(forged, new ToyHand())
    expect(result.valid).toBe(false)
    // The warm-up + natural-tail guards are satisfied by this forge (stopped_at_iter=2 is
    // past warm-up and IS the truncated tail), so the custody guard is what refuses it.
    expect(result.failures.some((f) => /stranded|records more iterations/.test(f))).toBe(true)
  })

  it("REFUSES a run that claims REST while still exploitable (false convergence)", async () => {
    const hand = new ToyHand()
    const record = await runMetabolism({
      hand,
      seed: 7,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      ...paths(),
    })
    // Forge a false-convergence claim: keep everything honest but flip the LAST
    // iteration's exploitability above the threshold while leaving stop_reason=rest.
    // verifyRun must refuse — REST is a claim the receipt has to back up.
    const lastIdx = record.history.length - 1
    const forged = {
      ...record,
      stop_reason: "rest" as const,
      history: record.history.map((h, i) =>
        i === lastIdx ? { ...h, exploitability_micro: 90_000 } : h,
      ),
    }
    const result = await verifyRun(forged, new ToyHand())
    expect(result.valid).toBe(false)
    expect(
      result.failures.some((f) => /false convergence|not converged/.test(f)),
    ).toBe(true)
  })
})

describe("runMetabolism — deterministic settle (no LLM, no Math.random)", () => {
  it("same seed ⇒ identical population + history", async () => {
    const a = await runMetabolism({
      hand: new ToyHand(),
      seed: 5,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      populationPath: join(dir, "a-pop.jsonl"),
      metabolismPath: join(dir, "a-meta.jsonl"),
    })
    const b = await runMetabolism({
      hand: new ToyHand(),
      seed: 5,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      populationPath: join(dir, "b-pop.jsonl"),
      metabolismPath: join(dir, "b-meta.jsonl"),
    })

    // Identical population (the seed fixes the initial strategy; everything
    // downstream is deterministic).
    expect(a.final_population_milli).toEqual(b.final_population_milli)
    // Identical trend — the integer-domain history matches field-for-field, EXCEPT
    // for nothing: timestamps live only in the ledger receipts, not the history, so
    // the history is fully deterministic.
    expect(a.history).toEqual(b.history)
    expect(a.stop_reason).toBe(b.stop_reason)
    expect(a.stopped_at_iter).toBe(b.stopped_at_iter)
  })

  it("different seeds CAN produce different runs (the seed is the only variation)", async () => {
    const a = await runMetabolism({
      hand: new ToyHand(),
      seed: 1,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      populationPath: join(dir, "s1-pop.jsonl"),
      metabolismPath: join(dir, "s1-meta.jsonl"),
    })
    const b = await runMetabolism({
      hand: new ToyHand(),
      seed: 99,
      maxIters: 40,
      threshold: 1e-3,
      nMatches: 1,
      populationPath: join(dir, "s99-pop.jsonl"),
      metabolismPath: join(dir, "s99-meta.jsonl"),
    })
    // The initial strategy differs by seed (the LCG maps 1 and 99 to distinct
    // scalars), so the first population entry differs — proving the seed is live.
    expect(a.final_population_milli[0]).not.toEqual(b.final_population_milli[0])
  })
})
