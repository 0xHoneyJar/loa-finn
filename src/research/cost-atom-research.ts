// src/research/cost-atom-research.ts — the `research` CostAtom call-class.
// (bd-8ywq.6 · Agent R&D Lab V1 · Acceptance Contracts A + E)
//
// The lab's ONE HARD GATE, made a mechanism rather than a sentence: no code
// path produces a finding without a closed, hash-chained CostAtom. This module
// mirrors `src/cost/cost-atom.ts` EXACTLY where it matters —
//   · integer micro-USD only (bigint; serialized as decimal STRINGS, no floats)
//   · append-only JSONL, immutable once written (no update/rewrite path)
//   · the atom CLOSES BEFORE THE FINDING RETURNS
// — and adds what Contract A requires beyond the service meter:
//   · a `prev_hash` HASH CHAIN (the research ledger is a linked list of events)
//   · the estimate → actual split (a `budget_reservation` BEFORE the call, an
//     `actual_cost` AFTER, both linked + chained)
//   · TYPED FAILURE atoms (a failed sensor call is a first-class linked atom,
//     never a gap in the chain)
//   · MODELINV dedup (Cheval-routed LLM spend is referenced, not re-charged).
//
// STRUCTURAL ENFORCEMENT (the unrepresentable-finding contract): the only way
// to obtain a finding is the resolved value of `runMeteredResearch`, which is
// constructed only AFTER `await writer.append(actualAtom)` has durably closed
// the atom. The sensor body is a closure that receives the atom handle; it
// cannot surface a finding except by returning through this function. A finding
// without a closed atom is therefore unrepresentable, not merely discouraged.

import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { ulid } from "ulid"
import type {
  ModelinvEntry,
  ModelinvRef,
  ResearchAtomEnvelope,
  ResearchCostAtom,
  ResearchSensor,
} from "./schemas/index.js"
import { GENESIS_HASH } from "./schemas/index.js"
import type { Citation } from "./schemas/spine-event.js"

// ---------------------------------------------------------------------------
// Canonical serialization — mirrors src/cost/cost-atom.ts (B9/B13) so the two
// ledgers hash identically: bigints → decimal strings, object keys sorted.
// Re-implemented locally (not imported) to keep `src/research` self-contained —
// importing the service meter would also pull in its tracing/Hono module graph.
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

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/** sha256 hex of a probe question — the stable join key across the CostAtom,
 *  the spine event, and the TETLOCK forecast. */
export function questionHash(question: string): string {
  return sha256Hex(question)
}

/** entry_hash = sha256 of the canonical JSON of { schema_version, prev_hash,
 *  atom }. The `atom` here is already canonicalized (bigints as strings);
 *  `canonicalJson` is idempotent so this is stable. */
function entryHash(schemaVersion: 1, prevHash: string, atom: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ schema_version: schemaVersion, prev_hash: prevHash, atom }))
}

// ---------------------------------------------------------------------------
// Integer-micro guard (B3) — no floats ever reach the ledger.
// ---------------------------------------------------------------------------

/** Throws if any cost field is not a non-negative bigint. Float contamination
 *  (e.g. `1.5 as unknown as bigint`) fails here, not at read time. */
export function assertAtomIntegerMicro(atom: ResearchCostAtom): void {
  const fields: Array<[string, unknown]> = [
    ["cost_micro", atom.cost_micro],
    ["inference_micro", atom.inference_micro],
  ]
  for (const [name, v] of fields) {
    if (typeof v !== "bigint" || v < 0n) {
      throw new Error(`research-atom integer-micro: ${name} must be a non-negative bigint`)
    }
  }
  if (atom.modelinv_ref) {
    const c = atom.modelinv_ref.cost_micro
    if (typeof c !== "bigint" || c < 0n) {
      throw new Error("research-atom integer-micro: modelinv_ref.cost_micro must be a non-negative bigint")
    }
  }
}

// ---------------------------------------------------------------------------
// Append-only, hash-chained JSONL writer (Contract A · Contract C single-writer)
// ---------------------------------------------------------------------------

/** Append-only JSONL writer that maintains the `prev_hash` chain head. There is
 *  deliberately NO update/rewrite path. Appends are serialized through a
 *  promise chain so concurrent probes never interleave a partial line OR fork
 *  the hash chain — order is the chain. The head is recovered lazily from the
 *  file tail on first append, so re-opening an existing ledger continues its
 *  chain rather than re-genesis-ing it. */
