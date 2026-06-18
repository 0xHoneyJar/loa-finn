// src/research/sensors/boundary.test.ts — Contract G, end to end (bd-8ywq.8).
//
//   1. the STATIC adapter-boundary check (no shim makes a direct provider call),
//      proven non-vacuous by a negative case;
//   2. the registry dispatch (grok/dune → shims; gemini/unknown → typed refusal);
//   3. the probe wiring — an absent-infra sensor meters a TYPED failure atom and
//      surfaces no finding (typed-unavailable, never silent), through the real
//      probe dispatch edit;
//   4. the freshness gate rejecting a stale sensor result (no false affordance).
//
// No real Cheval / dune-meter / Dune / Gemini call runs anywhere here. Zero spend.

import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ResearchAtomWriter, readResearchAtoms, verifyChain } from "../cost-atom-research.js"
import { SpineEventWriter, readSpineEvents } from "../spine-ledger.js"
import { probe } from "../probe.js"
import type { Citation } from "../schemas/index.js"
import {
  assertNoDirectProviderCalls,
  makeRegisteredSensor,
  scanForDirectProviderCalls,
} from "./index.js"
import { SensorUnavailableError } from "./contract.js"
import { makeGrokSensor } from "./grok.js"

const NOW = 1_750_000_000_000
const HERE = dirname(fileURLToPath(import.meta.url))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sensor-boundary-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ledgers() {
  return {
    atom_writer: new ResearchAtomWriter(join(dir, "atoms.jsonl")),
    spine_writer: new SpineEventWriter(join(dir, "spine.jsonl")),
    atomPath: join(dir, "atoms.jsonl"),
    spinePath: join(dir, "spine.jsonl"),
  }
}

// ---------------------------------------------------------------------------
// 1. The static adapter-boundary check.
// ---------------------------------------------------------------------------

describe("Contract G — adapter boundary (static)", () => {
  it("no sensor shim makes a direct provider API call", () => {
    const shims = ["grok.ts", "dune.ts", "contract.ts"]
    const sources = Object.fromEntries(shims.map((f) => [f, readFileSync(join(HERE, f), "utf-8")]))
    expect(scanForDirectProviderCalls(sources)).toHaveLength(0)
    expect(() => assertNoDirectProviderCalls(sources)).not.toThrow()
  })

  it("the scanner is non-vacuous: it catches a direct call", () => {
    const bad = { "evil.ts": 'const r = await fetch("https://api.x.ai/v1/chat/completions")' }
    expect(scanForDirectProviderCalls(bad).length).toBeGreaterThan(0)
    expect(() => assertNoDirectProviderCalls(bad)).toThrow(/Contract G/)
  })
})

// ---------------------------------------------------------------------------
// 2. The registry dispatch.
// ---------------------------------------------------------------------------

describe("Contract G — sensor registry dispatch", () => {
  it("routes grok + dune to their shims, refuses gemini + unknown", async () => {
    const grokFn = makeRegisteredSensor("grok", { grok: { getApiKey: () => undefined } })
    await expect(grokFn({ question: "q", now: () => NOW })).rejects.toBeInstanceOf(SensorUnavailableError)

    const duneFn = makeRegisteredSensor("dune", { dune: { resolveBinary: () => null } })
    await expect(duneFn({ question: "q", now: () => NOW })).rejects.toBeInstanceOf(SensorUnavailableError)

    expect(() => makeRegisteredSensor("gemini")).toThrow(/probe\.ts/)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => makeRegisteredSensor("madeup" as any)).toThrow(/unknown sensor/)
  })
})

// ---------------------------------------------------------------------------
// 3. Probe wiring — absent infra is a TYPED, metered failure (never silent).
// ---------------------------------------------------------------------------

describe("probe dispatch — absent-key grok meters a typed failure (no silent fail)", () => {
  it("routes sensor:'grok' through the registry → SensorUnavailableError + typed failure atom", async () => {
    const saved = process.env.XAI_API_KEY
    delete process.env.XAI_API_KEY // deterministically unavailable
    try {
      const l = ledgers()
      await expect(
        probe("is grok wired in finn?", {
          sensor: "grok",
          atom_writer: l.atom_writer,
          spine_writer: l.spine_writer,
          now: () => NOW,
        }),
      ).rejects.toBeInstanceOf(SensorUnavailableError)

      const { envelopes, atoms } = await readResearchAtoms(l.atomPath)
      // reservation + typed failure — no gap, no silent finding
      expect(atoms.map((a) => a.kind)).toEqual(["budget_reservation", "failure"])
      expect(atoms[1].error_class).toBe("SensorUnavailableError")
      expect(atoms[1].cost_micro).toBe(0n) // zero spend
      expect(atoms[1].reservation_ref).toBe(atoms[0].atom_id)
      expect(verifyChain(envelopes).valid).toBe(true)
      // nothing landed on the spine for an unavailable sensor
      const spine = await readSpineEvents(l.spinePath).catch(() => ({ events: [] }))
      expect(spine.events.length).toBe(0)
    } finally {
      if (saved === undefined) delete process.env.XAI_API_KEY
      else process.env.XAI_API_KEY = saved
    }
  })

  it("an absent-binary dune sensor also meters a typed failure (no finding)", async () => {
    const l = ledgers()
    await expect(
      probe("is on-chain settlement real?", {
        sensor: "dune",
        // inject the absent-binary shim so the test is deterministic regardless of PATH
        sensorImpl: makeRegisteredSensor("dune", { dune: { resolveBinary: () => null } }),
        atom_writer: l.atom_writer,
        spine_writer: l.spine_writer,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(SensorUnavailableError)
    const { atoms } = await readResearchAtoms(l.atomPath)
    expect(atoms.map((a) => a.kind)).toEqual(["budget_reservation", "failure"])
    expect(atoms[1].error_class).toBe("SensorUnavailableError")
  })
})

// ---------------------------------------------------------------------------
// 4. Freshness gate — a stale sensor result fails (no false affordance).
// ---------------------------------------------------------------------------

describe("freshness_max_age — enforced through the new sensor path", () => {
  it("a stale grok result fails the freshness gate ⇒ INSUFFICIENT", async () => {
    const l = ledgers()
    const staleCitation: Citation = {
      url: "https://x.com/post/9",
      retrieved_ts: NOW - 10_000, // 10s old
      http_status: 200,
      source_type: "sigint-x",
      claim_support: null,
      confidence: "high",
    }
    const res = await probe("real-time nowcast", {
      sensor: "grok",
      sensorImpl: makeGrokSensor({
        getApiKey: () => "xai-key",
        chevalRoute: async () => ({ content: "stale nowcast", citations: [staleCitation] }),
      }),
      freshness_max_age: 1_000, // max 1s — the citation is 10s old
      atom_writer: l.atom_writer,
      spine_writer: l.spine_writer,
      now: () => NOW,
    })
    expect(res.finding_class).toBe("insufficient")
    expect(res.finding).toBeNull()
    expect(res.grounding.gates[0].fresh_ok).toBe(false)
    expect(res.spine_event).toBeNull()
  })
})
