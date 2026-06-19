// src/lab/metabolism/population-ledger.ts — the Archivist.
//
// An append-only, content-addressed, hash-chained ledger of every strategy that
// entered the PSRO population. It MIRRORS the ResearchAtomWriter idiom EXACTLY
// (src/research/cost-atom-research.ts:115-172): a promise-chained append (order
// is the chain), lazy `ensureHead()` head-recovery from the file tail, and
// `appendFile(..., {flush:true})`. It REUSES `canonicalize` / `canonicalJson` /
// `verifyChain` / `GENESIS_HASH` rather than reinventing them — the spec's
// "reuse the idiom, don't reinvent" rule.
//
// CONTENT-ADDRESSED: a strategy's id is the sha256 of its canonical integer-milli
// vector. Two appends of the same vector produce the same id, so the population
// is deduped by construction (the Archivist records identity, it does not decide
// novelty — that is the Oracle's job in segment B; anti-fox: this ledger only
// RECORDS + VERIFIES, it never decides convergence).
//
// ANTI-FOX: the Archivist measures nothing and decides nothing. It records the
// population and verifies its own chain. The Hand measures; the solver decides.

import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  canonicalJson,
  canonicalize,
  verifyChain,
} from "../../research/cost-atom-research.js"
import { GENESIS_HASH } from "../../research/schemas/index.js"
import type { ResearchAtomEnvelope } from "../../research/schemas/index.js"
import { assertIntegerDomain, type PopulationRecord } from "./types.js"

/** Default RUNTIME ledger output path — exported const, matching the
 *  spine-ledger.ts:39 / indexing-ledger.ts:29 convention. Lives in the STATE zone
 *  (grimoires/loa/lab/metabolism/), NOT the App zone — generated ledger state is
 *  session-spanning State, alongside grimoires/loa/lab/cabt-calibration.jsonl
 *  (Segment B's deferred MINOR, resolved in Segment C). Overridable via the
 *  writer's constructor arg. */
export const POPULATION_LEDGER_PATH = "grimoires/loa/lab/metabolism/population.jsonl"

/** sha256 hex — identical to the PRIVATE `sha256Hex` at
 *  cost-atom-research.ts:64 (createHash("sha256").update(s).digest("hex")). The
 *  spec sanctions recomputing it here rather than exporting the private one, so
 *  this module stays a pure CONSUMER of `src/research` (no behavior change). */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/** entry_hash = sha256 of the canonical JSON of
 *  { schema_version, prev_hash, atom }. IDENTICAL formula AND key to
 *  cost-atom-research.ts:74-79 — the preimage keys the canonical record under
 *  `atom`, NOT `record`. This is load-bearing: `verifyChain` (which we delegate
 *  to in `verifyPopulationChain`) recomputes exactly this preimage with the
 *  record under `atom`, so the stored hash must be computed the same way to match
 *  bit-for-bit. The PUBLIC envelope still exposes the record under the friendlier
 *  `record` key; only the hash PREIMAGE uses `atom`. */
function entryHash(schemaVersion: 1, prevHash: string, record: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ schema_version: schemaVersion, prev_hash: prevHash, atom: record }))
}

/** The population envelope — same SHAPE + formula as ResearchAtomEnvelope, with
 *  the canonicalized record under `record` instead of `atom`. */
export interface PopulationEnvelope {
  schema_version: 1
  prev_hash: string
  record: Record<string, unknown>
  entry_hash: string
}

/** Content-address a population vector: the strategy_id is the sha256 hex of the
 *  canonical integer-milli vector. Deterministic + collision-resistant — the
 *  same vec always yields the same id (dedup by construction). */
export function strategyIdFor(vecMilli: number[]): string {
  // Guard the input is already integer-domain — a float vec must never be hashed
  // (it would serialize a float and the id would be unstable across rounding).
  assertIntegerDomain(vecMilli, "vec_milli")
  return sha256Hex(canonicalJson(vecMilli))
}

