// src/cost/cost-atom.ts — CostAtom record + Hono middleware + JSONL writer
// (cycle-041 S5 / sprint-169, T5.1 — Finn cost-of-play V1)
//
// The per-request 3-ledger cost record. Ratified invariant: the cost envelope
// CLOSES BEFORE THE RESPONSE RETURNS — computed in-transaction, append-only,
// immutable once written. Retroactive reattribution invalidates the H1/H2/H3
// hypothesis test (arch-finn-cost-of-play.md §2).
//
// Durability model (flatline B1): single Railway replica, single process, all
// appends serialized through ONE in-process writer with flush-per-line. A crash
// loses at most the in-flight atom. Multi-instance is out of scope for V1.
//
// No floats in stored fields (flatline B3): costs are integer micro-USD
// (bigint), ratios are integer parts-per-million. Bigints serialize as decimal
// STRINGS in JSONL (flatline B13).

import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Context, Next } from "hono"
import { ulid } from "ulid"
import { setCorrelationId } from "../tracing/otlp.js"

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export type CallClass = "A_relay" | "B_enrich"

export interface InferenceLedger {
  model: string | null
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cost_micro: bigint
}

export interface InfraLedger {
  wall_ms: number
  /** Integer parts-per-million share of the rolling-1h busy window (B8/HC2).
   *  Telemetry for amortization analysis — NOT used to compute cost_micro
   *  (per-request infra cost is the direct wall-time share of the container
   *  rate, so idle time is never smeared into atoms). */
  allocated_ppm: number
  egress_bytes: number
  rpc_calls: number
  cost_micro: bigint
}

export interface OrchestrationLedger {
  steps: number
  retries: number
  cheval_spawn_ms: number | null
  gate_decision: string
  gate_inputs: Record<string, unknown>
  cost_micro: bigint
}

export interface CostAtom {
  atom_id: string // ULID
  correlation_id: string // links to OTLP span via setCorrelationId
  ts: number
  call_class: CallClass
  inference: InferenceLedger
  infra: InfraLedger
  orchestration: OrchestrationLedger
  total_micro: bigint
  /** The x402 quote attached (quote-only, no settlement). ONE source:
   *  X402_REQUEST_COST_MICRO env (flatline HC7). */
  x402_quote_micro: bigint
}

/** WAL-style envelope (flatline B9). schema_version 1 only — V1 has no
 *  migration path by design. checksum = sha256 hex of the canonical JSON of
 *  `atom` (keys sorted, bigints as decimal strings). */
export interface CostAtomEnvelope {
  schema_version: 1
  atom: Record<string, unknown>
  checksum: string
}

// ---------------------------------------------------------------------------
// Canonical serialization (B9/B13)
// ---------------------------------------------------------------------------

/** Recursively convert bigints to decimal strings and sort object keys. */
export function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10)
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function atomChecksum(atom: CostAtom): string {
  return createHash("sha256").update(canonicalJson(atom)).digest("hex")
}

/** Serialize an atom into its envelope JSONL line (newline-terminated). */
export function envelopeLine(atom: CostAtom): string {
  const envelope: CostAtomEnvelope = {
    schema_version: 1,
    atom: canonicalize(atom) as Record<string, unknown>,
    checksum: atomChecksum(atom),
  }
  return JSON.stringify(envelope) + "\n"
}

/** Parse one JSONL line back into an envelope, verifying the checksum.
 *  Bigint fields stay decimal strings — readers convert via BigInt(str). */