export class ResearchAtomWriter {
  private chain: Promise<void> = Promise.resolve()
  private head: string | null = null

  constructor(readonly path: string) {}

  /** Recover the chain head (last entry_hash) from the file, or GENESIS. */
  private async ensureHead(): Promise<void> {
    if (this.head !== null) return
    try {
      const raw = await readFile(this.path, "utf-8")
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
      if (lines.length === 0) {
        this.head = GENESIS_HASH
        return
      }
      const last = JSON.parse(lines[lines.length - 1]) as ResearchAtomEnvelope
      this.head = last.entry_hash
    } catch {
      this.head = GENESIS_HASH
    }
  }

  /** Serialize + chain + append one atom. Resolves with the written envelope
   *  (so callers can read back its assigned `prev_hash`/`entry_hash`). Rejects
   *  on float contamination or any fs failure — the head is NOT advanced on
   *  failure, so the chain stays intact and the next append retries from the
   *  same link. */
  append(atom: ResearchCostAtom): Promise<ResearchAtomEnvelope> {
    try {
      assertAtomIntegerMicro(atom)
    } catch (err) {
      return Promise.reject(err)
    }
    const run = this.chain.then(async () => {
      await this.ensureHead()
      const prevHash = this.head as string
      const canonAtom = canonicalize(atom) as Record<string, unknown>
      const eh = entryHash(1, prevHash, canonAtom)
      const envelope: ResearchAtomEnvelope = {
        schema_version: 1,
        prev_hash: prevHash,
        atom: canonAtom,
        entry_hash: eh,
      }
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, JSON.stringify(envelope) + "\n", { encoding: "utf-8", flush: true })
      this.head = eh
      return envelope
    })
    // Keep the chain alive even when an append fails: later appends still run.
    this.chain = run.then(
      () => {},
      () => {},
    )
    return run
  }
}

// ---------------------------------------------------------------------------
// Reader + chain verification
// ---------------------------------------------------------------------------

export function parseEnvelopeLine(line: string): ResearchAtomEnvelope {
  const env = JSON.parse(line) as ResearchAtomEnvelope
  if (env.schema_version !== 1) {
    throw new Error(`unknown research-atom schema_version: ${env.schema_version}`)
  }
  return env
}

/** Rehydrate a stored atom (decimal-string cost fields → bigint). */
export function decodeAtom(stored: Record<string, unknown>): ResearchCostAtom {
  const mref = stored.modelinv_ref as Record<string, unknown> | null
  return {
    ...(stored as unknown as ResearchCostAtom),
    cost_micro: BigInt(stored.cost_micro as string),
    inference_micro: BigInt(stored.inference_micro as string),
    modelinv_ref: mref
      ? ({ ...(mref as unknown as ModelinvRef), cost_micro: BigInt(mref.cost_micro as string) })
      : null,
  }
}

export interface ReadResult {
  envelopes: ResearchAtomEnvelope[]
  atoms: ResearchCostAtom[]
}

/** Read a research-atom JSONL file into envelopes + rehydrated atoms. */
export async function readResearchAtoms(path: string): Promise<ReadResult> {
  const raw = await readFile(path, "utf-8")
  const envelopes: ResearchAtomEnvelope[] = []
  const atoms: ResearchCostAtom[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    const env = parseEnvelopeLine(t)
    envelopes.push(env)
    atoms.push(decodeAtom(env.atom))
  }
  return { envelopes, atoms }
}

export interface ChainVerification {
  valid: boolean
  length: number
  /** Index of the first broken link, or null if the chain is intact. */
  brokenAt: number | null
  reason: string | null
}

/** Verify the hash chain from genesis: every `entry_hash` recomputes (tamper
 *  detection) and every `prev_hash` links to the prior `entry_hash`, the first
 *  being GENESIS (break/reorder/delete detection). Recomputing from GENESIS is
 *  itself the genesis-recompute check. */
