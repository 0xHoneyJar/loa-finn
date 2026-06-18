// src/research/cost-atom-research.test.ts — research CostAtom invariants
// (bd-8ywq.6 · Acceptance Contracts A + E).
//
// The stakes are experimentation integrity: an atom that closes after the
// finding, a float in a stored cost, a failure that leaves a chain gap, or a
// double-counted LLM spend each corrupt the lab's ledger. These tests ARE the
// contract — the four required acceptance checks plus the structural-enforcement
// guarantees that back them.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ProbeCeilingError,
  ResearchAtomWriter,
  ResearchSensorError,
  assertAtomIntegerMicro,
  decodeAtom,
  questionHash,
  readResearchAtoms,
  reconcileSpend,
  reservationVariance,
  runMeteredResearch,
  verifyChain,
} from "./cost-atom-research.js"
import { GENESIS_HASH } from "./schemas/index.js"
import type {
  Citation,
  ModelinvEntry,
  ResearchCostAtom,
  TetlockForecast,
} from "./schemas/index.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "research-atom-test-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CITATIONS: Citation[] = [
  {
    url: "https://dune.com/queries/123",
    retrieved_ts: 1_750_000_000_000,
    http_status: 200,
    source_type: "on-chain",
    claim_support: "supports",
    confidence: "high",
  },
]

/** A successful sensor body that charges a flat actual cost. */
function okBody(actualMicro: bigint, citations: Citation[] = CITATIONS) {
  return async () => ({ finding: "the substrate served one real request", citations, actual_micro: actualMicro })
}

// ---------------------------------------------------------------------------
// Required test 1 — hash-chain continuity (tamper/break detection + genesis)
// ---------------------------------------------------------------------------

describe("hash-chain continuity (Contract A)", () => {
  it("appends a genesis-rooted chain and verifies from scratch", async () => {
    const writer = new ResearchAtomWriter(join(dir, "chain.jsonl"))
    await runMeteredResearch(
      { writer, sensor: "gemini", question: "q1", estimate_micro: 100n },
      okBody(120n),
    )
    await runMeteredResearch(
      { writer, sensor: "dune", question: "q2", estimate_micro: 0n },
      okBody(0n),
    )
    const { envelopes } = await readResearchAtoms(writer.path)
    // 2 probes × (reservation + actual) = 4 chained atoms
    expect(envelopes).toHaveLength(4)
    expect(envelopes[0].prev_hash).toBe(GENESIS_HASH)
    const v = verifyChain(envelopes)
    expect(v.valid).toBe(true)
    expect(v.brokenAt).toBeNull()
    // each link points at the prior entry_hash (genesis recompute)
    for (let i = 1; i < envelopes.length; i++) {
      expect(envelopes[i].prev_hash).toBe(envelopes[i - 1].entry_hash)
    }
  })

  it("detects a tampered stored field (entry_hash no longer recomputes)", async () => {
    const writer = new ResearchAtomWriter(join(dir, "tamper.jsonl"))
    await runMeteredResearch(
      { writer, sensor: "gemini", question: "q", estimate_micro: 100n },
      okBody(120n),
    )
    const { envelopes } = await readResearchAtoms(writer.path)
    // mutate a stored cost without recomputing entry_hash
    envelopes[1].atom.cost_micro = "999999"
    const v = verifyChain(envelopes)
    expect(v.valid).toBe(false)
    expect(v.brokenAt).toBe(1)
    expect(v.reason).toMatch(/tamper/)
  })

  it("detects a broken link (deleted/reordered line)", async () => {
    const writer = new ResearchAtomWriter(join(dir, "break.jsonl"))
    await runMeteredResearch(
      { writer, sensor: "gemini", question: "q", estimate_micro: 100n },
      okBody(120n),
    )
    await runMeteredResearch(
      { writer, sensor: "dune", question: "q2", estimate_micro: 0n },
      okBody(0n),
    )
    const { envelopes } = await readResearchAtoms(writer.path)
    // drop the genesis atom — the new head's prev_hash no longer matches GENESIS
    const broken = envelopes.slice(1)
    const v = verifyChain(broken)
    expect(v.valid).toBe(false)
    expect(v.brokenAt).toBe(0)
    expect(v.reason).toMatch(/prev_hash break/)
  })
})

// ---------------------------------------------------------------------------
// Required test 2 — integer-micro assertion (no floats reach the ledger)
// ---------------------------------------------------------------------------