/** The Archivist. Append-only, hash-chained, promise-serialized writer mirroring
 *  ResearchAtomWriter (cost-atom-research.ts:115-172). There is deliberately NO
 *  update/rewrite path. */
export class PopulationLedgerWriter {
  private chain: Promise<void> = Promise.resolve()
  private head: string | null = null

  constructor(readonly path: string) {}

  /** Recover the chain head (last entry_hash) from the file tail, or GENESIS —
   *  re-opening an existing ledger CONTINUES its chain (lazy ensureHead). */
  private async ensureHead(): Promise<void> {
    if (this.head !== null) return
    try {
      const raw = await readFile(this.path, "utf-8")
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
      if (lines.length === 0) {
        this.head = GENESIS_HASH
        return
      }
      const last = JSON.parse(lines[lines.length - 1]) as PopulationEnvelope
      this.head = last.entry_hash
    } catch {
      this.head = GENESIS_HASH
    }
  }

  /** Serialize + chain + append one population record. Rejects on float
   *  contamination (assertIntegerDomain) or any fs failure — the head is NOT
   *  advanced on failure, so the chain stays intact. Resolves with the written
   *  envelope (so callers can read back its prev_hash/entry_hash). */
  append(record: PopulationRecord): Promise<PopulationEnvelope> {
    try {
      // Write-time no-float gate: every numeric field must be an integer.
      assertIntegerDomain(record)
      // Content-address invariant: the stored id MUST equal the hash of the
      // stored vector (a tampered/wrong id is caught here, not at read time).
      const expectedId = strategyIdFor(record.vec_milli)
      if (record.strategy_id !== expectedId) {
        throw new Error(
          `population-ledger: strategy_id ${record.strategy_id} ≠ content hash ${expectedId} of vec_milli`,
        )
      }
    } catch (err) {
      return Promise.reject(err)
    }
    const run = this.chain.then(async () => {
      await this.ensureHead()
      const prevHash = this.head as string
      const canonRecord = canonicalize(record) as Record<string, unknown>
      const eh = entryHash(1, prevHash, canonRecord)
      const envelope: PopulationEnvelope = {
        schema_version: 1,
        prev_hash: prevHash,
        record: canonRecord,
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

/** Parse one JSONL envelope line, asserting the schema version. */
export function parsePopulationLine(line: string): PopulationEnvelope {
  const env = JSON.parse(line) as PopulationEnvelope
  if (env.schema_version !== 1) {
    throw new Error(`unknown population schema_version: ${env.schema_version}`)
  }
  return env
}

export interface PopulationReadResult {
  envelopes: PopulationEnvelope[]
  records: PopulationRecord[]
}

/** Read a population JSONL file into envelopes + records. */
export async function readPopulation(path: string): Promise<PopulationReadResult> {
  const raw = await readFile(path, "utf-8")
  const envelopes: PopulationEnvelope[] = []
  const records: PopulationRecord[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    const env = parsePopulationLine(t)
    envelopes.push(env)
    records.push(env.record as unknown as PopulationRecord)
  }
  return { envelopes, records }
}

/** Verify the population hash chain — delegates to the research `verifyChain`
 *  (we do NOT reimplement it). The public envelope exposes its canonical record
 *  under `record`; verifyChain expects the inner object under `atom` and our
 *  stored entry_hash was computed with that same `atom` preimage (see
 *  `entryHash`). So we re-key `record`→`atom` and hand the adapted envelope to
 *  verifyChain — its recompute matches bit-for-bit, giving full
 *  tamper/reorder/genesis detection for free. */
export function verifyPopulationChain(envelopes: PopulationEnvelope[]) {
  const adapted: ResearchAtomEnvelope[] = envelopes.map((e) => ({
    schema_version: e.schema_version,
    prev_hash: e.prev_hash,
    atom: e.record,
    entry_hash: e.entry_hash,
  }))
  return verifyChain(adapted)
}
