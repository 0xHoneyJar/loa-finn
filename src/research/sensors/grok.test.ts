// src/research/sensors/grok.test.ts — the Grok SIGINT shim (bd-8ywq.8 ·
// Acceptance Contract G). Everything is MOCKED: no XAI_API_KEY is read for a
// real call, no Cheval/x-dot-ai call ever runs, zero spend.

import { describe, expect, it } from "vitest"
import type { SensorInput } from "../probe.js"
import type { Citation, ModelinvRef } from "../schemas/index.js"
import {
  type ChevalXaiResult,
  type GrokSensorDeps,
  grokAvailability,
  makeGrokSensor,
} from "./grok.js"
import { SensorUnavailableError } from "./contract.js"

const NOW = 1_750_000_000_000

function input(over: Partial<SensorInput> = {}): SensorInput {
  return { question: "is X-firehose volume on x402 real right now?", now: () => NOW, ...over }
}

function citation(over: Partial<Citation> = {}): Citation {
  return {
    url: "https://x.com/some/post/1",
    retrieved_ts: NOW,
    http_status: 200,
    source_type: "sigint-x",
    claim_support: "supports",
    confidence: "high",
    ...over,
  }
}

const modelinvRef: ModelinvRef = {
  ledger_path: ".run/cost-ledger.jsonl",
  request_id: "req-abc123",
  trace_id: "trace-1",
  cost_micro: 4_200n,
}

describe("grok availability — the key gate (zero calls)", () => {
  it("absent XAI_API_KEY ⇒ typed-unavailable, V2-ready reason", () => {
    const a = grokAvailability({ getApiKey: () => undefined })
    expect(a.available).toBe(false)
    if (!a.available) expect(a.reason).toMatch(/XAI_API_KEY/)
  })

  it("key present but NO xai route wired ⇒ typed-unavailable (seam scaffolded)", () => {
    const a = grokAvailability({ getApiKey: () => "xai-key" })
    expect(a.available).toBe(false)
    if (!a.available) expect(a.reason).toMatch(/xai provider|scaffold/i)
  })

  it("key present AND a route wired ⇒ available", () => {
    const a = grokAvailability({ getApiKey: () => "xai-key", chevalRoute: async () => ({ content: "" }) })
    expect(a.available).toBe(true)
  })
})

describe("grok SensorFn — absent key makes ZERO calls and surfaces no finding", () => {
  it("throws SensorUnavailableError (cost 0) and never invokes the route", async () => {
    let routeCalls = 0
    const sensor = makeGrokSensor({
      getApiKey: () => undefined,
      chevalRoute: async () => {
        routeCalls++
        return { content: "should never run" }
      },
    })
    await expect(sensor(input())).rejects.toBeInstanceOf(SensorUnavailableError)
    expect(routeCalls).toBe(0) // zero calls, zero spend
    const err = await sensor(input()).catch((e) => e)
    expect(err).toBeInstanceOf(SensorUnavailableError)
    expect((err as SensorUnavailableError).partial_micro).toBe(0n)
  })

  it("key present but unwired route ⇒ SensorUnavailableError before any routing", async () => {
    const sensor = makeGrokSensor({ getApiKey: () => "xai-key" }) // no chevalRoute
    await expect(sensor(input())).rejects.toBeInstanceOf(SensorUnavailableError)
  })
})

describe("grok SensorFn — present (mocked Cheval) routes via the xai seam", () => {
  it("routes ONLY through the injected Cheval route with provider_intended='xai'", async () => {
    let seen: { question: string; freshness_max_age?: number } | null = null
    const deps: GrokSensorDeps = {
      getApiKey: () => "xai-key",
      chevalRoute: async (r) => {
        seen = { question: r.question, freshness_max_age: r.freshness_max_age }
        const res: ChevalXaiResult = {
          content: "x402 nowcast: settlement volume up intraday",
          citations: [citation()],
          modelinv_ref: modelinvRef,
        }
        return res
      },
    }
    const out = await makeGrokSensor(deps)(input({ freshness_max_age: 60_000 }))
    expect(seen).not.toBeNull()
    expect(seen!.question).toMatch(/x402/)
    expect(seen!.freshness_max_age).toBe(60_000) // the knob is threaded, not ignored
    expect(out.provider_intended).toBe("xai")
    expect(out.provider_resolved).toBe("xai")
    expect(out.finding).toMatch(/nowcast/)
    expect(out.citations).toHaveLength(1)
    // MODELINV dedup: inference is metered there, not double-charged here.
    expect(out.modelinv_ref).toEqual(modelinvRef)
    expect(out.cost_micro).toBe(0n)
    expect(out.inference_micro).toBe(0n)
  })

  it("a Cheval routing fallback is surfaced honestly (provider_resolved != intended)", async () => {
    const out = await makeGrokSensor({
      getApiKey: () => "xai-key",
      chevalRoute: async () => ({ content: "served elsewhere", provider_resolved: "anthropic" }),
    })(input())
    expect(out.provider_intended).toBe("xai")
    expect(out.provider_resolved).toBe("anthropic") // the probe will class this routing_fallback
  })

  it("a non-MODELINV route charges inference to the research ledger", async () => {
    const out = await makeGrokSensor({
      getApiKey: () => "xai-key",
      chevalRoute: async () => ({ content: "ok", citations: [citation()], inference_micro: 1_500n }),
    })(input())
    expect(out.modelinv_ref).toBeNull()
    expect(out.cost_micro).toBe(1_500n)
    expect(out.inference_micro).toBe(1_500n)
  })
})
