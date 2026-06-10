// src/cost/score-verdict.test.ts — gate + estimators + spend counter + route
// (sprint-169 T5.3/T5.4)
//
// Lives under src/cost/ so the vitest grep root collects it alongside the
// atom tests (the route file sits in src/gateway/routes/, which is not a
// test root). The gate is the experiment's one-bug surface: every predicate
// row is pinned here, fail-closed paths first.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  InfraEstimator,
  SpendCounter,
  createScoreVerdictRoutes,
  decideGate,
  estimateInferenceMicro,
  gateDecisionString,
  loadGateConfig,
  parseX402QuoteMicro,
  type GateInput,
} from "../gateway/routes/score-verdict.js"
import { readAtoms } from "./cost-atom.js"
import { buildFactSheet } from "../../deploy/score-stub/fixtures.js"

const VALID_INPUT: GateInput = {
  enrich: true,
  band: "HIGH",
  claim_verdict: "CLAIM",
  spend_today_micro: 0n,
  est_inference_micro: 10_000n,
  est_infra_micro: 100n,
  x402_price_micro: 100_000n,
  ceiling_micro: 10_000_000n,
}

describe("decideGate — ratified predicate order", () => {
  it("row 1: enrichment not requested → NO_INFERENCE:not_requested", () => {
    expect(decideGate({ ...VALID_INPUT, enrich: false })).toEqual({
      decision: "NO_INFERENCE",
      reason: "not_requested",
    })
  })

  it("row 2: INSUFFICIENT_EVIDENCE band → abstain rule", () => {
    expect(decideGate({ ...VALID_INPUT, band: "INSUFFICIENT_EVIDENCE" })).toEqual({
      decision: "NO_INFERENCE",
      reason: "abstain_rule",
    })
  })

  it("row 2: ABSTAIN verdict → abstain rule (abstains NEVER earn inference)", () => {
    expect(decideGate({ ...VALID_INPUT, claim_verdict: "ABSTAIN" })).toEqual({
      decision: "NO_INFERENCE",
      reason: "abstain_rule",
    })
  })

  it("row 3: spend + estimate over ceiling → kill_switch", () => {
    expect(
      decideGate({ ...VALID_INPUT, spend_today_micro: 9_995_000n, est_inference_micro: 10_000n }),
    ).toEqual({ decision: "NO_INFERENCE", reason: "kill_switch" })
  })

  it("row 3 boundary: exactly at ceiling does NOT trip", () => {
    expect(
      decideGate({
        ...VALID_INPUT,
        spend_today_micro: 9_990_000n,
        est_inference_micro: 10_000n,
      }).reason,
    ).not.toBe("kill_switch")
  })

  it("row 4: est×3 over margin → REFUSE_ENRICH", () => {
    expect(
      decideGate({ ...VALID_INPUT, est_inference_micro: 40_000n }), // 120k > 100k - 100
    ).toEqual({ decision: "REFUSE_ENRICH", reason: "roi_refuse" })
  })

  it("row 6: all clear → ROUTE_CHEVAL", () => {
    expect(decideGate(VALID_INPUT)).toEqual({ decision: "ROUTE_CHEVAL", reason: "routed" })
  })

  describe("row 5: fail-closed paths", () => {
    it("null / undefined input", () => {
      expect(decideGate(null).reason).toBe("fail_closed")
      expect(decideGate(undefined).reason).toBe("fail_closed")
    })

    it("missing band or claim_verdict", () => {
      expect(decideGate({ ...VALID_INPUT, band: undefined }).reason).toBe("fail_closed")
      expect(decideGate({ ...VALID_INPUT, claim_verdict: undefined }).reason).toBe("fail_closed")
    })

    it("non-bigint economic inputs", () => {
      expect(
        decideGate({ ...VALID_INPUT, spend_today_micro: 5 as unknown as bigint }).reason,
      ).toBe("fail_closed")
      expect(
        decideGate({ ...VALID_INPUT, est_inference_micro: "10" as unknown as bigint }).reason,
      ).toBe("fail_closed")
    })

    it("negative bigints", () => {
      expect(decideGate({ ...VALID_INPUT, ceiling_micro: -1n }).reason).toBe("fail_closed")
      expect(decideGate({ ...VALID_INPUT, est_infra_micro: -1n }).reason).toBe("fail_closed")
    })

    it("enrich not boolean", () => {
      expect(decideGate({ ...VALID_INPUT, enrich: "true" as unknown as boolean }).reason).toBe(
        "fail_closed",
      )
    })
  })

  it("is pure: frozen input, repeated calls, identical results", () => {
    const frozen = Object.freeze({ ...VALID_INPUT })
    const a = decideGate(frozen)
    const b = decideGate(frozen)
    expect(a).toEqual(b)
    expect(gateDecisionString(a)).toBe("ROUTE_CHEVAL:routed")
  })
})

