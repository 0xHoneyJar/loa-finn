// src/gateway/routes/score-verdict.ts — cost-of-play verdict route + cheval-ROI gate
// (cycle-041 S5 / sprint-169, T5.3+T5.4 — Finn cost-of-play V1)
//
// GET /api/v1/score/verdict/:agentId?enrich=true|false
//
// Class A (relay, zero inference): stub fetch → transform → 1× rpc-pool
// eth_call cross-check → respond. Class B (enrich=true): Class A + the
// mechanical cheval-ROI gate → if routed, cheval subprocess at the configured
// tier. "No LLM decides whether to call an LLM" (arch doc §2).
//
// The gate is PURE and FAIL-CLOSED (the one bug that invalidates the whole
// experiment is a gate that throws and enriches anyway): every error path
// returns NO_INFERENCE. Decisions + inputs land in the CostAtom's
// orchestration ledger — gate decisions are measurement data.
//
// Metering divergence (documented for review): the enhance doc names
// NativeRuntimeMeter.recordTurn for Class B metering. recordTurn writes into
// the production budget enforcer / cost-ledger — running the experiment
// through it would pollute live billing state with playtest spend. The atom's
// inference ledger uses the same integer discipline (calculateCostMicro) and
// IS the experiment's meter; production billing stays untouched.

import { Hono, type Context } from "hono"
import {
  calculateCostMicro,
  findPricing,
  type MicroPricingEntry,
} from "../../hounfour/pricing.js"
import {
  CostAtomWriter,
  RollingBusyWindow,
  costAtomMiddleware,
  getCostAtom,
  loadInfraRates,
} from "../../cost/cost-atom.js"

// ---------------------------------------------------------------------------
// Gate — pure function, ratified predicate order (enhance doc item 3)
// ---------------------------------------------------------------------------

export type GateDecision = "NO_INFERENCE" | "REFUSE_ENRICH" | "ROUTE_CHEVAL"
export type GateReason =
  | "not_requested"
  | "abstain_rule"
  | "kill_switch"
  | "roi_refuse"
  | "fail_closed"
  | "routed"

export interface GateResult {
  decision: GateDecision
  reason: GateReason
}

/** Serialized form recorded in atoms and echoed in responses. The driver
 *  aborts a phase when it sees `:kill_switch` (flatline B5). */
export function gateDecisionString(result: GateResult): string {
  return `${result.decision}:${result.reason}`
}

export interface GateInput {
  enrich: boolean
  band: string | undefined
  claim_verdict: string | undefined
  spend_today_micro: bigint
  est_inference_micro: bigint
  est_infra_micro: bigint
  x402_price_micro: bigint
  ceiling_micro: bigint
}

function isNonNegativeBigint(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n
}

const FAIL_CLOSED: GateResult = { decision: "NO_INFERENCE", reason: "fail_closed" }

/** The cheval-ROI gate. Pure — no IO, no clock, no env. Predicate order is
 *  ratified (do not reorder):
 *    1. ¬enrich                              → NO_INFERENCE
 *    2. abstain rule (INSUFFICIENT_EVIDENCE / ABSTAIN) → NO_INFERENCE
 *    3. spend + estimate over ceiling        → NO_INFERENCE (kill-switch)
 *    4. est_inference×3 > price − est_infra  → REFUSE_ENRICH (+ upgrade quote)
 *    5. any input missing / invalid / throw  → NO_INFERENCE (fail-closed)
 *    6. else                                 → ROUTE_CHEVAL
 *  Predicate 5 is implemented as validation before rows that consume each
 *  input plus a catch-all try/catch — abstains NEVER earn inference (B10). */