export function verifyChain(envelopes: ResearchAtomEnvelope[]): ChainVerification {
  let prev = GENESIS_HASH
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]
    if (env.prev_hash !== prev) {
      return { valid: false, length: envelopes.length, brokenAt: i, reason: `prev_hash break at index ${i}` }
    }
    const recomputed = entryHash(env.schema_version, env.prev_hash, env.atom)
    if (recomputed !== env.entry_hash) {
      return { valid: false, length: envelopes.length, brokenAt: i, reason: `entry_hash tamper at index ${i}` }
    }
    prev = env.entry_hash
  }
  return { valid: true, length: envelopes.length, brokenAt: null, reason: null }
}

// ---------------------------------------------------------------------------
// Spend reconciliation — Contract E #4 (a single LLM call appears exactly once)
// ---------------------------------------------------------------------------

/** Full spend a single atom represents: its research-charged portion plus, if
 *  its inference was metered by MODELINV, the referenced entry's spend. */
export function atomTotalMicro(atom: ResearchCostAtom): bigint {
  return atom.cost_micro + (atom.modelinv_ref ? atom.modelinv_ref.cost_micro : 0n)
}

/** Variance of actual vs reserved (estimate). Positive ⇒ the call cost more
 *  than reserved. Used for the estimate/actual reconciliation acceptance. */
export function reservationVariance(reservation: ResearchCostAtom, actual: ResearchCostAtom): bigint {
  return atomTotalMicro(actual) - atomTotalMicro(reservation)
}

export interface SpendReconciliation {
  /** True total spend across the research ledger AND MODELINV, each LLM call
   *  counted exactly once. */
  total_micro: bigint
  /** Atoms that BOTH reference MODELINV and charge inference locally — a
   *  double-count. Empty in a healthy ledger. */
  double_counted: Array<{ atom_id: string; request_id: string }>
  /** Atoms referencing a MODELINV entry that is absent from the provided
   *  ledger (dangling reference). */
  missing_modelinv: Array<{ atom_id: string; request_id: string }>
}

/** Reconcile research-atom spend against the MODELINV ledger so a single LLM
 *  call's dollars appear EXACTLY ONCE. Reservation (estimate) atoms are
 *  excluded — estimates are not spend. For each terminal atom: its local
 *  `cost_micro` always counts; if it references MODELINV, that entry's spend is
 *  added once (de-duplicated by `request_id`) and the atom is flagged if it ALSO
 *  charged inference locally (the forbidden double-count). */
export function reconcileSpend(
  atoms: ResearchCostAtom[],
  modelinvEntries: ModelinvEntry[],
): SpendReconciliation {
  const byReq = new Map(modelinvEntries.map((e) => [e.request_id, e]))
  const seenReq = new Set<string>()
  const double_counted: Array<{ atom_id: string; request_id: string }> = []
  const missing_modelinv: Array<{ atom_id: string; request_id: string }> = []
  let total = 0n
  for (const a of atoms) {
    if (a.kind === "budget_reservation") continue
    total += a.cost_micro
    if (a.modelinv_ref) {
      const req = a.modelinv_ref.request_id
      if (a.inference_micro !== 0n) double_counted.push({ atom_id: a.atom_id, request_id: req })
      const entry = byReq.get(req)
      if (!entry) {
        missing_modelinv.push({ atom_id: a.atom_id, request_id: req })
        continue
      }
      if (!seenReq.has(req)) {
        total += BigInt(entry.cost_micro_usd)
        seenReq.add(req)
      }
    }
  }
  return { total_micro: total, double_counted, missing_modelinv }
}

// ---------------------------------------------------------------------------
// The metered-probe API — Contract A structural enforcement
// ---------------------------------------------------------------------------

/** Raised when a probe's estimate exceeds the hard per-probe ceiling
 *  (MAX_MICRO_USD_PER_PROBE). The autonomous-safe enforcement — aborts before
 *  the sensor call runs (the budget_reservation records the blocked attempt).
 *
 *  FIX#1 (bd-8ywq.7): the ceiling abort no longer leaves the reservation
 *  dangling in `reserved`. `runMeteredResearch` appends a TERMINAL failure atom
 *  (`error_class: "ProbeCeilingError"`, linked to the reservation) BEFORE
 *  throwing — so an over-ceiling probe closes its chain like any other failure
 *  and the audit trail never shows an open reservation with no terminal atom. */