describe("integer-micro discipline (Contract A · B3)", () => {
  it("stores every cost as an integer decimal string, never a float", async () => {
    const writer = new ResearchAtomWriter(join(dir, "ints.jsonl"))
    await runMeteredResearch(
      { writer, sensor: "dune", question: "q", estimate_micro: 681n },
      okBody(681n),
    )
    const { envelopes } = await readResearchAtoms(writer.path)
    for (const env of envelopes) {
      expect(env.atom.cost_micro).toMatch(/^\d+$/)
      expect(env.atom.inference_micro).toMatch(/^\d+$/)
      expect(Number.isInteger(env.atom.ts)).toBe(true)
    }
  })

  it("rejects float contamination at append time", async () => {
    const writer = new ResearchAtomWriter(join(dir, "float.jsonl"))
    const bad: ResearchCostAtom = {
      atom_id: "01TEST",
      kind: "actual_cost",
      status: "settled",
      sensor: "gemini",
      question_hash: questionHash("q"),
      cost_micro: 1.5 as unknown as bigint, // deliberate float contamination
      inference_micro: 0n,
      citations_count: 1,
      grounded: true,
      ts: 1_750_000_000_000,
      reservation_ref: "01RES",
      error_class: null,
      modelinv_ref: null,
      provider_intended: null,
      provider_resolved: null,
    }
    await expect(writer.append(bad)).rejects.toThrow(/integer-micro/)
    expect(() => assertAtomIntegerMicro(bad)).toThrow(/integer-micro/)
  })
})

// ---------------------------------------------------------------------------
// Required test 3 — a failed call emits a linked failure-atom, no chain gap
// ---------------------------------------------------------------------------

describe("typed failure atoms (Contract A · E #3)", () => {
  it("a failed sensor call writes a linked, chained failure atom and surfaces no finding", async () => {
    const writer = new ResearchAtomWriter(join(dir, "fail.jsonl"))
    let finding: string | undefined
    class SensorTimeout extends Error {
      constructor() {
        super("dune engine cap")
        this.name = "SensorTimeout"
      }
    }
    await expect(
      runMeteredResearch(
        { writer, sensor: "dune", question: "q", estimate_micro: 50n },
        async () => {
          throw new SensorTimeout()
        },
      ).then((r) => {
        finding = r.finding // unreachable: a finding must never escape a failed probe
      }),
    ).rejects.toThrow(/dune engine cap/)
    expect(finding).toBeUndefined()

    const { envelopes, atoms } = await readResearchAtoms(writer.path)
    // reservation + failure = 2 atoms, NO gap in the chain
    expect(atoms.map((a) => a.kind)).toEqual(["budget_reservation", "failure"])
    expect(verifyChain(envelopes).valid).toBe(true)
    const failure = atoms[1]
    expect(failure.kind).toBe("failure")
    expect(failure.status).toBe("failed")
    expect(failure.error_class).toBe("SensorTimeout")
    expect(failure.reservation_ref).toBe(atoms[0].atom_id) // linked to its reservation
    expect(failure.cost_micro).toBe(0n) // a plain error charges 0 — no evidence of spend
  })

  it("a ResearchSensorError records the partial spend incurred before it failed (FIX#2)", async () => {
    const writer = new ResearchAtomWriter(join(dir, "partial.jsonl"))
    await expect(
      runMeteredResearch(
        { writer, sensor: "dune", question: "q", estimate_micro: 700n },
        async () => {
          // the Dune query RAN (spent 681µ) then the parse blew up — that spend
          // is real and must be metered, not lost to a chain gap.
          throw new ResearchSensorError("dune result parse failed", 681n)
        },
      ),
    ).rejects.toThrow(/parse failed/)
    const { envelopes, atoms } = await readResearchAtoms(writer.path)
    expect(atoms.map((a) => a.kind)).toEqual(["budget_reservation", "failure"])
    const failure = atoms[1]
    expect(failure.kind).toBe("failure")
    expect(failure.error_class).toBe("ResearchSensorError")
    expect(failure.cost_micro).toBe(681n) // the partial spend was recorded
    expect(verifyChain(envelopes).valid).toBe(true) // still no chain gap
  })

  it("clamps a negative/invalid partial_micro to 0 (no float/negative reaches the ledger)", async () => {
    const writer = new ResearchAtomWriter(join(dir, "partial-clamp.jsonl"))
    await expect(
      runMeteredResearch(
        { writer, sensor: "gemini", question: "q", estimate_micro: 0n },
        async () => {
          throw new ResearchSensorError("bad", -5n)
        },
      ),
    ).rejects.toThrow(/bad/)
    const { atoms } = await readResearchAtoms(writer.path)
    expect(atoms[1].cost_micro).toBe(0n)
  })
})

// ---------------------------------------------------------------------------
// Required test 4 — a single LLM call's spend appears EXACTLY ONCE
// ---------------------------------------------------------------------------

