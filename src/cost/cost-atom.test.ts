// src/cost/cost-atom.test.ts — CostAtom invariants (sprint-169 T5.1)
//
// The stakes are data-validity: an atom that closes after respond, a float in
// a stored field, or a silent write failure each invalidate the H1/H2/H3
// experiment — these tests are the contract, not a formality.

import { mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CostAtomHandle,
  CostAtomWriter,
  RollingBusyWindow,
  canonicalJson,
  closeAtom,
  costAtomMiddleware,
  envelopeLine,
  getCostAtom,
  infraCostMicro,
  loadInfraRates,
  orchestrationCostMicro,
  parseEnvelopeLine,
  readAtoms,
  type CostAtom,
  type InfraRates,
} from "./cost-atom.js"

const RATES: InfraRates = {
  container_micro_per_hour: 27_720,
  egress_micro_per_gb: 50_000,
  rpc_micro_per_call: 0,
}

function makeHandle(): CostAtomHandle {
  return new CostAtomHandle("01TESTATOM0000000000000000", "corr-test", 1_750_000_000_000)
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cost-atom-test-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("canonical serialization (B9/B13)", () => {
  it("serializes bigints as decimal strings and sorts keys", () => {
    const json = canonicalJson({ b: 2n, a: { z: 1n, y: "x" } })
    expect(json).toBe('{"a":{"y":"x","z":"1"},"b":"2"}')
  })

  it("round-trips an atom through the envelope with checksum intact", () => {
    const handle = makeHandle()
    handle.recordInference({
      model: "gpt-4o",
      input_tokens: 2000,
      output_tokens: 500,
      cached_tokens: 0,
      cost_micro: 10_000n,
    })
    const atom = closeAtom(handle, 120, 500_000, 15_000, RATES)
    const parsed = parseEnvelopeLine(envelopeLine(atom).trim())
    expect(parsed.schema_version).toBe(1)
    const stored = parsed.atom as Record<string, any>
    // bigint fields are decimal strings in storage, and parse back exactly
    expect(typeof stored.total_micro).toBe("string")
    expect(BigInt(stored.total_micro)).toBe(atom.total_micro)
    expect(BigInt(stored.inference.cost_micro)).toBe(10_000n)
  })

  it("rejects a tampered line via checksum", () => {
    const atom = closeAtom(makeHandle(), 10, 0, 0, RATES)
    const line = envelopeLine(atom).trim()
    const tampered = line.replace('"total_micro":"', '"total_micro":"9')
    expect(() => parseEnvelopeLine(tampered)).toThrow(/checksum/)
  })

  it("stores no float fields — every cost is integer-string, ratios integer ppm", () => {
    const atom = closeAtom(makeHandle(), 333, 123_456, 7_777, RATES)
    const stored = JSON.parse(envelopeLine(atom)).atom
    expect(Number.isInteger(stored.infra.allocated_ppm)).toBe(true)
    expect(Number.isInteger(stored.infra.wall_ms)).toBe(true)
    expect(stored.infra.cost_micro).toMatch(/^\d+$/)
    expect(stored.orchestration.cost_micro).toMatch(/^\d+$/)
    expect(stored.inference.cost_micro).toMatch(/^\d+$/)
    expect(stored.total_micro).toMatch(/^\d+$/)
  })
})

describe("integer cost math (B3)", () => {
  it("computes infra cost with floor division", () => {
    // 1000ms of a 27_720 micro/hour container = floor(1000*27720/3600000) = 7
    expect(infraCostMicro(1000, 0, 0, RATES)).toBe(7n)
    // 60KB egress at 50_000 micro/GB = floor(61440*50000/1e9) = 3
    expect(infraCostMicro(0, 61_440, 0, RATES)).toBe(3n)
    // rpc calls priced at configured rate
    expect(infraCostMicro(0, 0, 3, { ...RATES, rpc_micro_per_call: 2 })).toBe(6n)
  })

  it("computes orchestration cost from cheval spawn wall-time only", () => {
    expect(orchestrationCostMicro(null, RATES)).toBe(0n)
    expect(orchestrationCostMicro(3_600_000, RATES)).toBe(27_720n)
  })

  it("loadInfraRates falls back to defaults on garbage env", () => {
    const rates = loadInfraRates({ COP_INFRA_CONTAINER_MICRO_PER_HOUR: "not-a-number" })
    expect(rates.container_micro_per_hour).toBe(27_720)
  })
})

describe("sum invariant (HC3)", () => {
  it("total_micro equals the sum of the three ledgers", () => {
    const handle = makeHandle()
    handle.recordInference({
      model: "gpt-4o",
      input_tokens: 1,
      output_tokens: 1,
      cached_tokens: 0,
      cost_micro: 1_234n,
    })
    handle.setChevalSpawnMs(3_600_000)
    handle.addRpcCall()
    const atom = closeAtom(handle, 1000, 0, 61_440, RATES)
    expect(atom.total_micro).toBe(
      atom.inference.cost_micro + atom.infra.cost_micro + atom.orchestration.cost_micro,
    )
  })

  it("throws when a ledger cost is not a non-negative bigint", () => {
    const handle = makeHandle()
    handle.recordInference({
      model: null,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      // deliberate float contamination
      cost_micro: 1.5 as unknown as bigint,
    })
    expect(() => closeAtom(handle, 10, 0, 0, RATES)).toThrow(/sum invariant/)
  })
})

describe("rolling busy window (B8/HC2)", () => {
  it("allocated_ppm is the integer share of the busy window", () => {
    const w = new RollingBusyWindow()
    expect(w.record(0, 100)).toBe(1_000_000) // only request: 100% of busy time
    expect(w.record(1_000, 100)).toBe(500_000) // half of 200ms busy
    expect(w.record(2_000, 200)).toBe(500_000) // 200 of 400
  })

  it("expires entries older than the window", () => {
    const w = new RollingBusyWindow(1_000)
    w.record(0, 100)
    expect(w.record(5_000, 100)).toBe(1_000_000) // first entry expired
  })

  it("returns 0 ppm for zero-wall requests in an empty window", () => {
    const w = new RollingBusyWindow()
    expect(w.record(0, 0)).toBe(0)
  })
})

describe("append-only writer (B1)", () => {
  it("appends monotonically — two atoms produce two intact lines", async () => {
    const writer = new CostAtomWriter(join(dir, "cost", "cost-atoms.jsonl"))
    const a1 = closeAtom(makeHandle(), 10, 0, 0, RATES)
    const a2 = closeAtom(makeHandle(), 20, 0, 0, RATES)
    await writer.append(a1)
    await writer.append(a2)
    const { atoms, malformed } = await readAtoms(writer.path)
    expect(atoms).toHaveLength(2)
    expect(malformed).toHaveLength(0)
  })

  it("exposes no update or rewrite path", () => {
    const writer = new CostAtomWriter(join(dir, "x.jsonl"))
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(writer))
    expect(surface.sort()).toEqual(["append", "constructor"])
  })

  it("serializes concurrent appends without interleaving", async () => {
    const writer = new CostAtomWriter(join(dir, "concurrent.jsonl"))
    await Promise.all(
      Array.from({ length: 25 }, () => writer.append(closeAtom(makeHandle(), 5, 0, 0, RATES))),
    )
    const { atoms, malformed } = await readAtoms(writer.path)
    expect(atoms).toHaveLength(25)
    expect(malformed).toHaveLength(0)
  })

  it("keeps accepting appends after one append fails", async () => {
    const writer = new CostAtomWriter(join(dir, "recover.jsonl"))
    const bad = makeHandle()
    bad.recordInference({
      model: null,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      cost_micro: 0n,
    })
    const badAtom = closeAtom(bad, 1, 0, 0, RATES)
    // sabotage serialization for this one atom: circular refs make JSON.stringify throw
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    ;(badAtom.orchestration.gate_inputs as Record<string, unknown>).cycle = cycle
    await expect(writer.append(badAtom)).rejects.toThrow()
    await writer.append(closeAtom(makeHandle(), 1, 0, 0, RATES))
    const { atoms } = await readAtoms(writer.path)
    expect(atoms).toHaveLength(1)
  })
})