describe("estimation (HC1) — deterministic", () => {
  it("fixed config ⇒ fixed estimate", () => {
    const pricing = {
      provider: "openai",
      model: "gpt-4o",
      input_micro_per_million: 2_500_000,
      output_micro_per_million: 10_000_000,
    }
    // 2000 in → 5000 micro; 500 out → 5000 micro
    expect(estimateInferenceMicro(2000, 500, pricing)).toBe(10_000n)
    expect(estimateInferenceMicro(2000, 500, pricing)).toBe(10_000n)
  })

  it("InfraEstimator returns the seed until 5 samples, then the integer mean", () => {
    const est = new InfraEstimator(1000n)
    expect(est.estimate()).toBe(1000n)
    for (const v of [10n, 20n, 30n, 40n]) est.push(v)
    expect(est.estimate()).toBe(1000n) // still seeded at 4 samples
    est.push(50n)
    expect(est.estimate()).toBe(30n)
  })

  it("InfraEstimator keeps only the last 20 samples", () => {
    const est = new InfraEstimator(0n)
    for (let i = 0; i < 25; i++) est.push(BigInt(i < 5 ? 1_000_000 : 100))
    expect(est.estimate()).toBe(100n)
  })
})

describe("config parsing (B10) — startup fail-closed", () => {
  it("parses defaults from an empty env (no cheval → enrichment disabled)", () => {
    const cfg = loadGateConfig({})
    expect(cfg).not.toBeNull()
    expect(cfg!.ceiling_micro).toBe(10_000_000n)
    expect(cfg!.x402_price_micro).toBe(100_000n)
    expect(cfg!.cheval).toBeNull()
  })

  it("garbage ceiling ⇒ null (enrichment disabled entirely)", () => {
    expect(loadGateConfig({ COP_SPEND_CEILING_MICRO: "ten dollars" })).toBeNull()
    expect(loadGateConfig({ COP_SPEND_CEILING_MICRO: "-5" })).toBeNull()
  })

  it("garbage x402 price ⇒ null", () => {
    expect(loadGateConfig({ X402_REQUEST_COST_MICRO: "0.10" })).toBeNull()
    expect(loadGateConfig({ X402_REQUEST_COST_MICRO: "0" })).toBeNull()
  })

  it("ONE quote source (HC7): gate config and quote parser agree", () => {
    const env = { X402_REQUEST_COST_MICRO: "250000" }
    expect(loadGateConfig(env)!.x402_price_micro).toBe(parseX402QuoteMicro(env))
  })

  it("cheval section requires key + hmac + known pricing", () => {
    const base = { CHEVAL_HMAC_SECRET: "s", COP_CHEVAL_API_KEY: "k" }
    expect(loadGateConfig(base)!.cheval).not.toBeNull()
    expect(loadGateConfig({ ...base, COP_CHEVAL_MODEL: "unknown-model" })!.cheval).toBeNull()
    expect(loadGateConfig({ COP_CHEVAL_API_KEY: "k" })!.cheval).toBeNull() // no hmac
  })
})