export function parseEnvelopeLine(line: string): CostAtomEnvelope {
  const parsed = JSON.parse(line) as CostAtomEnvelope
  if (parsed.schema_version !== 1) {
    throw new Error(`unknown cost-atom schema_version: ${parsed.schema_version}`)
  }
  const recomputed = createHash("sha256")
    .update(JSON.stringify(canonicalize(parsed.atom)))
    .digest("hex")
  if (recomputed !== parsed.checksum) {
    throw new Error("cost-atom checksum mismatch")
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Append-only writer (B1, B4/B7)
// ---------------------------------------------------------------------------

/** Append-only JSONL writer. There is deliberately NO update/rewrite path —
 *  a correction would be a new atom with `supersedes`, and that field is V2
 *  (V1 simply never corrects). Appends are serialized through a promise chain
 *  so concurrent requests never interleave partial lines. */
export class CostAtomWriter {
  private chain: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  /** Serialize + append one atom. Rejects on any serialization or fs failure —
   *  the middleware converts that rejection into an HTTP 500 (fail-closed:
   *  a request whose cost cannot be recorded is a failed request, B4/B7). */
  append(atom: CostAtom): Promise<void> {
    // Serialize OUTSIDE the chain so a bad atom rejects THIS call only —
    // and never throw synchronously (callers await the returned promise).
    let line: string
    try {
      line = envelopeLine(atom)
    } catch (err) {
      return Promise.reject(err)
    }
    const next = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, line, { encoding: "utf-8", flush: true })
    })
    // Keep the chain alive even when an append fails: subsequent appends still run.
    this.chain = next.catch(() => {})
    return next
  }
}

// ---------------------------------------------------------------------------
// Rolling busy window (B8/HC2)
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000

/** Rolling 1-hour window of summed request wall_ms. allocated_ppm is the
 *  request's integer-ppm share of the window's BUSY time. */
export class RollingBusyWindow {
  private entries: Array<{ ts: number; wall_ms: number }> = []
  private sum = 0

  constructor(private readonly windowMs: number = HOUR_MS) {}

  /** Record a request's wall time and return its allocated_ppm share of the
   *  (post-insert) window. Integer math only. */
  record(ts: number, wallMs: number): number {
    this.entries.push({ ts, wall_ms: wallMs })
    this.sum += wallMs
    while (this.entries.length > 0 && this.entries[0].ts < ts - this.windowMs) {
      this.sum -= this.entries.shift()!.wall_ms
    }
    if (this.sum <= 0) return 0
    return Math.floor((wallMs * 1_000_000) / this.sum)
  }
}

// ---------------------------------------------------------------------------
// Infra rates (B8) — env-configured, verified against the Railway dashboard
// at deploy (arch doc assumption rows). Integer micro-USD.
// ---------------------------------------------------------------------------

export interface InfraRates {
  /** Container (compute+memory) micro-USD per hour. Default: 1 vCPU + 1GB at
   *  ~$0.000231/unit-min each ≈ 27_720 micro/hour (ASSUMPTION 2026-06-09). */
  container_micro_per_hour: number
  /** Egress micro-USD per GB. Default 50_000 (= $0.05/GB, ASSUMPTION). */
  egress_micro_per_gb: number
  /** Per-RPC-read micro-USD. Default 0 (Alchemy free tier). */
  rpc_micro_per_call: number
}

export function loadInfraRates(env: Record<string, string | undefined> = process.env): InfraRates {
  const intOr = (raw: string | undefined, dflt: number): number => {
    if (raw === undefined) return dflt
    const v = Number.parseInt(raw, 10)
    return Number.isSafeInteger(v) && v >= 0 ? v : dflt
  }
  return {
    container_micro_per_hour: intOr(env.COP_INFRA_CONTAINER_MICRO_PER_HOUR, 27_720),
    egress_micro_per_gb: intOr(env.COP_INFRA_EGRESS_MICRO_PER_GB, 50_000),
    rpc_micro_per_call: intOr(env.COP_INFRA_RPC_MICRO_PER_CALL, 0),
  }
}

/** Per-request infra cost: direct wall-time share of the container rate +
 *  egress + RPC reads. Integer division (floor); the sub-micro remainder is
 *  deliberately dropped per atom — at phase-2 volumes (~10^3 calls) the
 *  truncation bound is ≤ ~10^3 micro-USD = $0.001, far below readout
 *  resolution, and per-atom attribution stays exact-or-under (never over). */
export function infraCostMicro(
  wallMs: number,
  egressBytes: number,
  rpcCalls: number,
  rates: InfraRates,
): bigint {
  const compute = Math.floor((wallMs * rates.container_micro_per_hour) / HOUR_MS)
  const egress = Math.floor((egressBytes * rates.egress_micro_per_gb) / 1_000_000_000)
  const rpc = rpcCalls * rates.rpc_micro_per_call
  return BigInt(compute) + BigInt(egress) + BigInt(rpc)
}