export class ProbeCeilingError extends Error {
  constructor(
    readonly estimateMicro: bigint,
    readonly ceilingMicro: bigint,
  ) {
    super(`probe estimate ${estimateMicro} micro-USD exceeds ceiling ${ceilingMicro} micro-USD`)
    this.name = "ProbeCeilingError"
  }
}

/** A typed sensor failure that can carry the spend incurred BEFORE it failed
 *  (FIX#2, bd-8ywq.7). When a sensor body throws this, `runMeteredResearch`
 *  records `partial_micro` on the linked `failure` atom instead of charging 0 —
 *  so a call that spent real money and then errored (a timeout after the LLM
 *  round-trip, a Dune query that ran but the parse failed) is METERED, not lost.
 *  Any other thrown error charges 0 (no evidence spend occurred). `partial_micro`
 *  MUST be a non-negative integer-micro bigint — it flows straight onto the
 *  ledger and is integer-micro-asserted at append time. */
export class ResearchSensorError extends Error {
  readonly partial_micro: bigint
  constructor(message: string, partial_micro: bigint = 0n) {
    super(message)
    this.name = "ResearchSensorError"
    this.partial_micro = typeof partial_micro === "bigint" && partial_micro > 0n ? partial_micro : 0n
  }
}

/** The handle the sensor body receives. It carries the reservation identity but
 *  exposes NO way to surface a finding — the body returns its result through
 *  `runMeteredResearch`, which owns closing the atom. */
export interface ResearchCall {
  readonly reservationAtomId: string
  readonly sensor: ResearchSensor
  readonly questionHash: string
}

/** What a sensor body returns. The finding is captured here but not handed to
 *  the caller until the actual_cost atom is durably appended. */
export interface ResearchBodyResult {
  finding: string
  citations: Citation[]
  /** Total actual cost charged to the RESEARCH ledger, integer micro-USD. When
   *  the LLM spend is metered by MODELINV, this excludes the inference (which
   *  lives in `modelinv_ref`). */
  actual_micro: bigint
  /** The inference portion of `actual_micro`. MUST be 0 when `modelinv_ref` is
   *  set (dedup invariant — `runMeteredResearch` enforces it). */
  inference_micro?: bigint
  modelinv_ref?: ModelinvRef | null
  provider_intended?: string | null
  provider_resolved?: string | null
}

export interface MeteredResearchOptions {
  writer: ResearchAtomWriter
  sensor: ResearchSensor
  question: string
  /** Pre-call estimate → the `budget_reservation` atom, surfaced to the
   *  operator BEFORE the call runs. */
  estimate_micro: bigint
  /** Hard per-probe ceiling. If `estimate_micro` exceeds it, the probe aborts
   *  with `ProbeCeilingError` before the sensor call runs. */
  ceiling_micro?: bigint
  now?: () => number
}

export interface MeteredResearchResult {
  finding: string
  citations: Citation[]
  /** The estimate atom (surfaced before the call). */
  reservation: ResearchAtomEnvelope
  /** The closed actual_cost atom (durable BEFORE this result exists). */
  actual: ResearchAtomEnvelope
  /** `citations.length > 0`. False ⇒ the orchestrator returns INSUFFICIENT. */
  grounded: boolean
}

/** Run a sensor call under the cost gate.
 *
 *  Sequence (each step durable before the next): write the estimated
 *  `budget_reservation` → (abort if over ceiling) → run the sensor body → on
 *  success write the chained `actual_cost` atom and ONLY THEN return the finding
 *  → on body throw write a chained typed `failure` atom and re-throw (no finding
 *  escapes). The reservation, actual, and failure atoms all share one
 *  hash-chain; a failure leaves NO gap. */
