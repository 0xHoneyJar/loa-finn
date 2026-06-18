// src/research/sensors/dune.test.ts — the Dune on-chain shim (bd-8ywq.8 ·
// Acceptance Contract G). Everything is MOCKED: the dune-meter binary is never
// resolved to a real path on the success paths, spawn is injected, no real
// dune-meter / Dune call ever runs, zero spend.

import { describe, expect, it } from "vitest"
import { ResearchSensorError } from "../cost-atom-research.js"
import type { SensorInput } from "../probe.js"
import { type DuneSpawn, type DuneSpawnResult, duneAvailability, makeDuneSensor } from "./dune.js"
import { SensorUnavailableError } from "./contract.js"

const NOW = 1_750_000_000_000

function input(over: Partial<SensorInput> = {}): SensorInput {
  return { question: "select count(*) from erc6551_tba_fees", now: () => NOW, ...over }
}

/** A mock spawn that records the invocation and returns a fixed result. */
function mockSpawn(result: DuneSpawnResult): { spawn: DuneSpawn; calls: { bin: string; args: string[] }[] } {
  const calls: { bin: string; args: string[] }[] = []
  const spawn: DuneSpawn = async (bin, args) => {
    calls.push({ bin, args })
    return result
  }
  return { spawn, calls }
}

const RUN_OK = JSON.stringify({
  executed: true,
  execution_id: "01EXEC",
  engine: "small",
  cap: 50,
  cap_exceeded: false,
  datapoints_scanned: 1234,
  credits_consumed: 2,
  atom_id: "01ATOM",
  atom_checksum: "sha256:deadbeef",
})

describe("dune availability — the binary gate (zero spawns)", () => {
  it("absent dune-meter binary ⇒ typed-unavailable (Asson-CLI scaffold)", () => {
    const a = duneAvailability({ resolveBinary: () => null })
    expect(a.available).toBe(false)
    if (!a.available) expect(a.reason).toMatch(/dune-meter|scaffold/i)
  })

  it("present binary ⇒ available", () => {
    const a = duneAvailability({ resolveBinary: () => "/usr/local/bin/dune-meter" })
    expect(a.available).toBe(true)
  })
})

describe("dune SensorFn — absent binary makes ZERO spawns and surfaces no finding", () => {
  it("throws SensorUnavailableError (cost 0) and never spawns", async () => {
    const { spawn, calls } = mockSpawn({ code: 0, stdout: RUN_OK, stderr: "" })
    const sensor = makeDuneSensor({ resolveBinary: () => null, spawn })
    const err = await sensor(input()).catch((e) => e)
    expect(err).toBeInstanceOf(SensorUnavailableError)
    expect((err as SensorUnavailableError).partial_micro).toBe(0n)
    expect(calls).toHaveLength(0) // zero spawns, zero spend
  })
})

describe("dune SensorFn — present (mocked) routes via the CLI shim, never raw", () => {
  it("shells the COST-CAPPED `dune-meter run` and maps the result", async () => {
    const { spawn, calls } = mockSpawn({ code: 0, stdout: RUN_OK, stderr: "" })
    const sensor = makeDuneSensor({
      resolveBinary: () => "/usr/local/bin/dune-meter",
      spawn,
      cap_credits: 50,
    })
    const out = await sensor(input())

    // routed via the CLI shim — exactly one spawn, the binary, the capped `run`.
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe("/usr/local/bin/dune-meter")
    expect(calls[0].args[0]).toBe("run") // never `estimate`-only, never bypass
    expect(calls[0].args).toContain("--cap") // the cost cap is mandatory
    expect(calls[0].args[calls[0].args.indexOf("--cap") + 1]).toBe("50")

    expect(out.provider_intended).toBe("dune")
    expect(out.provider_resolved).toBe("dune")
    expect(out.modelinv_ref).toBeNull() // dune cost is Dune credits, not MODELINV
    expect(out.inference_micro).toBe(0n) // data, not inference
    expect(out.cost_micro).toBe(2n) // 2 credits → placeholder micro-USD
    expect(out.citations).toHaveLength(1)
    expect(out.citations[0].source_type).toBe("on-chain-dune")
    expect(out.citations[0].url).toContain("dune-meter://run/")
    expect(out.finding).toMatch(/2 credits/)
  })

  it("a budget refuse / cap abort is a typed failure, not a fabricated finding", async () => {
    const refuse = JSON.stringify({ refused: true, reason: "estimate exceeds remaining budget" })
    const sensor = makeDuneSensor({
      resolveBinary: () => "/usr/local/bin/dune-meter",
      spawn: mockSpawn({ code: 3, stdout: refuse, stderr: "" }).spawn,
    })
    await expect(sensor(input())).rejects.toBeInstanceOf(ResearchSensorError)
  })

  it("a non-executing run (no `executed` flag) surfaces no finding", async () => {
    const aborted = JSON.stringify({ aborted: true, reason: "Dune aborted execution on cost cap" })
    const sensor = makeDuneSensor({
      resolveBinary: () => "/usr/local/bin/dune-meter",
      spawn: mockSpawn({ code: 0, stdout: aborted, stderr: "" }).spawn,
    })
    await expect(sensor(input())).rejects.toThrow(/did not execute/)
  })

  it("a custom credits→micro mapping is honoured (the placeholder is injectable)", async () => {
    const sensor = makeDuneSensor({
      resolveBinary: () => "/usr/local/bin/dune-meter",
      spawn: mockSpawn({ code: 0, stdout: RUN_OK, stderr: "" }).spawn,
      credits_to_micro: (c) => BigInt(c) * 1000n,
    })
    const out = await sensor(input())
    expect(out.cost_micro).toBe(2000n)
  })
})