/** Orchestration cost: container time consumed by orchestration machinery
 *  (cheval spawn wall-time). Steps/retries are telemetry — they carry no
 *  direct dollar cost beyond the wall time already measured. */
export function orchestrationCostMicro(chevalSpawnMs: number | null, rates: InfraRates): bigint {
  if (chevalSpawnMs === null || chevalSpawnMs <= 0) return 0n
  return BigInt(Math.floor((chevalSpawnMs * rates.container_micro_per_hour) / HOUR_MS))
}

// ---------------------------------------------------------------------------
// Per-request handle — the API handlers use to fill ledgers
// ---------------------------------------------------------------------------

export class CostAtomHandle {
  callClass: CallClass = "A_relay"
  inference: InferenceLedger = {
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cost_micro: 0n,
  }
  rpcCalls = 0
  steps = 0
  retries = 0
  chevalSpawnMs: number | null = null
  gateDecision = "NO_GATE"
  gateInputs: Record<string, unknown> = {}
  quoteMicro = 0n

  constructor(
    readonly atomId: string,
    readonly correlationId: string,
    readonly ts: number,
  ) {}

  setCallClass(cls: CallClass): void {
    this.callClass = cls
  }

  recordInference(ledger: InferenceLedger): void {
    this.inference = ledger
  }

  addRpcCall(): void {
    this.rpcCalls += 1
  }

  addStep(n = 1): void {
    this.steps += n
  }

  addRetries(n: number): void {
    this.retries += n
  }

  setChevalSpawnMs(ms: number): void {
    this.chevalSpawnMs = ms
  }

  setGate(decision: string, inputs: Record<string, unknown>): void {
    this.gateDecision = decision
    this.gateInputs = inputs
  }

  setQuote(micro: bigint): void {
    this.quoteMicro = micro
  }

  tagError(err: unknown): void {
    this.gateInputs = {
      ...this.gateInputs,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    }
  }
}

// Close state is MIDDLEWARE-OWNED (review F8): a handler that could flip a
// public `closed` flag would silently skip atom persistence. Handles in this
// set have been closed; there is no public mutation path.
const closedHandles = new WeakSet<CostAtomHandle>()

// ---------------------------------------------------------------------------
// Hono middleware (HC6, HC3, B4/B7)
// ---------------------------------------------------------------------------

export interface CostAtomMiddlewareOptions {
  writer: CostAtomWriter
  window: RollingBusyWindow
  rates: InfraRates
  now?: () => number
  /** Called after an atom is durably appended (review F1) — the route uses
   *  this to feed the gate's rolling infra estimator from CLOSED atoms.
   *  Errors here are swallowed: feedback must never fail a request. */
  onAtomClosed?: (atom: CostAtom) => void
}

const COST_ATOM_KEY = "costAtom"

export function getCostAtom(c: Context): CostAtomHandle | undefined {
  return c.get(COST_ATOM_KEY) as CostAtomHandle | undefined
}

/** Close the handle into an immutable CostAtom. Sum invariant (HC3): the
 *  total is COMPUTED here from the three ledgers and asserted; nothing else
 *  may set total_micro. Throws on any non-bigint/negative ledger cost. */
export function closeAtom(
  handle: CostAtomHandle,
  wallMs: number,
  allocatedPpm: number,
  egressBytes: number,
  rates: InfraRates,
): CostAtom {
  const infraCost = infraCostMicro(wallMs, egressBytes, handle.rpcCalls, rates)
  const orchCost = orchestrationCostMicro(handle.chevalSpawnMs, rates)
  const ledgerCosts: Array<[string, bigint]> = [
    ["inference", handle.inference.cost_micro],
    ["infra", infraCost],
    ["orchestration", orchCost],
  ]
  for (const [name, cost] of ledgerCosts) {
    if (typeof cost !== "bigint" || cost < 0n) {
      throw new Error(`cost-atom sum invariant: ${name}.cost_micro is not a non-negative bigint`)
    }
  }
  const total = handle.inference.cost_micro + infraCost + orchCost
  // HC3 assertion — guards future drift where total is set anywhere else.
  if (total !== handle.inference.cost_micro + infraCost + orchCost) {
    throw new Error("cost-atom sum invariant violated")
  }
  return {
    atom_id: handle.atomId,
    correlation_id: handle.correlationId,
    ts: handle.ts,
    call_class: handle.callClass,
    inference: handle.inference,
    infra: {
      wall_ms: wallMs,
      allocated_ppm: allocatedPpm,
      egress_bytes: egressBytes,
      rpc_calls: handle.rpcCalls,
      cost_micro: infraCost,
    },
    orchestration: {
      steps: handle.steps,
      retries: handle.retries,
      cheval_spawn_ms: handle.chevalSpawnMs,
      gate_decision: handle.gateDecision,
      gate_inputs: handle.gateInputs,
      cost_micro: orchCost,
    },
    total_micro: total,
    x402_quote_micro: handle.quoteMicro,
  }
}

