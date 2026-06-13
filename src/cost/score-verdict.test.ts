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
  SpendPersistError,
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

  it("Bedrock-shaped env: wire model split from pricing model (deploy fix)", () => {
    const cfg = loadGateConfig({
      CHEVAL_HMAC_SECRET: "s",
      COP_CHEVAL_API_KEY: "bedrock-api-key",
      COP_CHEVAL_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
      COP_CHEVAL_MODEL: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      COP_CHEVAL_PRICING_MODEL: "claude-sonnet-4-5-20250929",
      COP_CHEVAL_PROVIDER: "anthropic",
      COP_CHEVAL_PROVIDER_TYPE: "openai-compatible",
    })
    expect(cfg!.cheval).not.toBeNull()
    expect(cfg!.cheval!.model).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0") // wire id
    expect(cfg!.cheval!.pricing.model).toBe("claude-sonnet-4-5-20250929") // priced id
    expect(cfg!.cheval!.provider_type).toBe("openai-compatible")
  })

  it("explicit rate override builds pricing for table-less wire models (Bedrock)", () => {
    const cfg = loadGateConfig({
      CHEVAL_HMAC_SECRET: "s",
      COP_CHEVAL_API_KEY: "k",
      COP_CHEVAL_MODEL: "eu.anthropic.claude-opus-4-7",
      COP_CHEVAL_PROVIDER: "bedrock-anthropic",
      COP_CHEVAL_PROVIDER_TYPE: "openai-compatible",
      COP_CHEVAL_INPUT_MICRO_PER_MTOK: "5000000",
      COP_CHEVAL_OUTPUT_MICRO_PER_MTOK: "25000000",
    })
    expect(cfg!.cheval).not.toBeNull()
    expect(cfg!.cheval!.pricing.input_micro_per_million).toBe(5_000_000)
    expect(cfg!.cheval!.pricing.output_micro_per_million).toBe(25_000_000)
    // est at 2000-in/500-out: 10_000 + 12_500 = 22_500 micro — clears the
    // 3× ROI margin against the $0.10 quote (67_500 ≤ ~99_000)
  })

  it("partial or garbage rate override fails closed", () => {
    const base = {
      CHEVAL_HMAC_SECRET: "s",
      COP_CHEVAL_API_KEY: "k",
      COP_CHEVAL_MODEL: "eu.anthropic.claude-opus-4-7",
      COP_CHEVAL_PROVIDER: "bedrock-anthropic",
      COP_CHEVAL_PROVIDER_TYPE: "openai-compatible" as const,
    }
    expect(loadGateConfig({ ...base, COP_CHEVAL_INPUT_MICRO_PER_MTOK: "5000000" })!.cheval).toBeNull() // missing output rate
    expect(
      loadGateConfig({
        ...base,
        COP_CHEVAL_INPUT_MICRO_PER_MTOK: "five dollars",
        COP_CHEVAL_OUTPUT_MICRO_PER_MTOK: "25000000",
      })!.cheval,
    ).toBeNull()
    expect(
      loadGateConfig({
        ...base,
        COP_CHEVAL_INPUT_MICRO_PER_MTOK: "-5",
        COP_CHEVAL_OUTPUT_MICRO_PER_MTOK: "25000000",
      })!.cheval,
    ).toBeNull()
  })

  it("invalid provider type disables cheval (fail-closed)", () => {
    const cfg = loadGateConfig({
      CHEVAL_HMAC_SECRET: "s",
      COP_CHEVAL_API_KEY: "k",
      COP_CHEVAL_PROVIDER_TYPE: "bedrock-native", // not a cheval.py transport
    })
    expect(cfg!.cheval).toBeNull()
  })
})