describe("middleware (HC6, B4/B7) — close before respond, exactly once", () => {
  function makeApp(writer: CostAtomWriter) {
    const app = new Hono()
    app.use(
      "*",
      costAtomMiddleware({ writer, window: new RollingBusyWindow(), rates: RATES }),
    )
    app.get("/ok", (c) => {
      const handle = getCostAtom(c)!
      handle.setCallClass("A_relay")
      handle.setGate("NO_INFERENCE:not_requested", { enrich: false })
      handle.addStep()
      return c.json({ ok: true })
    })
    app.get("/boom", () => {
      throw new Error("handler exploded")
    })
    return app
  }

  it("persists the atom BEFORE the response returns", async () => {
    const writer = new CostAtomWriter(join(dir, "order.jsonl"))
    const app = makeApp(writer)
    const res = await app.request("/ok")
    expect(res.status).toBe(200)
    // the response promise has resolved — the atom MUST already be durable
    const { atoms } = await readAtoms(writer.path)
    expect(atoms).toHaveLength(1)
    expect((atoms[0] as any).orchestration.gate_decision).toBe("NO_INFERENCE:not_requested")
  })

  it("closes exactly once on the throw path and responds 500 with a persisted atom", async () => {
    const writer = new CostAtomWriter(join(dir, "throw.jsonl"))
    const app = makeApp(writer)
    const res = await app.request("/boom")
    expect(res.status).toBe(500)
    const { atoms } = await readAtoms(writer.path)
    expect(atoms).toHaveLength(1)
    expect((atoms[0] as any).orchestration.gate_inputs.error).toMatch(/handler exploded/)
  })

  it("responds 500 when the atom write fails (fail-closed, B4/B7)", async () => {
    const writer = new CostAtomWriter(join(dir, "wf.jsonl"))
    writer.append = () => Promise.reject(new Error("disk on fire"))
    const app = makeApp(writer)
    const res = await app.request("/ok")
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("COST_ATOM_WRITE_FAILED")
  })

  it("measures egress bytes from the response body", async () => {
    const writer = new CostAtomWriter(join(dir, "egress.jsonl"))
    const app = makeApp(writer)
    await app.request("/ok")
    const { atoms } = await readAtoms(writer.path)
    const expected = new TextEncoder().encode(JSON.stringify({ ok: true })).byteLength
    expect((atoms[0] as any).infra.egress_bytes).toBe(expected)
  })
})

describe("reader malformed-line policy (HC8)", () => {
  it("skips malformed lines with line numbers and keeps good ones", async () => {
    const writer = new CostAtomWriter(join(dir, "mixed.jsonl"))
    await writer.append(closeAtom(makeHandle(), 1, 0, 0, RATES))
    const { appendFile } = await import("node:fs/promises")
    await appendFile(writer.path, "{not json\n")
    await writer.append(closeAtom(makeHandle(), 2, 0, 0, RATES))
    const { atoms, malformed } = await readAtoms(writer.path)
    expect(atoms).toHaveLength(2)
    expect(malformed).toHaveLength(1)
    expect(malformed[0].line).toBe(2)
  })
})