describe("MODELINV dedup (Contract E #4)", () => {
  it("a Cheval-routed call's spend appears once across the research JSONL + MODELINV", async () => {
    const writer = new ResearchAtomWriter(join(dir, "dedup.jsonl"))
    // The MODELINV (cheval metering) entry that already metered the LLM spend.
    const modelinv: ModelinvEntry = {
      request_id: "req-abc123def456",
      trace_id: "tr-grok-001",
      agent: "grok-sigint",
      provider: "xai",
      model: "grok-4",
      tokens_in: 2000,
      tokens_out: 500,
      tokens_reasoning: 0,
      cost_micro_usd: 681, // integer micro-USD, already metered by MODELINV
      ts: "2026-06-13T00:00:00.000Z",
    }
    // The research atom REFERENCES it; inference_micro stays 0 (not re-charged).
    await runMeteredResearch(
      { writer, sensor: "grok", question: "is x402 volume real?", estimate_micro: 700n },
      async () => ({
        finding: "x402 ~$17K/day, ~90% gamed",
        citations: CITATIONS,
        actual_micro: 0n, // no non-LLM cost on this call
        inference_micro: 0n, // dedup: the LLM spend lives in MODELINV
        modelinv_ref: {
          ledger_path: ".run/cost-ledger.jsonl",
          request_id: modelinv.request_id,
          trace_id: modelinv.trace_id,
          cost_micro: BigInt(modelinv.cost_micro_usd),
        },
      }),
    )

    const { atoms } = await readResearchAtoms(writer.path)
    const recon = reconcileSpend(atoms, [modelinv])
    // 681 appears exactly once — not 0 (lost) and not 1362 (double-counted)
    expect(recon.total_micro).toBe(681n)
    expect(recon.double_counted).toEqual([])
    expect(recon.missing_modelinv).toEqual([])
    // and the research ledger itself charged 0 inference for this call
    const actual = atoms.find((a) => a.kind === "actual_cost")!
    expect(actual.inference_micro).toBe(0n)
    expect(actual.modelinv_ref?.request_id).toBe(modelinv.request_id)
  })

  it("flags a double-count when an atom both references MODELINV and charges inference", () => {
    const modelinv: ModelinvEntry = {
      request_id: "req-dup",
      trace_id: "tr-x",
      agent: "a",
      provider: "xai",
      model: "grok-4",
      tokens_in: 1,
      tokens_out: 1,
      tokens_reasoning: 0,
      cost_micro_usd: 500,
      ts: "2026-06-13T00:00:00.000Z",
    }
    const doubleCharged: ResearchCostAtom = {
      atom_id: "01DUP",
      kind: "actual_cost",
      status: "settled",
      sensor: "grok",
      question_hash: questionHash("q"),
      cost_micro: 500n,
      inference_micro: 500n, // forbidden: also charged locally
      citations_count: 1,
      grounded: true,
      ts: 1_750_000_000_000,
      reservation_ref: "01RES",
      error_class: null,
      modelinv_ref: {
        ledger_path: ".run/cost-ledger.jsonl",
        request_id: "req-dup",
        trace_id: "tr-x",
        cost_micro: 500n,
      },
      provider_intended: null,
      provider_resolved: null,
    }
    const recon = reconcileSpend([doubleCharged], [modelinv])
    expect(recon.double_counted).toEqual([{ atom_id: "01DUP", request_id: "req-dup" }])
  })

  it("the runMeteredResearch API makes the double-count unrepresentable", async () => {
    const writer = new ResearchAtomWriter(join(dir, "guard.jsonl"))
    await expect(
      runMeteredResearch(
        { writer, sensor: "grok", question: "q", estimate_micro: 700n },
        async () => ({
          finding: "x",
          citations: CITATIONS,
          actual_micro: 0n,
          inference_micro: 5n, // non-zero WITH a modelinv_ref ⇒ rejected
          modelinv_ref: {
            ledger_path: ".run/cost-ledger.jsonl",
            request_id: "req-1",
            trace_id: "tr-1",
            cost_micro: 5n,
          },
        }),
      ),
    ).rejects.toThrow(/dedup/)
  })
})

// ---------------------------------------------------------------------------
// Contract A — structural enforcement: closes-before-return, estimate/actual,
// hard ceiling.
// ---------------------------------------------------------------------------

