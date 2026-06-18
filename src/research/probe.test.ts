// src/research/probe.test.ts — the reality-grounded probe (bd-8ywq.7 ·
// Acceptance Contracts A, B, C, D).
//
// The one hard gate, tested from every side: NO un-metered, un-grounded finding
// can escape. The sensor body is ALWAYS injected (mock) — no real dig-search /
// Gemini call runs here (mirrors .6's okBody; zero real spend).

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ProbeCeilingError,
  ResearchAtomWriter,
  ResearchSensorError,
  questionHash,
  readResearchAtoms,
  verifyChain,
} from "./cost-atom-research.js"
import {
  ProviderResolutionError,
  type ProbeOptions,
  type SensorFn,
  type SensorOutput,
  assertProviderResolved,
  domainOf,
  isRoutingFallback,
  probe,
  validateCitations,
} from "./probe.js"
import { SpineEventWriter, readSpineEvents, verifySpineChain } from "./spine-ledger.js"
import type { Citation } from "./schemas/index.js"

const NOW = 1_750_000_000_000

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "probe-test-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function citation(over: Partial<Citation> = {}): Citation {
  return {
    url: "https://dune.com/queries/123",
    retrieved_ts: NOW,
    http_status: 200,
    source_type: "on-chain",
    claim_support: "supports",
    confidence: "high",
    ...over,
  }
}

/** A mock sensor body — the injected closure that stands in for dig-search. */
function mockSensor(over: Partial<SensorOutput> = {}): SensorFn {
  return async () => ({
    finding: over.finding ?? "x402 settled one real fee on the agent TBA",
    citations: over.citations ?? [citation()],
    cost_micro: over.cost_micro ?? 0n,
    inference_micro: over.inference_micro ?? 0n,
    modelinv_ref: over.modelinv_ref ?? null,
    provider_intended: over.provider_intended ?? "gemini",
    provider_resolved: over.provider_resolved ?? "gemini",
  })
}

/** Per-test ledgers under the temp dir (never the repo's default paths). */
function ledgers(): Pick<ProbeOptions, "atom_writer" | "spine_writer"> & {
  atomPath: string
  spinePath: string
} {
  const atomPath = join(dir, "atoms.jsonl")
  const spinePath = join(dir, "spine.jsonl")
  return {
    atom_writer: new ResearchAtomWriter(atomPath),
    spine_writer: new SpineEventWriter(spinePath),
    atomPath,
    spinePath,
  }
}

// ---------------------------------------------------------------------------
// Contract A — the cost gate is structural (closes-before-return + ceiling).
// ---------------------------------------------------------------------------