describe("SpendCounter (B12/B15)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cop-spend-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("persists and survives a restart (cold start does NOT reset the kill-switch)", async () => {
    const t = 1_750_000_000_000
    const c1 = new SpendCounter(dir, () => t)
    await c1.load()
    await c1.add(123_456n)
    // simulated restart: brand-new instance, same data dir
    const c2 = new SpendCounter(dir, () => t + 60_000)
    await c2.load()
    expect(c2.today()).toBe(123_456n)
  })

  it("rolls to zero on UTC day change", async () => {
    let t = Date.UTC(2026, 5, 9, 23, 59, 0)
    const counter = new SpendCounter(dir, () => t)
    await counter.load()
    await counter.add(500n)
    expect(counter.today()).toBe(500n)
    t = Date.UTC(2026, 5, 10, 0, 1, 0)
    expect(counter.today()).toBe(0n)
  })

  it("ignores non-positive and non-bigint adds", async () => {
    const counter = new SpendCounter(dir, () => 1_750_000_000_000)
    await counter.load()
    await counter.add(0n)
    await counter.add(-5n)
    expect(counter.today()).toBe(0n)
  })
})

describe("route integration (atoms + gate echo + spend)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cop-route-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Find stub agent ids by claim shape (deterministic fixtures). */
  function findIds(): { claimId: string; abstainId: string } {
    let claimId = ""
    let abstainId = ""
    for (let i = 0; i < 500 && (!claimId || !abstainId); i++) {
      const id = `0xroute${i}`
      const sheet = buildFactSheet(id)
      if (sheet.layers.claim.verdict === "ABSTAIN") {
        if (!abstainId) abstainId = id
      } else if (!claimId) claimId = id
    }
    return { claimId, abstainId }
  }

  function makeApp(opts: {
    env?: Record<string, string | undefined>
    cheval?: (prompt: string) => Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number }; provider_latency_ms: number }>
    rpc?: (address: string) => Promise<string | undefined>
  }) {
    const stubFetch: typeof fetch = async (input) => {
      const url = String(input)
      const agentId = decodeURIComponent(url.split("/verdict/")[1] ?? "")
      return new Response(JSON.stringify(buildFactSheet(agentId)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return createScoreVerdictRoutes({
      env: {
        SCORE_API_URL: "http://stub.local",
        CHEVAL_HMAC_SECRET: "test-secret",
        COP_CHEVAL_API_KEY: "test-key",
        ...opts.env,
      },
      fetchImpl: stubFetch,
      rpcExecute: opts.rpc ?? (async () => "0x6080"),
      chevalInvoke: opts.cheval
        ? async (prompt) => opts.cheval!(prompt)
        : async () => ({
            content: "enriched analysis",
            usage: { prompt_tokens: 1800, completion_tokens: 400 },
            provider_latency_ms: 50,
          }),
      dataDir: dir,
    })
  }

  it("Class A: relays the verdict, echoes the gate decision, persists one atom", async () => {
    const { claimId } = findIds()
    const app = makeApp({})
    const res = await app.request(`/verdict/${claimId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.gate_decision).toBe("NO_INFERENCE:not_requested")
    expect(body.x402_quote_micro).toBe("100000")
    const { atoms } = await readAtoms(join(dir, "cost-atoms.jsonl"))
    expect(atoms).toHaveLength(1)
    const atom = atoms[0] as any
    expect(atom.call_class).toBe("A_relay")
    expect(atom.infra.rpc_calls).toBe(1)
    expect(atom.inference.cost_micro).toBe("0")
    expect(BigInt(atom.total_micro)).toBe(
      BigInt(atom.inference.cost_micro) + BigInt(atom.infra.cost_micro) + BigInt(atom.orchestration.cost_micro),
    )
  })

  it("Class B routed: enrichment present, inference metered, spend persisted", async () => {
    const { claimId } = findIds()
    const app = makeApp({})
    const res = await app.request(`/verdict/${claimId}?enrich=true`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.gate_decision).toBe("ROUTE_CHEVAL:routed")
    expect((body.enrichment as any).content).toBe("enriched analysis")
    const { atoms } = await readAtoms(join(dir, "cost-atoms.jsonl"))
    const atom = atoms[0] as any
    expect(atom.call_class).toBe("B_enrich")
    // 1800 in @ $2.50/M = 4500 micro; 400 out @ $10/M = 4000 micro
    expect(atom.inference.cost_micro).toBe("8500")
    expect(atom.orchestration.cheval_spawn_ms).not.toBeNull()
    // spend persisted for the kill-switch
    const counter = new SpendCounter(dir)
    await counter.load()
    expect(counter.today()).toBe(8_500n)
  })

  it("abstain fixture: enrich=true is refused by the abstain rule — no cheval call", async () => {
    const { abstainId } = findIds()
    let chevalCalled = false
    const app = makeApp({
      cheval: async () => {
        chevalCalled = true
        return { content: "x", usage: { prompt_tokens: 1, completion_tokens: 1 }, provider_latency_ms: 1 }
      },
    })
    const res = await app.request(`/verdict/${abstainId}?enrich=true`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.gate_decision).toBe("NO_INFERENCE:abstain_rule")
    expect(body.enrichment).toBeUndefined()
    expect(chevalCalled).toBe(false)
  })

  it("ceiling breach: gate reports kill_switch, no enrichment", async () => {
    const { claimId } = findIds()
    const app = makeApp({ env: { COP_SPEND_CEILING_MICRO: "1" } })
    const res = await app.request(`/verdict/${claimId}?enrich=true`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.gate_decision).toBe("NO_INFERENCE:kill_switch")
    expect(body.enrichment).toBeUndefined()
  })

  it("cheval invoke failure: fail-closed response without enrichment, atom tagged", async () => {
    const { claimId } = findIds()
    const app = makeApp({
      cheval: async () => {
        throw new Error("subprocess exploded")
      },
    })
    const res = await app.request(`/verdict/${claimId}?enrich=true`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.enrichment).toBeUndefined()
    expect(body.gate_decision).toMatch(/invoke_failed/)
    const { atoms } = await readAtoms(join(dir, "cost-atoms.jsonl"))
    const atom = atoms[0] as any
    expect(atom.inference.cost_micro).toBe("0") // no partial billing
    expect(atom.orchestration.gate_inputs.invoke_error).toMatch(/subprocess exploded/)
  })

  it("startup parse failure: every enrich request fail-closes, Class A still serves", async () => {
    const { claimId } = findIds()
    const app = makeApp({ env: { COP_SPEND_CEILING_MICRO: "garbage" } })
    const resB = await app.request(`/verdict/${claimId}?enrich=true`)
    expect(((await resB.json()) as any).gate_decision).toBe("NO_INFERENCE:fail_closed")
    const resA = await app.request(`/verdict/${claimId}`)
    expect(resA.status).toBe(200)
  })

  it("bearer gate (B2): rejects without the token when FINN_AUTH_TOKEN is set", async () => {
    const { claimId } = findIds()
    const app = makeApp({ env: { FINN_AUTH_TOKEN: "sekrit" } })
    expect((await app.request(`/verdict/${claimId}`)).status).toBe(401)
    const ok = await app.request(`/verdict/${claimId}`, {
      headers: { Authorization: "Bearer sekrit" },
    })
    expect(ok.status).toBe(200)
    // unauthenticated probes are NOT measurement data
    const { atoms } = await readAtoms(join(dir, "cost-atoms.jsonl"))
    expect(atoms).toHaveLength(1)
  })

  it("score producer down: 502 and the atom records the failure", async () => {
    const app = createScoreVerdictRoutes({
      env: { SCORE_API_URL: "http://stub.local" },
      fetchImpl: async () => new Response("boom", { status: 500 }),
      rpcExecute: async () => "0x",
      chevalInvoke: async () => {
        throw new Error("unreachable")
      },
      dataDir: dir,
    })
    const res = await app.request("/verdict/0xanything")
    expect(res.status).toBe(502)
    const { atoms } = await readAtoms(join(dir, "cost-atoms.jsonl"))
    expect((atoms[0] as any).orchestration.gate_inputs.error).toMatch(/score fetch failed/)
  })
})