export async function runMeteredResearch(
  opts: MeteredResearchOptions,
  body: (call: ResearchCall) => Promise<ResearchBodyResult>,
): Promise<MeteredResearchResult> {
  const now = opts.now ?? Date.now
  if (typeof opts.estimate_micro !== "bigint" || opts.estimate_micro < 0n) {
    throw new Error("estimate_micro must be a non-negative bigint")
  }
  const qHash = questionHash(opts.question)

  // 1. budget_reservation FIRST — estimated, chained, surfaced to the operator.
  const reservationId = ulid()
  const reservationAtom: ResearchCostAtom = {
    atom_id: reservationId,
    kind: "budget_reservation",
    status: "reserved",
    sensor: opts.sensor,
    question_hash: qHash,
    cost_micro: opts.estimate_micro,
    inference_micro: 0n,
    citations_count: 0,
    grounded: false,
    ts: now(),
    reservation_ref: null,
    error_class: null,
    modelinv_ref: null,
    provider_intended: null,
    provider_resolved: null,
  }
  const reservation = await opts.writer.append(reservationAtom)

  // 2. Hard ceiling: abort BEFORE the sensor call. FIX#1 (bd-8ywq.7): append a
  //    TERMINAL failure atom that settles the reservation BEFORE throwing — the
  //    over-ceiling reservation must not dangle in `reserved` with no terminal
  //    atom. The chain stays closed (reservation → ceiling-failure), exactly as
  //    a sensor failure does, and `ProbeCeilingError` still propagates so the
  //    autonomous abort is unchanged.
  if (opts.ceiling_micro !== undefined && opts.estimate_micro > opts.ceiling_micro) {
    const ceilingFailureAtom: ResearchCostAtom = {
      atom_id: ulid(),
      kind: "failure",
      status: "failed",
      sensor: opts.sensor,
      question_hash: qHash,
      cost_micro: 0n,
      inference_micro: 0n,
      citations_count: 0,
      grounded: false,
      ts: now(),
      reservation_ref: reservationId,
      error_class: "ProbeCeilingError",
      modelinv_ref: null,
      provider_intended: null,
      provider_resolved: null,
    }
    await opts.writer.append(ceilingFailureAtom)
    throw new ProbeCeilingError(opts.estimate_micro, opts.ceiling_micro)
  }

  // 3. Run the sensor. The body is the finding-returning closure — it can only
  //    surface a finding by returning here.
  let result: ResearchBodyResult
  try {
    result = await body({ reservationAtomId: reservationId, sensor: opts.sensor, questionHash: qHash })
  } catch (err) {
    // Typed FAILURE atom — first-class, linked to the reservation, chained.
    // No gap in the chain; no finding escapes (we re-throw). FIX#2 (bd-8ywq.7):
    // a `ResearchSensorError` carries the spend incurred before it failed, so a
    // call that spent real money then errored is metered, not lost. Any other
    // error charges 0 (no evidence spend occurred).
    const partialMicro = err instanceof ResearchSensorError ? err.partial_micro : 0n
    const failureAtom: ResearchCostAtom = {
      atom_id: ulid(),
      kind: "failure",
      status: "failed",
      sensor: opts.sensor,
      question_hash: qHash,
      cost_micro: partialMicro,
      inference_micro: 0n,
      citations_count: 0,
      grounded: false,
      ts: now(),
      reservation_ref: reservationId,
      error_class: err instanceof Error ? err.name : "Error",
      modelinv_ref: null,
      provider_intended: null,
      provider_resolved: null,
    }
    await opts.writer.append(failureAtom)
    throw err
  }

  // 4. Dedup invariant: a MODELINV-referenced call must NOT also charge
  //    inference here (Contract E #4).
  const inference = result.inference_micro ?? 0n
  if (result.modelinv_ref && inference !== 0n) {
    throw new Error(
      "MODELINV dedup: inference_micro must be 0 when modelinv_ref is set (spend is metered by MODELINV, not the research ledger)",
    )
  }

  // 5. actual_cost atom — chained, linked to the reservation + MODELINV. This
  //    append is what makes the finding representable: it closes BEFORE return.
  const grounded = result.citations.length > 0
  const actualAtom: ResearchCostAtom = {
    atom_id: ulid(),
    kind: "actual_cost",
    status: "settled",
    sensor: opts.sensor,
    question_hash: qHash,
    cost_micro: result.actual_micro,
    inference_micro: inference,
    citations_count: result.citations.length,
    grounded,
    ts: now(),
    reservation_ref: reservationId,
    error_class: null,
    modelinv_ref: result.modelinv_ref ?? null,
    provider_intended: result.provider_intended ?? null,
    provider_resolved: result.provider_resolved ?? null,
  }
  const actual = await opts.writer.append(actualAtom)

  return { finding: result.finding, citations: result.citations, reservation, actual, grounded }
}
