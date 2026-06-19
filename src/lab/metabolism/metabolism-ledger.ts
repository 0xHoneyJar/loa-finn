// src/lab/metabolism/metabolism-ledger.ts — the Custodian.
//
// An append-only, hash-chained ledger of every MATCH/ITERATION receipt the Hand
// produces. It is the custody trail for the metabolism: each evaluated (a vs b)
// pair becomes one chained custody stamp. It MIRRORS the ResearchAtomWriter idiom
// EXACTLY (src/research/cost-atom-research.ts:115-172) — promise-chained appends
// (order is the chain), lazy `ensureHead()` head-recovery from the file tail, and
// `appendFile(..., {flush:true})` — and REUSES `canonicalize`/`canonicalJson`/
// `verifyChain`/`GENESIS_HASH` rather than reinventing them.
//
// ANTI-FOX: the Custodian RECORDS + VERIFIES. It does not measure (the Hand does)
// and it does not decide convergence (segment B/C's solver does). A custody stamp
// here is a fact about a measurement that already happened — never a verdict.

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
import { assertIntegerDomain, type MatchReceipt } from "./types.js"

/** Default RUNTIME ledger output path — exported const, matching the
 *  spine-ledger.ts:39 / indexing-ledger.ts:29 convention. Lives in the STATE zone
 *  (grimoires/loa/lab/metabolism/), NOT the App zone — generated custody state is
 *  session-spanning State, alongside grimoires/loa/lab/cabt-calibration.jsonl
 *  (Segment B's deferred MINOR, resolved in Segment C). Overridable via the
 *  writer's constructor arg. */
export const METABOLISM_LEDGER_PATH = "grimoires/loa/lab/metabolism/metabolism.jsonl"

/** sha256 hex — identical to the PRIVATE `sha256Hex` at cost-atom-research.ts:64.
 *  Recomputed here (the spec sanctions this) so this module stays a pure CONSUMER
 *  of `src/research`. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/** entry_hash = sha256 of canonical JSON of { schema_version, prev_hash, atom }.
 *  IDENTICAL formula AND key to cost-atom-research.ts:74-79 — the preimage keys the
 *  canonical record under `atom`. This is what lets `verifyMetabolismChain`
 *  delegate to the research `verifyChain` (which recomputes the same `atom`
 *  preimage) and match bit-for-bit. The public envelope exposes the record under
 *  the friendlier `receipt` key; only the hash PREIMAGE uses `atom`. */
function entryHash(schemaVersion: 1, prevHash: string, record: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ schema_version: schemaVersion, prev_hash: prevHash, atom: record }))
}

/** The metabolism envelope — same SHAPE + formula as ResearchAtomEnvelope, with
 *  the canonicalized receipt under `receipt` instead of `atom`. */
export interface MetabolismEnvelope {
  schema_version: 1
  prev_hash: string
  receipt: Record<string, unknown>
  entry_hash: string
}

/** The Custodian. Append-only, hash-chained, promise-serialized writer mirroring
 *  ResearchAtomWriter (cost-atom-research.ts:115-172). No update/rewrite path. */
export class MetabolismLedgerWriter {
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
      const last = JSON.parse(lines[lines.length - 1]) as MetabolismEnvelope
      this.head = last.entry_hash
    } catch {
      this.head = GENESIS_HASH
    }
  }

  /** Serialize + chain + append one match receipt. Rejects on float
   *  contamination (assertIntegerDomain) or any fs failure — the head is NOT
   *  advanced on failure, so the chain stays intact and the next append retries
   *  from the same link. Resolves with the written envelope. */
  append(receipt: MatchReceipt): Promise<MetabolismEnvelope> {
    try {
      // Write-time no-float gate: every numeric field must be an integer (this is
      // where a float winrate or a fractional n_matches is rejected, not at read).
      assertIntegerDomain(receipt)
      // Domain guard: winrate_ppm must live in [0, 1_000_000]. An out-of-range
      // integer is still integer-domain-valid but is not a valid win-rate, and a
      // downstream verifier would silently trust it — catch it at the seam.
      if (receipt.winrate_ppm < 0 || receipt.winrate_ppm > 1_000_000) {
        throw new Error(
          `metabolism-ledger: winrate_ppm ${receipt.winrate_ppm} out of [0, 1_000_000]`,
        )
      }
      if (receipt.n_matches < 0) {
        throw new Error(`metabolism-ledger: n_matches ${receipt.n_matches} must be non-negative`)
      }
    } catch (err) {
      return Promise.reject(err)
    }
    const run = this.chain.then(async () => {
      await this.ensureHead()
      const prevHash = this.head as string
      const canonReceipt = canonicalize(receipt) as Record<string, unknown>
      const eh = entryHash(1, prevHash, canonReceipt)
      const envelope: MetabolismEnvelope = {
        schema_version: 1,
        prev_hash: prevHash,
        receipt: canonReceipt,
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
export function parseMetabolismLine(line: string): MetabolismEnvelope {
  const env = JSON.parse(line) as MetabolismEnvelope
  if (env.schema_version !== 1) {
    throw new Error(`unknown metabolism schema_version: ${env.schema_version}`)
  }
  return env
}

export interface MetabolismReadResult {
  envelopes: MetabolismEnvelope[]
  receipts: MatchReceipt[]
}

/** Read a metabolism JSONL file into envelopes + receipts. */
export async function readMetabolism(path: string): Promise<MetabolismReadResult> {
  const raw = await readFile(path, "utf-8")
  const envelopes: MetabolismEnvelope[] = []
  const receipts: MatchReceipt[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    const env = parseMetabolismLine(t)
    envelopes.push(env)
    receipts.push(env.receipt as unknown as MatchReceipt)
  }
  return { envelopes, receipts }
}

/** Verify the metabolism hash chain — delegates to the research `verifyChain` (we
 *  do NOT reimplement it). Our stored entry_hash uses the `atom` preimage key (see
 *  `entryHash`), so we re-key `receipt`→`atom` and hand the adapted envelope to
 *  verifyChain — its recompute matches bit-for-bit, giving full
 *  tamper/reorder/genesis detection for free. */
export function verifyMetabolismChain(envelopes: MetabolismEnvelope[]) {
  const adapted: ResearchAtomEnvelope[] = envelopes.map((e) => ({
    schema_version: e.schema_version,
    prev_hash: e.prev_hash,
    atom: e.receipt,
    entry_hash: e.entry_hash,
  }))
  return verifyChain(adapted)
}