export function decideGate(input: GateInput | null | undefined): GateResult {
  try {
    if (!input || typeof input.enrich !== "boolean") return FAIL_CLOSED
    // Row 1
    if (!input.enrich) return { decision: "NO_INFERENCE", reason: "not_requested" }
    // Row 2 (inputs validated fail-closed first)
    if (typeof input.band !== "string" || typeof input.claim_verdict !== "string") {
      return FAIL_CLOSED
    }
    if (input.band === "INSUFFICIENT_EVIDENCE" || input.claim_verdict === "ABSTAIN") {
      return { decision: "NO_INFERENCE", reason: "abstain_rule" }
    }
    // Rows 3–4 consume the economic inputs — validate them all fail-closed
    if (
      !isNonNegativeBigint(input.spend_today_micro) ||
      !isNonNegativeBigint(input.est_inference_micro) ||
      !isNonNegativeBigint(input.est_infra_micro) ||
      !isNonNegativeBigint(input.x402_price_micro) ||
      !isNonNegativeBigint(input.ceiling_micro)
    ) {
      return FAIL_CLOSED
    }
    // Row 3 — daily spend kill-switch
    if (input.spend_today_micro + input.est_inference_micro > input.ceiling_micro) {
      return { decision: "NO_INFERENCE", reason: "kill_switch" }
    }
    // Row 4 — ROI refusal (3× margin rule)
    if (input.est_inference_micro * 3n > input.x402_price_micro - input.est_infra_micro) {
      return { decision: "REFUSE_ENRICH", reason: "roi_refuse" }
    }
    // Row 6
    return { decision: "ROUTE_CHEVAL", reason: "routed" }
  } catch {
    // Row 5 — anything unforeseen
    return FAIL_CLOSED
  }
}

// ---------------------------------------------------------------------------
// Startup config (flatline B10) — parsed ONCE; parse failure disables
// enrichment entirely (every gate call → NO_INFERENCE via predicate 5).
// ---------------------------------------------------------------------------

export interface ChevalGateConfig {
  base_url: string
  api_key: string
  model: string
  provider: string
  pricing: MicroPricingEntry
  hmac_secret: string
}

export interface GateConfig {
  ceiling_micro: bigint
  x402_price_micro: bigint
  est_input_tokens: number
  est_output_tokens: number
  est_infra_seed_micro: bigint
  cheval: ChevalGateConfig | null
}

/** ONE quote source (flatline HC7): both the gate input and the atom's
 *  x402_quote_micro come from this parser over X402_REQUEST_COST_MICRO.
 *  Default mirrors src/x402/pricing.ts:11 (100_000 = $0.10). Throws on
 *  garbage — callers decide the fail-closed consequence. */
export function parseX402QuoteMicro(env: Record<string, string | undefined>): bigint {
  const raw = env.X402_REQUEST_COST_MICRO
  if (raw === undefined) return 100_000n
  const value = BigInt(raw) // throws on non-integer strings
  if (value <= 0n) throw new Error("X402_REQUEST_COST_MICRO must be positive")
  return value
}

/** Parse gate config from env at startup. Returns null on ANY parse failure —
 *  the route then refuses all enrichment (fail-closed, B10) but still serves
 *  Class A relays. */