describe("Contract A — structural cost gate", () => {
  it("a claimed finding is only obtainable after its actual_cost atom is durable", async () => {
    const l = ledgers()
    const res = await probe("is x402 volume real?", {
      sensorImpl: mockSensor(),
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    expect(res.finding).not.toBeNull()
    // the result exists ⇒ a closed actual_cost atom is already on disk
    const { atoms } = await readResearchAtoms(l.atomPath)
    const actual = atoms.find((a) => a.kind === "actual_cost")
    expect(actual).toBeDefined()
    expect(actual?.atom_id).toBe(res.cost_atom.atom.atom_id)
    expect(res.cost_atom.atom.kind).toBe("actual_cost")
  })

  it("over the ceiling: auto-aborts AND writes a terminal ProbeCeilingError failure atom (no dangling reserve)", async () => {
    const l = ledgers()
    let bodyRan = false
    await expect(
      probe("expensive probe", {
        sensorImpl: async () => {
          bodyRan = true
          return mockSensor()({ question: "x", now: () => NOW })
        },
        estimate_micro: 5_000n,
        max_micro_usd_per_probe: 1_000n,
        atom_writer: l.atom_writer,
        spine_writer: l.spine_writer,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(ProbeCeilingError)
    expect(bodyRan).toBe(false)
    const { envelopes, atoms } = await readResearchAtoms(l.atomPath)
    expect(atoms.map((a) => a.kind)).toEqual(["budget_reservation", "failure"])
    expect(atoms[1].error_class).toBe("ProbeCeilingError")
    expect(atoms[1].reservation_ref).toBe(atoms[0].atom_id) // no dangling reserve
    expect(verifyChain(envelopes).valid).toBe(true)
    // no claimed bet landed for an aborted probe
    const spine = await readSpineEvents(l.spinePath).catch(() => ({ events: [] }))
    expect(spine.events.length).toBe(0)
  })

  it("a sensor failure with partial_micro records the partial spend (not lost) and surfaces no finding", async () => {
    const l = ledgers()
    let finding: string | null | undefined
    await expect(
      probe("dune query that runs then fails to parse", {
        sensorImpl: async () => {
          throw new ResearchSensorError("dune parse failed", 681n)
        },
        sensor: "dune",
        atom_writer: l.atom_writer,
        spine_writer: l.spine_writer,
        now: () => NOW,
      }).then((r) => {
        finding = r.finding
      }),
    ).rejects.toThrow(/parse failed/)
    expect(finding).toBeUndefined() // no finding escaped a failed probe
    const { envelopes, atoms } = await readResearchAtoms(l.atomPath)
    expect(atoms.map((a) => a.kind)).toEqual(["budget_reservation", "failure"])
    expect(atoms[1].cost_micro).toBe(681n) // partial spend metered
    expect(atoms[1].error_class).toBe("ResearchSensorError")
    expect(verifyChain(envelopes).valid).toBe(true)
  })

  it("surfaces the cost BEFORE the finding (Contract D ordering)", async () => {
    const l = ledgers()
    const order: string[] = []
    let surfacedEstimate: bigint | null = null
    const res = await probe("what does this probe cost?", {
      sensorImpl: async (input) => {
        order.push("sensor")
        return mockSensor()(input)
      },
      estimate_micro: 250n,
      onCostSurfaced: (est) => {
        order.push("cost")
        surfacedEstimate = est
      },
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    order.push("finding")
    expect(surfacedEstimate).toBe(250n)
    expect(res.estimate_micro).toBe(250n)
    // cost was surfaced before the sensor ran and before the finding existed
    expect(order.indexOf("cost")).toBeLessThan(order.indexOf("sensor"))
    expect(order.indexOf("cost")).toBeLessThan(order.indexOf("finding"))
  })
})

// ---------------------------------------------------------------------------
// Contract B — provider-resolution honesty.
// ---------------------------------------------------------------------------

describe("Contract B — provider-resolution honesty", () => {
  it("gemini-via-dig-search is direct: provider_resolved === provider_intended ⇒ claimed", async () => {
    const l = ledgers()
    const res = await probe("is the substrate consumed?", {
      sensorImpl: mockSensor({ provider_intended: "gemini", provider_resolved: "gemini" }),
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    expect(res.routing_fallback).toBe(false)
    expect(res.finding_class).toBe("claimed")
    expect(() => assertProviderResolved(res.provider_intended, res.provider_resolved)).not.toThrow()
    // the atom records both providers
    const { atoms } = await readResearchAtoms(l.atomPath)
    const actual = atoms.find((a) => a.kind === "actual_cost")!
    expect(actual.provider_intended).toBe("gemini")
    expect(actual.provider_resolved).toBe("gemini")
  })

  it("a routing fallback (resolved != intended) is a separate class, NOT evidence, and never landed", async () => {
    const l = ledgers()
    const res = await probe("did Bedrock serve this inference?", {
      sensorImpl: mockSensor({ provider_intended: "bedrock", provider_resolved: "anthropic" }),
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    expect(res.routing_fallback).toBe(true)
    expect(res.finding_class).toBe("routing_fallback")
    expect(res.finding).not.toBeNull() // surfaced…
    expect(res.spine_event).toBeNull() // …but NOT a claimed bet on the spine
    expect(isRoutingFallback(res.provider_intended, res.provider_resolved)).toBe(true)
    expect(() => assertProviderResolved(res.provider_intended, res.provider_resolved)).toThrow(
      ProviderResolutionError,
    )
    const { atoms } = await readResearchAtoms(l.atomPath)
    const actual = atoms.find((a) => a.kind === "actual_cost")!
    expect(actual.provider_intended).toBe("bedrock")
    expect(actual.provider_resolved).toBe("anthropic")
  })
})

// ---------------------------------------------------------------------------
// Contract C — durable spine (append-only, flock'd, replayable).
// ---------------------------------------------------------------------------

describe("Contract C — durable spine ledger", () => {
  it("a claimed finding lands a claimed-tier bet citing its closed cost atom", async () => {
    const l = ledgers()
    const res = await probe("does the substrate serve one real request?", {
      sensorImpl: mockSensor(),
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    expect(res.spine_event).not.toBeNull()
    const { events } = await readSpineEvents(l.spinePath)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("probe")
    expect(events[0].tier).toBe("claimed")
    expect(events[0].cost_atom_ref).toBe(res.cost_atom.atom.atom_id)
    expect(events[0].question_hash).toBe(questionHash("does the substrate serve one real request?"))
    expect(verifySpineChain(events).valid).toBe(true)
  })

  it("concurrent probes under flock: no lost/corrupted events, replay reproduces", async () => {
    // ONE shared atom writer (in-process chain) + ONE shared spine writer (the
    // advisory lockfile is its ONLY serializer) → genuine flock contention.
    const atomPath = join(dir, "stress-atoms.jsonl")
    const spinePath = join(dir, "stress-spine.jsonl")
    const atom_writer = new ResearchAtomWriter(atomPath)
    const spine_writer = new SpineEventWriter(spinePath)

    const N = 24
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        probe(`concurrent realness probe #${i}`, {
          sensorImpl: mockSensor({ finding: `finding ${i}` }),
          atom_writer,
          spine_writer,
          now: () => NOW,
        }),
      ),
    )
    expect(results.every((r) => r.finding_class === "claimed")).toBe(true)

    const { events, corrupt_tail } = await readSpineEvents(spinePath)
    expect(corrupt_tail).toBe(false)
    expect(events).toHaveLength(N) // nothing lost or overwritten
    // every probe's claim is present exactly once (no dup, no drop)
    const hashes = new Set(events.map((e) => e.question_hash))
    expect(hashes.size).toBe(N)
    // replay reproduces: the chain walks cleanly from genesis
    expect(verifySpineChain(events).valid).toBe(true)
    // the atom ledger also stayed intact under the same concurrency
    const { envelopes } = await readResearchAtoms(atomPath)
    expect(envelopes).toHaveLength(N * 2) // reservation + actual per probe
    expect(verifyChain(envelopes).valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Contract D — grounding gate = citation QUALITY, not count > 0.
// ---------------------------------------------------------------------------

describe("Contract D — grounding gate (citation quality)", () => {
  it("zero citations ⇒ INSUFFICIENT, finding withheld, no bet landed", async () => {
    const l = ledgers()
    const res = await probe("a question with no sources", {
      sensorImpl: mockSensor({ citations: [] }),
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    expect(res.finding_class).toBe("insufficient")
    expect(res.finding).toBeNull() // never asserted ungrounded
    expect(res.spine_event).toBeNull()
    expect(res.grounding.insufficient_reason).toMatch(/zero citations/)
    // the atom STILL closed (metered) — INSUFFICIENT is not un-metered
    const { atoms } = await readResearchAtoms(l.atomPath)
    expect(atoms.find((a) => a.kind === "actual_cost")).toBeDefined()
  })

  it("linkrot (non-2xx) fails the gate ⇒ INSUFFICIENT", async () => {
    const l = ledgers()
    const res = await probe("dead-link question", {
      sensorImpl: mockSensor({ citations: [citation({ http_status: 404 })] }),
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    expect(res.finding_class).toBe("insufficient")
    expect(res.grounding.gates[0].linkrot_ok).toBe(false)
    expect(res.grounding.insufficient_reason).toMatch(/linkrot/)
  })

  it("circular (citation domain == question-source domain) fails the gate ⇒ INSUFFICIENT", async () => {
    const l = ledgers()
    const res = await probe("self-citing question", {
      sensorImpl: mockSensor({ citations: [citation({ url: "https://dune.com/queries/999" })] }),
      question_source_url: "https://dune.com/the-question",
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    expect(res.finding_class).toBe("insufficient")
    expect(res.grounding.gates[0].circular_ok).toBe(false)
  })

  it("only-low-confidence ⇒ INSUFFICIENT for high-stakes; the same citation is sufficient when not high-stakes", async () => {
    const lowConf = [citation({ confidence: "low" })]
    const high = await probe("high-stakes belief", {
      sensorImpl: mockSensor({ citations: lowConf }),
      high_stakes: true,
      ...ledgers(),
      now: () => NOW,
    })
    expect(high.finding_class).toBe("insufficient")
    expect(high.grounding.gates[0].confidence_ok).toBe(false)
    expect(high.grounding.insufficient_reason).toMatch(/low-confidence/)

    const low = await probe("low-stakes belief", {
      sensorImpl: mockSensor({ citations: lowConf }),
      high_stakes: false,
      ...ledgers(),
      now: () => NOW,
    })
    expect(low.finding_class).toBe("claimed")
    expect(low.finding).not.toBeNull()
  })

  it("freshness: a stale citation fails the gate ⇒ INSUFFICIENT (Contract G: enforced, not ignored)", async () => {
    const l = ledgers()
    const res = await probe("freshness-sensitive question", {
      sensorImpl: mockSensor({ citations: [citation({ retrieved_ts: NOW - 10_000 })] }),
      freshness_max_age: 1_000, // citation is 10s old, max is 1s
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    expect(res.finding_class).toBe("insufficient")
    expect(res.grounding.gates[0].fresh_ok).toBe(false)
  })

  it("a mix where ≥1 citation passes every gate ⇒ claimed", async () => {
    const l = ledgers()
    const res = await probe("mixed-quality question", {
      sensorImpl: mockSensor({
        citations: [
          citation({ http_status: 404 }), // linkrot — dropped
          citation({ url: "https://dune.com/q/2", http_status: 200, confidence: "high" }), // valid
        ],
      }),
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    expect(res.finding_class).toBe("claimed")
    expect(res.valid_citations).toHaveLength(1)
    expect(res.citations).toHaveLength(2) // all surfaced for transparency
  })
})

// ---------------------------------------------------------------------------
// Pure helpers — the gate primitives in isolation.
// ---------------------------------------------------------------------------

describe("grounding-gate primitives", () => {
  it("domainOf strips www. and tolerates junk", () => {
    expect(domainOf("https://www.dune.com/x")).toBe("dune.com")
    expect(domainOf("https://etherscan.io/tx/0xabc")).toBe("etherscan.io")
    expect(domainOf("not a url")).toBeNull()
  })

  it("validateCitations is pure and reports per-gate reasons", () => {
    const v = validateCitations(
      [citation({ http_status: 500 }), citation({ url: "https://x.io/a", confidence: "low" })],
      { high_stakes: true, now: () => NOW },
    )
    expect(v.sufficient).toBe(false)
    expect(v.gates).toHaveLength(2)
    expect(v.gates[0].reasons).toContain("linkrot")
    expect(v.gates[1].reasons).toContain("low-confidence")
  })
})