describe("structural cost gate (Contract A)", () => {
  it("the finding is only obtainable after the actual_cost atom is durable", async () => {
    const writer = new ResearchAtomWriter(join(dir, "closes.jsonl"))
    const res = await runMeteredResearch(
      { writer, sensor: "gemini", question: "q", estimate_micro: 100n },
      okBody(120n),
    )
    // The result exists ⇒ the atom is already on disk (no remembered side-effect).
    const { atoms } = await readResearchAtoms(writer.path)
    const actual = atoms.find((a) => a.kind === "actual_cost")
    expect(actual).toBeDefined()
    expect(res.finding).toBe("the substrate served one real request")
    expect(res.grounded).toBe(true)
  })

  it("ungrounded (zero-citation) results are marked grounded:false", async () => {
    const writer = new ResearchAtomWriter(join(dir, "ungrounded.jsonl"))
    const res = await runMeteredResearch(
      { writer, sensor: "gemini", question: "q", estimate_micro: 100n },
      okBody(120n, []),
    )
    expect(res.grounded).toBe(false)
    const { atoms } = await readResearchAtoms(writer.path)
    expect(atoms.find((a) => a.kind === "actual_cost")!.grounded).toBe(false)
  })

  it("emits a budget_reservation BEFORE the call and links the actual to it", async () => {
    const writer = new ResearchAtomWriter(join(dir, "split.jsonl"))
    await runMeteredResearch(
      { writer, sensor: "dune", question: "q", estimate_micro: 100n },
      okBody(140n),
    )
    const { atoms } = await readResearchAtoms(writer.path)
    const [reservation, actual] = atoms
    expect(reservation.kind).toBe("budget_reservation")
    expect(reservation.cost_micro).toBe(100n) // the estimate, surfaced first
    expect(actual.kind).toBe("actual_cost")
    expect(actual.reservation_ref).toBe(reservation.atom_id)
    expect(reservationVariance(reservation, actual)).toBe(40n) // 140 actual − 100 est
  })

  it("aborts over the hard ceiling before the sensor call runs", async () => {
    const writer = new ResearchAtomWriter(join(dir, "ceiling.jsonl"))
    let bodyRan = false
    await expect(
      runMeteredResearch(
        { writer, sensor: "gemini", question: "q", estimate_micro: 5_000n, ceiling_micro: 1_000n },
        async () => {
          bodyRan = true
          return { finding: "x", citations: CITATIONS, actual_micro: 0n }
        },
      ),
    ).rejects.toBeInstanceOf(ProbeCeilingError)
    expect(bodyRan).toBe(false)
    const { envelopes, atoms } = await readResearchAtoms(writer.path)
    // FIX#1: reservation recorded the blocked attempt AND a TERMINAL failure
    // atom settles it — no actual_cost, no dangling `reserved`, chain intact.
    expect(atoms.map((a) => a.kind)).toEqual(["budget_reservation", "failure"])
    const [reservation, failure] = atoms
    expect(reservation.status).toBe("reserved")
    expect(failure.status).toBe("failed")
    expect(failure.error_class).toBe("ProbeCeilingError")
    expect(failure.reservation_ref).toBe(reservation.atom_id)
    expect(failure.cost_micro).toBe(0n)
    expect(verifyChain(envelopes).valid).toBe(true)
    // no reservation is left without a terminal (settled/failed) atom
    const reservations = atoms.filter((a) => a.kind === "budget_reservation")
    const terminals = atoms.filter((a) => a.kind !== "budget_reservation")
    for (const r of reservations) {
      expect(terminals.some((t) => t.reservation_ref === r.atom_id)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Contract E — schema shape sanity (the nullable ERC-8004 attestation)
// ---------------------------------------------------------------------------

describe("schemas (Contract E)", () => {
  it("a V1 TETLOCK forecast carries a null attestation (ERC-8004 reserved)", () => {
    const forecast: TetlockForecast = {
      forecast_id: "fc-001",
      question_hash: questionHash("does the substrate serve one real request?"),
      probability_ppm: 350_000,
      resolution_criterion: "on-chain: a non-zero x402 settlement to the agent TBA within 7d",
      base_rate_ppm: null,
      created_ts: 1_750_000_000_000,
      resolved_ts: null,
      outcome: null,
      brier_ppm: null,
      attestation: null, // V1: wire, don't build
    }
    expect(forecast.attestation).toBeNull()
    expect(Number.isInteger(forecast.probability_ppm)).toBe(true)
  })

  it("decodeAtom rehydrates bigint cost fields from decimal strings", async () => {
    const writer = new ResearchAtomWriter(join(dir, "decode.jsonl"))
    await runMeteredResearch(
      { writer, sensor: "dune", question: "q", estimate_micro: 12_345n },
      okBody(67_890n),
    )
    const { envelopes } = await readResearchAtoms(writer.path)
    const decoded = decodeAtom(envelopes[1].atom)
    expect(decoded.cost_micro).toBe(67_890n)
    expect(typeof decoded.cost_micro).toBe("bigint")
  })
})