export function loadGateConfig(
  env: Record<string, string | undefined> = process.env,
): GateConfig | null {
  try {
    const ceilingRaw = env.COP_SPEND_CEILING_MICRO
    const ceiling = ceilingRaw === undefined ? 10_000_000n : BigInt(ceilingRaw)
    if (ceiling < 0n) return null

    const x402 = parseX402QuoteMicro(env)

    const intEnv = (raw: string | undefined, dflt: number): number => {
      if (raw === undefined) return dflt
      const v = Number.parseInt(raw, 10)
      if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`bad int env: ${raw}`)
      return v
    }
    const estInput = intEnv(env.COP_EST_INPUT_TOKENS, 2000)
    const estOutput = intEnv(env.COP_EST_OUTPUT_TOKENS, 500)
    const seedRaw = env.COP_EST_INFRA_MICRO
    const seed = seedRaw === undefined ? 1000n : BigInt(seedRaw)
    if (seed < 0n) return null

    // Cheval transport config — absence disables enrichment (null cheval),
    // it does NOT invalidate the rest of the gate config.
    let cheval: ChevalGateConfig | null = null
    const apiKey = env.COP_CHEVAL_API_KEY ?? env.OPENAI_API_KEY
    const hmacSecret = env.CHEVAL_HMAC_SECRET
    const model = env.COP_CHEVAL_MODEL ?? "gpt-4o"
    const provider = env.COP_CHEVAL_PROVIDER ?? "openai"
    const pricing = findPricing(provider, model)
    if (apiKey && hmacSecret && pricing) {
      cheval = {
        base_url: env.COP_CHEVAL_BASE_URL ?? "https://api.openai.com/v1",
        api_key: apiKey,
        model,
        provider,
        pricing,
        hmac_secret: hmacSecret,
      }
    }

    return {
      ceiling_micro: ceiling,
      x402_price_micro: x402,
      est_input_tokens: estInput,
      est_output_tokens: estOutput,
      est_infra_seed_micro: seed,
      cheval,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Estimators (flatline HC1) — pure functions of config + counters
// ---------------------------------------------------------------------------

/** Deterministic pre-route inference estimate: configured token counts at the
 *  configured tier's pricing. Single number→bigint conversion point. */
export function estimateInferenceMicro(
  estInputTokens: number,
  estOutputTokens: number,
  pricing: MicroPricingEntry,
): bigint {
  const input = calculateCostMicro(estInputTokens, pricing.input_micro_per_million)
  const output = calculateCostMicro(estOutputTokens, pricing.output_micro_per_million)
  return BigInt(input.cost_micro + output.cost_micro)
}

/** Rolling mean of the last N=20 Class A infra costs, seeded until 5 samples
 *  exist (flatline HC1). Integer mean (floor). */
export class InfraEstimator {
  private samples: bigint[] = []

  constructor(
    private readonly seed: bigint,
    private readonly capacity = 20,
    private readonly minSamples = 5,
  ) {}

  push(costMicro: bigint): void {
    if (typeof costMicro !== "bigint" || costMicro < 0n) return
    this.samples.push(costMicro)
    if (this.samples.length > this.capacity) this.samples.shift()
  }

  estimate(): bigint {
    if (this.samples.length < this.minSamples) return this.seed
    const sum = this.samples.reduce((a, b) => a + b, 0n)
    return sum / BigInt(this.samples.length)
  }
}

// ---------------------------------------------------------------------------
// Spend counter (flatline B12/B14/B15) — O(1), persisted, restart-proof
// ---------------------------------------------------------------------------

function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** Thrown when settled spend cannot be persisted (review F3): the route
 *  surfaces this as a 500 — a run with a broken kill-switch counter must be
 *  VISIBLY broken, never silently optimistic. */
export class SpendPersistError extends Error {
  constructor(cause: unknown) {
    super(`spend persist failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "SpendPersistError"
  }
}

/** Daily Class-B spend counter with reservation semantics (review F2-F5).
 *
 *  - LOADED at startup; only ENOENT counts as a fresh day — any other read/
 *    parse failure marks the counter UNAVAILABLE and every enrich request
 *    fail-closes until the operator repairs it (F5; B15 restart integrity).
 *  - `outstanding()` = settled + in-flight reservations. The route reserves
 *    the estimate SYNCHRONOUSLY with the gate decision (same microtask — no
 *    await between), so concurrent enrich requests cannot all pass the
 *    kill-switch on the same pre-spend value (F2).
 *  - Persists are serialized through an internal promise chain with unique
 *    tmp names (F4); memory commits before persist (conservative at runtime),
 *    persist failure throws SpendPersistError (F3).
 *  - Reservations are in-memory only: a crash kills in-flight invocations
 *    with the process, so they need no durability. */
export class SpendCounter {
  private day = ""
  private micro = 0n
  private reserved = 0n
  private unavailable = false
  private chain: Promise<void> = Promise.resolve()
  private tmpSeq = 0

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private fileFor(day: string): string {
    return `${this.dir}/spend-${day}.json`
  }

  async load(): Promise<void> {
    const day = utcDayKey(this.now())
    this.day = day
    this.micro = 0n
    this.reserved = 0n
    this.unavailable = false
    try {
      const { readFile } = await import("node:fs/promises")
      const raw = JSON.parse(await readFile(this.fileFor(day), "utf-8")) as {
        day?: string
        spend_micro?: string
      }
      if (raw.day !== day || typeof raw.spend_micro !== "string") {
        throw new Error("spend file shape mismatch")
      }
      const value = BigInt(raw.spend_micro)
      if (value < 0n) throw new Error("negative persisted spend")
      this.micro = value
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return // fresh day — zero is correct
      }
      // Corrupt/unreadable current-day file: fail CLOSED, not to zero (F5).
      this.unavailable = true
      console.error("[spend-counter] current-day spend file unreadable — enrichment fail-closed:", err)
    }
  }

  /** False when the persisted counter could not be read — gate must fail-close. */
  available(): boolean {
    this.rollDay()
    return !this.unavailable
  }

  private rollDay(): void {
    const day = utcDayKey(this.now())
    if (day !== this.day) {
      // A new UTC day starts fresh: no file exists yet, prior-day corruption
      // no longer governs the current ceiling.
      this.day = day
      this.micro = 0n
      this.reserved = 0n
      this.unavailable = false
    }
  }

  /** Settled + reserved spend for the current UTC day (the gate input). */
  outstanding(): bigint {
    this.rollDay()
    return this.micro + this.reserved
  }

  /** Reserve an estimate. SYNCHRONOUS by design — call it in the same
   *  microtask as the gate decision so no other request can interleave. */
  reserve(estMicro: bigint): void {
    if (typeof estMicro !== "bigint" || estMicro <= 0n) return
    this.rollDay()
    this.reserved += estMicro
  }

  /** Release a reservation without settling (invoke failed — no spend). */
  release(estMicro: bigint): void {
    if (typeof estMicro !== "bigint" || estMicro <= 0n) return
    this.reserved = this.reserved >= estMicro ? this.reserved - estMicro : 0n
  }

  /** Settle a reservation to actual spend and persist atomically.
   *  Memory commits first (runtime stays conservative even if disk fails);
   *  persist failure rejects with SpendPersistError (F3). */
  async settle(estMicro: bigint, actualMicro: bigint): Promise<void> {
    this.release(estMicro)
    if (typeof actualMicro !== "bigint" || actualMicro < 0n) {
      throw new SpendPersistError("settle called with invalid actual spend")
    }
    this.rollDay()
    this.micro += actualMicro
    const day = this.day
    const value = this.micro
    const seq = ++this.tmpSeq
    const persist = this.chain.then(async () => {
      const { mkdir, rename, writeFile } = await import("node:fs/promises")
      await mkdir(this.dir, { recursive: true })
      const file = this.fileFor(day)
      const tmp = `${file}.tmp-${process.pid}-${seq}`
      await writeFile(tmp, JSON.stringify({ day, spend_micro: value.toString(10) }), "utf-8")
      await rename(tmp, file)
    })
    this.chain = persist.catch(() => {})
    try {
      await persist
    } catch (err) {
      throw new SpendPersistError(err)
    }
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export interface ChevalEnrichResult {
  content: string
  usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number }
  /** Provider-side latency reported by cheval — subtracted from the invoke
   *  wall time to isolate spawn+HMAC+IO overhead (H3). */
  provider_latency_ms: number
}

export interface ScoreVerdictDeps {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  /** Executes one read against the RPC pool. Default: lazy RpcPool on Base
   *  with ALCHEMY_API_KEY. Injected in tests. */
  rpcExecute?: (address: string) => Promise<string | undefined>
  /** Invokes the cheval subprocess. Default: real ChevalInvoker. */
  chevalInvoke?: (prompt: string, cfg: ChevalGateConfig, traceId: string) => Promise<ChevalEnrichResult>
  dataDir?: string
  now?: () => number
}

interface StubFactSheet {
  agent?: { name?: string; symbol?: string; provider?: string }
  layers?: {
    observed?: Record<string, unknown>
    structural?: Record<string, unknown>
    readings?: Array<Record<string, unknown>>
    claim?: { verdict?: string; band?: string; adversary_tag?: string }
  }
}

function defaultRpcExecute(env: Record<string, string | undefined>): (address: string) => Promise<string | undefined> {
  let poolPromise: Promise<{ execute: <T>(fn: (client: { getCode: (a: { address: `0x${string}` }) => Promise<string | undefined> }) => Promise<T>) => Promise<T> }> | null = null
  return async (address: string) => {
    if (!poolPromise) {
      poolPromise = import("../../x402/rpc-pool.js").then(
        ({ RpcPool }) => new RpcPool({ alchemyApiKey: env.ALCHEMY_API_KEY }) as never,
      )
    }
    const pool = await poolPromise
    return pool.execute((client) => client.getCode({ address: address as `0x${string}` }))
  }
}

function defaultChevalInvoke(): (prompt: string, cfg: ChevalGateConfig, traceId: string) => Promise<ChevalEnrichResult> {
  return async (prompt, cfg, traceId) => {
    const { ChevalInvoker } = await import("../../hounfour/cheval-invoker.js")
    const invoker = new ChevalInvoker({ hmac: { secret: cfg.hmac_secret } })
    const result = await invoker.invoke({
      schema_version: 1,
      provider: {
        name: cfg.provider,
        type: "openai",
        base_url: cfg.base_url,
        api_key: cfg.api_key,
        connect_timeout_ms: 5_000,
        read_timeout_ms: 60_000,
        total_timeout_ms: 90_000,
      },
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      options: { max_tokens: 512, temperature: 0.2 },
      metadata: {
        agent: "cop-verdict-enrich",
        tenant_id: "local",
        nft_id: "",
        trace_id: traceId,
      },
      retry: {
        max_retries: 1,
        base_delay_ms: 250,
        max_delay_ms: 1_000,
        jitter_percent: 20,
        retryable_status_codes: [429, 500, 502, 503],
      },
      hmac: { signature: "", nonce: "", issued_at: "" }, // filled by the invoker's signer
    })
    return {
      content: result.content,
      usage: {
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
      },
      provider_latency_ms: result.metadata.latency_ms,
    }
  }
}

/** Self-contained route group. Mounted by server.ts under /api/v1/score —
 *  behind the gateway's JWT chain (B2); additionally enforces a bearer check
 *  against FINN_AUTH_TOKEN when set (belt-and-suspenders: the JWT middleware
 *  passes through when config.jwt.enabled is false). */
export function createScoreVerdictRoutes(deps: ScoreVerdictDeps = {}): Hono {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? fetch
  const dataDir = deps.dataDir ?? `${env.DATA_DIR ?? "./data"}/cost`
  const rpcExecute = deps.rpcExecute ?? defaultRpcExecute(env)
  const chevalInvoke = deps.chevalInvoke ?? defaultChevalInvoke()

  const gateConfig = loadGateConfig(env)
  if (gateConfig === null) {
    console.error("[score-verdict] gate config parse FAILED — enrichment disabled (fail-closed, B10)")
  } else if (gateConfig.cheval === null) {
    console.warn("[score-verdict] cheval transport not configured — enrichment disabled")
  }

  // Quote for atoms when gate config failed to parse: same single parser,
  // falling back to its documented default on garbage (HC7 — one source).
  let atomQuoteMicro: bigint
  try {
    atomQuoteMicro = gateConfig?.x402_price_micro ?? parseX402QuoteMicro(env)
  } catch {
    atomQuoteMicro = 100_000n
  }

  const writer = new CostAtomWriter(`${dataDir}/cost-atoms.jsonl`)
  const window = new RollingBusyWindow()
  const rates = loadInfraRates(env)
  const infraEstimator = new InfraEstimator(gateConfig?.est_infra_seed_micro ?? 1000n)
  const spend = new SpendCounter(dataDir, now)
  const spendLoaded = spend.load() // startup load (B15); awaited before first gate use

  const app = new Hono()

  // Bearer gate (B2). Applies before the CostAtom middleware: unauthenticated
  // probes are not measurement data.
  app.use("*", async (c, next) => {
    const required = env.FINN_AUTH_TOKEN
    if (!required) return next()
    const header = c.req.header("Authorization") ?? ""
    if (header === `Bearer ${required}`) return next()
    return c.json({ error: "Unauthorized", code: "INVALID_TOKEN" }, 401)
  })

  app.use(
    "*",
    costAtomMiddleware({
      writer,
      window,
      rates,
      now,
      // Review F1: feed the gate's rolling infra estimate from CLOSED Class A
      // atoms — est_infra_micro is the mean of the last 20, seeded until 5.
      onAtomClosed: (atom) => {
        if (atom.call_class === "A_relay") infraEstimator.push(atom.infra.cost_micro)
      },
    }),
  )

  app.get("/verdict/:agentId", async (c: Context) => {
    const handle = getCostAtom(c)
    if (!handle) {
      return c.json({ error: "cost-atom middleware missing", code: "INTERNAL_ERROR" }, 500)
    }
    const agentId = c.req.param("agentId")
    if (!agentId || agentId.length > 256) {
      const handleEarly = getCostAtom(c)
      handleEarly?.setGate(gateDecisionString(FAIL_CLOSED), { error: "invalid agentId" })
      return c.json({ error: "invalid agentId", code: "INVALID_REQUEST" }, 400)
    }
    const enrich = c.req.query("enrich") === "true"
    handle.setCallClass(enrich ? "B_enrich" : "A_relay")
    handle.setQuote(atomQuoteMicro)

    const scoreApiUrl = env.SCORE_API_URL
    if (!scoreApiUrl) {
      handle.setGate(gateDecisionString(FAIL_CLOSED), { error: "SCORE_API_URL unset" })
      return c.json({ error: "SCORE_API_URL not configured", code: "CONFIG_MISSING" }, 503)
    }

    // --- Class A: fetch the producer fact-sheet ---
    handle.addStep()
    let sheet: StubFactSheet
    try {
      const res = await fetchImpl(`${scoreApiUrl}/verdict/${encodeURIComponent(agentId)}`)
      if (!res.ok) throw new Error(`score api ${res.status}`)
      sheet = (await res.json()) as StubFactSheet
    } catch (err) {
      handle.setGate(gateDecisionString(FAIL_CLOSED), {
        error: `score fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      return c.json({ error: "score producer unavailable", code: "UPSTREAM_UNAVAILABLE" }, 502)
    }

    const claim = sheet.layers?.claim ?? {}
    const providerAddress = sheet.agent?.provider

    // --- Class A: 1× RPC cross-check (T5.4 call-site counter) ---
    handle.addStep()
    let providerCodePresent: boolean | null = null
    if (typeof providerAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(providerAddress)) {
      handle.addRpcCall()
      try {
        const code = await rpcExecute(providerAddress)
        providerCodePresent = code !== undefined && code !== "0x" && code !== ""
      } catch {
        // Provider failover/exhaustion is orchestration DATA, not a request
        // failure (arch doc §3 friction risks).
        handle.addRetries(1)
        providerCodePresent = null
      }
    }

    // --- Gate (always evaluated; decision is measurement data) ---
    await spendLoaded
    const estInference =
      gateConfig && gateConfig.cheval
        ? estimateInferenceMicro(
            gateConfig.est_input_tokens,
            gateConfig.est_output_tokens,
            gateConfig.cheval.pricing,
          )
        : null
    // Review F5: an unavailable spend counter (corrupt current-day file) must
    // fail-close every enrich request — never silently reset to zero.
    const spendAvailable = spend.available()
    const gateInput: GateInput | null =
      gateConfig && gateConfig.cheval && estInference !== null && spendAvailable
        ? {
            enrich,
            band: typeof claim.band === "string" ? claim.band : undefined,
            claim_verdict: typeof claim.verdict === "string" ? claim.verdict : undefined,
            // Review F2: settled + in-flight reservations, so concurrent
            // enrich requests cannot all pass on the same pre-spend value.
            spend_today_micro: spend.outstanding(),
            est_inference_micro: estInference,
            est_infra_micro: infraEstimator.estimate(),
            x402_price_micro: gateConfig.x402_price_micro,
            ceiling_micro: gateConfig.ceiling_micro,
          }
        : enrich
          ? null // enrichment requested but transport/config/counter unavailable → fail-closed
          : {
              // Class A short-circuit: row 1 fires before economic inputs are needed
              enrich: false,
              band: undefined,
              claim_verdict: undefined,
              spend_today_micro: 0n,
              est_inference_micro: 0n,
              est_infra_micro: 0n,
              x402_price_micro: 0n,
              ceiling_micro: 0n,
            }
    const gate = decideGate(gateInput)
    // Review F2: reservation happens in the SAME microtask as the decision —
    // no await sits between decideGate and reserve, so no other request can
    // interleave and observe stale outstanding spend.
    if (gate.decision === "ROUTE_CHEVAL" && estInference !== null) {
      spend.reserve(estInference)
    }
    const gateInputsRecord: Record<string, unknown> =
      gateInput === null
        ? { unavailable: "gate config or cheval transport missing" }
        : {
            enrich: gateInput.enrich,
            band: gateInput.band ?? null,
            claim_verdict: gateInput.claim_verdict ?? null,
            spend_today_micro: gateInput.spend_today_micro.toString(10),
            est_inference_micro: gateInput.est_inference_micro.toString(10),
            est_infra_micro: gateInput.est_infra_micro.toString(10),
            x402_price_micro: gateInput.x402_price_micro.toString(10),
            ceiling_micro: gateInput.ceiling_micro.toString(10),
          }
    handle.setGate(gateDecisionString(gate), gateInputsRecord)

    // --- Class B: routed enrichment ---
    let enrichment: { model: string; content: string } | undefined
    if (gate.decision === "ROUTE_CHEVAL" && gateConfig?.cheval) {
      handle.addStep()
      const sheetJson = JSON.stringify(sheet)
      const prompt =
        "You are an integrity analyst. Given this layered fact-sheet from a forensic " +
        "scoring API, write a 3-sentence enrichment: what the facts show, the strongest " +
        "alternative explanation, and what evidence would change the claim.\n\n" +
        sheetJson.slice(0, 6_000)
      const invokeStart = now()
      try {
        const result = await chevalInvoke(prompt, gateConfig.cheval, handle.correlationId)
        // Review F6: every externally-sourced number is validated before it
        // can reach a stored field — fractional/NaN/Infinity telemetry would
        // silently corrupt the no-float invariant while still checksumming.
        const safeCount = (v: unknown, name: string): number => {
          if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
            throw new Error(`invalid telemetry from cheval: ${name}=${String(v)}`)
          }
          return v
        }
        const promptTokens = safeCount(result.usage.prompt_tokens, "prompt_tokens")
        const completionTokens = safeCount(result.usage.completion_tokens, "completion_tokens")
        const cachedTokens = result.usage.cached_tokens === undefined ? 0 : safeCount(result.usage.cached_tokens, "cached_tokens")
        const providerLatency = safeCount(result.provider_latency_ms, "provider_latency_ms")
        const invokeWall = Math.max(0, now() - invokeStart)
        handle.setChevalSpawnMs(Math.max(0, invokeWall - providerLatency))
        const inputCost = calculateCostMicro(
          promptTokens,
          gateConfig.cheval.pricing.input_micro_per_million,
        )
        const outputCost = calculateCostMicro(
          completionTokens,
          gateConfig.cheval.pricing.output_micro_per_million,
        )
        const inferenceMicro = BigInt(inputCost.cost_micro + outputCost.cost_micro)
        handle.recordInference({
          model: gateConfig.cheval.model,
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          cached_tokens: cachedTokens,
          cost_micro: inferenceMicro,
        })
        // Review F2/F3: settle the reservation to actual spend. A persist
        // failure is surfaced as a 500 — fail-loud, the inference cost is
        // already recorded in the atom either way.
        await spend.settle(estInference ?? 0n, inferenceMicro)
        enrichment = { model: gateConfig.cheval.model, content: result.content }
      } catch (err) {
        if (err instanceof SpendPersistError) {
          // settle() already released the reservation before persisting —
          // releasing again here would eat a CONCURRENT request's reservation.
          handle.setGate(`${gateDecisionString(gate)}:spend_persist_failed`, {
            ...gateInputsRecord,
            persist_error: err.message,
          })
          return c.json(
            { error: "spend counter persist failed", code: "SPEND_PERSIST_FAILED" },
            500,
          )
        }
        spend.release(estInference ?? 0n)
        // Fail-closed AFTER routing: the spawn failed — record the attempt as
        // orchestration data, respond without enrichment. No partial billing:
        // failed invocations report no usage.
        handle.setChevalSpawnMs(Math.max(0, now() - invokeStart))
        handle.addRetries(1)
        handle.setGate(`${gateDecisionString(gate)}:invoke_failed`, {
          ...gateInputsRecord,
          invoke_error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // --- Respond (the CostAtom middleware closes + persists before return) ---
    const body: Record<string, unknown> = {
      agent_id: agentId,
      agent: sheet.agent ?? null,
      verdict: claim.verdict ?? null,
      band: claim.band ?? null,
      adversary_tag: claim.adversary_tag ?? null,
      observed: sheet.layers?.observed ?? null,
      readings_count: sheet.layers?.readings?.length ?? 0,
      cross_check: { provider_code_present: providerCodePresent },
      gate_decision: handle.gateDecision,
      x402_quote_micro: atomQuoteMicro.toString(10),
    }
    if (enrichment) body.enrichment = enrichment
    if (gate.decision === "REFUSE_ENRICH" && gateInput) {
      // Upgrade quote: the price at which the 3× ROI margin would clear.
      body.upgrade_quote_micro = (
        gateInput.est_inference_micro * 3n + gateInput.est_infra_micro
      ).toString(10)
    }
    return c.json(body)
  })

  return app
}