describe("SpendCounter (B12/B15 + review F2-F5)", () => {
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
    await c1.settle(null, 123_456n)
    // simulated restart: brand-new instance, same data dir
    const c2 = new SpendCounter(dir, () => t + 60_000)
    await c2.load()
    expect(c2.outstanding()).toBe(123_456n)
    expect(c2.available()).toBe(true)
  })

  it("rolls to zero on UTC day change", async () => {
    let t = Date.UTC(2026, 5, 9, 23, 59, 0)
    const counter = new SpendCounter(dir, () => t)
    await counter.load()
    await counter.settle(null, 500n)
    expect(counter.outstanding()).toBe(500n)
    t = Date.UTC(2026, 5, 10, 0, 1, 0)
    expect(counter.outstanding()).toBe(0n)
  })

  it("reservations count toward outstanding and release on failure (F2)", async () => {
    const counter = new SpendCounter(dir, () => 1_750_000_000_000)
    await counter.load()
    const token = counter.reserve(10_000n)
    expect(counter.outstanding()).toBe(10_000n)
    counter.release(token)
    expect(counter.outstanding()).toBe(0n)
    counter.release(token) // idempotent — double release is a no-op
    expect(counter.outstanding()).toBe(0n)
  })

  it("settle converts a reservation into settled spend (F2)", async () => {
    const counter = new SpendCounter(dir, () => 1_750_000_000_000)
    await counter.load()
    const token = counter.reserve(10_000n)
    await counter.settle(token, 8_500n)
    expect(counter.outstanding()).toBe(8_500n)
  })

  it("a cross-midnight settle cannot steal the new day's reservations (codex cycle-2)", async () => {
    let t = Date.UTC(2026, 5, 9, 23, 59, 58)
    const counter = new SpendCounter(dir, () => t)
    await counter.load()
    const oldToken = counter.reserve(10_000n) // reserved on day D
    t = Date.UTC(2026, 5, 10, 0, 0, 5) // UTC midnight rolls; aggregate reset
    const newToken = counter.reserve(10_000n) // day D+1 in-flight reservation
    expect(counter.outstanding()).toBe(10_000n)
    await counter.settle(oldToken, 8_500n) // old-day token: release is a no-op on D+1
    // the new day's reservation is INTACT and the settle still counts as spend
    expect(counter.outstanding()).toBe(18_500n)
    counter.release(newToken)
    expect(counter.outstanding()).toBe(8_500n)
  })

  it("serializes concurrent settles without losing spend (F4)", async () => {
    const counter = new SpendCounter(dir, () => 1_750_000_000_000)
    await counter.load()
    await Promise.all(Array.from({ length: 10 }, () => counter.settle(null, 100n)))
    expect(counter.outstanding()).toBe(1_000n)
    const reloaded = new SpendCounter(dir, () => 1_750_000_000_000)
    await reloaded.load()
    expect(reloaded.outstanding()).toBe(1_000n)
  })

  it("persist failure rejects with SpendPersistError, memory stays conservative (F3)", async () => {
    const counter = new SpendCounter("/dev/null/not-a-dir", () => 1_750_000_000_000)
    await counter.load() // ENOENT-class on a bogus path → fresh zero is fine
    await expect(counter.settle(null, 100n)).rejects.toThrow(SpendPersistError)
    expect(counter.outstanding()).toBe(100n) // memory committed — runtime stays conservative
  })

  it("corrupt current-day file marks the counter unavailable, NOT zero (F5)", async () => {
    const t = 1_750_000_000_000
    const day = new Date(t).toISOString().slice(0, 10)
    const { writeFile, mkdir } = await import("node:fs/promises")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `spend-${day}.json`), "{corrupt", "utf-8")
    const counter = new SpendCounter(dir, () => t)
    await counter.load()
    expect(counter.available()).toBe(false)
  })

  it("a fresh UTC day clears the unavailable state", async () => {
    let t = Date.UTC(2026, 5, 9, 12, 0, 0)
    const day = new Date(t).toISOString().slice(0, 10)
    const { writeFile, mkdir } = await import("node:fs/promises")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `spend-${day}.json`), "{corrupt", "utf-8")
    const counter = new SpendCounter(dir, () => t)
    await counter.load()
    expect(counter.available()).toBe(false)
    t = Date.UTC(2026, 5, 10, 0, 1, 0)
    expect(counter.available()).toBe(true)
    expect(counter.outstanding()).toBe(0n)
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
    expect(counter.outstanding()).toBe(8_500n)
  })

  it("feeds the infra estimator from closed Class A atoms (F1)", async () => {
    const { claimId } = findIds()
    const app = makeApp({})
    // Before 5 Class A samples: est_infra is the seed (1000)
    const first = await app.request(`/verdict/${claimId}?enrich=true`)
    const firstAtoms = await readAtoms(join(dir, "cost-atoms.jsonl"))
    const firstGate = (firstAtoms.atoms.at(-1) as any).orchestration.gate_inputs
    expect(firstGate.est_infra_micro).toBe("1000")
    expect(first.status).toBe(200)
    // 5 Class A calls feed the estimator with real (tiny) infra costs
    for (let i = 0; i < 5; i++) await app.request(`/verdict/${claimId}`)
    const after = await app.request(`/verdict/${claimId}?enrich=true`)
    expect(after.status).toBe(200)
    const { atoms } = await readAtoms(join(dir, "cost-atoms.jsonl"))
    const gateInputs = (atoms.at(-1) as any).orchestration.gate_inputs
    // estimate is now the rolling mean of measured Class A infra costs —
    // sub-micro wall/egress in tests → 0, definitively NOT the 1000 seed
    expect(gateInputs.est_infra_micro).not.toBe("1000")
  })

  it("concurrent enrich requests cannot all pass the kill-switch (F2)", async () => {
    const { claimId } = findIds()
    // est_inference = 2000@$2.50/M + 500@$10/M = 5000 + 5000 = 10000 micro.
    // Ceiling 15000 admits exactly ONE reservation.
    const app = makeApp({
      env: { COP_SPEND_CEILING_MICRO: "15000" },
      cheval: async () => {
        await new Promise((r) => setTimeout(r, 50)) // hold the reservation window open
        return { content: "x", usage: { prompt_tokens: 100, completion_tokens: 10 }, provider_latency_ms: 1 }
      },
    })
    const [r1, r2] = await Promise.all([
      app.request(`/verdict/${claimId}?enrich=true`),
      app.request(`/verdict/${claimId}?enrich=true`),
    ])
    const decisions = [
      ((await r1.json()) as any).gate_decision,
      ((await r2.json()) as any).gate_decision,
    ].sort()
    expect(decisions.filter((d) => d.startsWith("ROUTE_CHEVAL"))).toHaveLength(1)
    expect(decisions.filter((d) => d === "NO_INFERENCE:kill_switch")).toHaveLength(1)
  })

  it("fractional provider latency is floored, not rejected (live-observed cheval behavior)", async () => {
    const { claimId } = findIds()
    const app = makeApp({
      cheval: async () => ({
        content: "enriched",
        usage: { prompt_tokens: 100, completion_tokens: 20 },
        provider_latency_ms: 4541.6995419654995, // exactly what cheval.py reported live
      }),
    })
    const res = await app.request(`/verdict/${claimId}?enrich=true`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.gate_decision).toBe("ROUTE_CHEVAL:routed")
    expect((body.enrichment as any).content).toBe("enriched")
    const { atoms } = await readAtoms(join(dir, "cost-atoms.jsonl"))
    const spawn = (atoms[0] as any).orchestration.cheval_spawn_ms
    expect(Number.isInteger(spawn)).toBe(true)
  })

  it("invalid cheval telemetry is rejected fail-closed — no floats stored (F6)", async () => {
    const { claimId } = findIds()
    const app = makeApp({
      cheval: async () => ({
        content: "x",
        usage: { prompt_tokens: 1.5, completion_tokens: 10 }, // fractional!
        provider_latency_ms: 5,
      }),
    })
    const res = await app.request(`/verdict/${claimId}?enrich=true`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.enrichment).toBeUndefined()
    expect(body.gate_decision).toMatch(/invoke_failed/)
    const { atoms } = await readAtoms(join(dir, "cost-atoms.jsonl"))
    const atom = atoms[0] as any
    expect(atom.inference.cost_micro).toBe("0")
    expect(atom.orchestration.gate_inputs.invoke_error).toMatch(/invalid telemetry/)
  })

  it("corrupt spend file fail-closes enrichment at the route level (F5)", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const { writeFile, mkdir } = await import("node:fs/promises")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `spend-${day}.json`), "not json at all", "utf-8")
    const { claimId } = findIds()
    const app = makeApp({})
    const res = await app.request(`/verdict/${claimId}?enrich=true`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.gate_decision).toBe("NO_INFERENCE:fail_closed")
    expect(body.enrichment).toBeUndefined()
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