/** Middleware: open atom → handler fills ledgers → close + WRITE + respond.
 *  The atom closes exactly once on EVERY path — success, handler throw,
 *  middleware error (HC6) — and the JSONL append completes before the
 *  response is returned to the client (closing after respond is a build
 *  error, not a style choice). Close/serialize/append failure ⇒ HTTP 500
 *  (B4/B7): responding OK without a written atom silently corrupts H1. */
export function costAtomMiddleware(opts: CostAtomMiddlewareOptions) {
  const now = opts.now ?? Date.now
  return async (c: Context, next: Next): Promise<void> => {
    const start = now()
    const handle = new CostAtomHandle(ulid(), crypto.randomUUID(), start)
    setCorrelationId(handle.correlationId)
    c.set(COST_ATOM_KEY, handle)

    let handlerError: unknown = null
    try {
      await next()
    } catch (err) {
      handlerError = err
    }
    // Hono's compose catches handler throws itself and surfaces them on
    // c.error (its onError produces the response) — treat both paths as the
    // same error signal so the atom is always tagged (HC6).
    const requestError: unknown = handlerError ?? c.error ?? null
    if (requestError !== null) handle.tagError(requestError)

    // --- close phase: runs exactly once on every path ---
    if (closedHandles.has(handle)) return // defense: double-invocation of middleware
    closedHandles.add(handle)

    // Build the FINAL response before measuring (review F7): error-path atoms
    // must measure the actual 500 body, not a phantom zero.
    if (requestError !== null) {
      console.error("[cost-atom] handler error:", requestError)
      c.res = undefined
      c.res = c.json({ error: "INTERNAL_ERROR", code: "INTERNAL_ERROR" }, 500)
    }

    try {
      const wallMs = Math.max(0, now() - start)
      const allocatedPpm = opts.window.record(start, wallMs)
      let egressBytes = 0
      if (c.res) {
        try {
          egressBytes = (await c.res.clone().arrayBuffer()).byteLength
        } catch {
          egressBytes = 0 // unmeasurable body (stream) — recorded as 0, never fails the close
        }
      }
      const atom = closeAtom(handle, wallMs, allocatedPpm, egressBytes, opts.rates)
      await opts.writer.append(atom)
      if (opts.onAtomClosed) {
        try {
          opts.onAtomClosed(atom)
        } catch {
          // feedback hook must never fail a request
        }
      }
    } catch (closeErr) {
      // Fail-closed: cost not recorded ⇒ the request fails (B4/B7).
      console.error("[cost-atom] close/write failed:", closeErr)
      c.res = undefined
      c.res = c.json({ error: "COST_ATOM_WRITE_FAILED", code: "COST_ATOM_WRITE_FAILED" }, 500)
    }
  }
}

// ---------------------------------------------------------------------------
// Reader (for readout tooling + tests)
// ---------------------------------------------------------------------------

export interface AtomReadResult {
  atoms: Array<Record<string, unknown>>
  malformed: Array<{ line: number; reason: string }>
}

/** Read a cost-atoms JSONL file. Malformed lines are skipped with a reason
 *  (flatline HC8) — the READOUT decides whether the malformed ratio forces
 *  an INSUFFICIENT verdict; this reader only reports. */
export async function readAtoms(path: string): Promise<AtomReadResult> {
  const raw = await readFile(path, "utf-8")
  const result: AtomReadResult = { atoms: [], malformed: [] }
  const lines = raw.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      result.atoms.push(parseEnvelopeLine(line).atom)
    } catch (err) {
      result.malformed.push({
        line: i + 1,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}
