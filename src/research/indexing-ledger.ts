// src/research/indexing-ledger.ts — append-only, hash-chained writer + reader
// for the indexing TCO experiment (epic bd-idx-tco-exp-s7r5).
//
// Mirrors the proven `ResearchAtomWriter` idiom (cost-atom-research.ts):
//   · append-only JSONL, one envelope per line, NO update/rewrite path
//   · promise-chained appends so concurrent writes never interleave a partial
//     line OR fork the hash chain (order IS the chain)
//   · the head is recovered lazily from the file tail, so re-opening an existing
//     ledger CONTINUES its chain rather than re-genesis-ing it
//   · float money is rejected at append (assertRowIntegerMicro), not at read
//
// This is the experiment's deterministic, git-tracked artifact: anyone can
// re-read it, replay the chain, and reproduce the crossover. "Reproducible: the
// ledger + the stand-up scripts are committed" (the spec's measurement-integrity
// rule) is satisfied structurally — a tampered/reordered row breaks verifyChain.

import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { canonicalize, canonicalJson } from "./cost-atom-research.js"
import { GENESIS_HASH } from "./schemas/index.js"
import {
  assertRowValid,
  type IndexingExperimentRow,
  type IndexingRowEnvelope,
} from "./schemas/indexing-experiment-row.js"

/** Default ledger path (git-tracked — the experiment artifact). */
export const INDEXING_LEDGER_PATH = "src/research/indexing-experiment-ledger.jsonl"

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/** entry_hash = sha256 of canonical { schema_version, prev_hash, row }. The
 *  `row` is already canonicalized (bigints as decimal strings); canonicalJson is
 *  idempotent so this is stable. Identical formula to the research-atom ledger. */
export function indexingEntryHash(
  schemaVersion: 1,
  prevHash: string,
  row: Record<string, unknown>,
): string {
  return sha256Hex(canonicalJson({ schema_version: schemaVersion, prev_hash: prevHash, row }))
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Append-only JSONL writer that maintains the prev_hash chain head. No
 *  update/rewrite path exists. Appends serialize through a promise chain. */
export class IndexingRowWriter {
  private chain: Promise<void> = Promise.resolve()
  private head: string | null = null

  constructor(readonly path: string = INDEXING_LEDGER_PATH) {}

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
      const last = JSON.parse(lines[lines.length - 1]) as IndexingRowEnvelope
      this.head = last.entry_hash
    } catch {
      this.head = GENESIS_HASH
    }
  }

  /** Validate + chain + append one row. Resolves with the written envelope.
   *  Rejects on an invalid row (typo'd enum, float money, negative int) or any
   *  fs failure — the head is NOT advanced on failure, so the chain stays intact
   *  and the next append retries from the same link. */
  append(row: IndexingExperimentRow): Promise<IndexingRowEnvelope> {
    try {
      assertRowValid(row)
    } catch (err) {
      return Promise.reject(err)
    }
    const run = this.chain.then(async () => {
      await this.ensureHead()
      const prevHash = this.head as string
      const canonRow = canonicalize(row) as Record<string, unknown>
      const eh = indexingEntryHash(1, prevHash, canonRow)
      const envelope: IndexingRowEnvelope = {
        schema_version: 1,
        prev_hash: prevHash,
        row: canonRow,
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
// Reader + replay verification
// ---------------------------------------------------------------------------

export function parseIndexingEnvelopeLine(line: string): IndexingRowEnvelope {
  const env = JSON.parse(line) as IndexingRowEnvelope
  if (env.schema_version !== 1) {
    throw new Error(`indexing-ledger: unexpected schema_version ${String(env.schema_version)}`)
  }
  if (typeof env.prev_hash !== "string" || typeof env.entry_hash !== "string") {
    throw new Error("indexing-ledger: envelope missing prev_hash/entry_hash")
  }
  return env
}

export interface IndexingReadResult {
  envelopes: IndexingRowEnvelope[]
  /** A torn final line was skipped (crash mid-append) — informational. */
  corrupt_tail: boolean
}

/** Read the ledger into envelopes. A torn FINAL line is quarantined (skipped); a
 *  corrupt line that is NOT the tail throws (real corruption). */
export async function readIndexingLedger(path: string = INDEXING_LEDGER_PATH): Promise<IndexingReadResult> {
  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch {
    return { envelopes: [], corrupt_tail: false }
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
  const envelopes: IndexingRowEnvelope[] = []
  let corruptTail = false
  for (let i = 0; i < lines.length; i++) {
    try {
      envelopes.push(parseIndexingEnvelopeLine(lines[i]))
    } catch (err) {
      if (i === lines.length - 1) {
        corruptTail = true
        break
      }
      throw new Error(`indexing-ledger: corrupt envelope at line ${i} (not the tail): ${String(err)}`)
    }
  }
  return { envelopes, corrupt_tail: corruptTail }
}

export interface IndexingChainVerification {
  valid: boolean
  length: number
  /** Index of the first broken link, or null if the chain replays cleanly. */
  brokenAt: number | null
  reason: string | null
}

/** Replay from genesis: every envelope's prev_hash must equal the prior
 *  envelope's entry_hash (GENESIS for the first), AND each entry_hash must
 *  recompute from its stored { schema_version, prev_hash, row }. A lost,
 *  duplicated, reordered, or tampered row breaks the replay. */
export function verifyIndexingChain(envelopes: IndexingRowEnvelope[]): IndexingChainVerification {
  let prev = GENESIS_HASH
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]
    if (env.prev_hash !== prev) {
      return { valid: false, length: envelopes.length, brokenAt: i, reason: `prev_hash break at index ${i}` }
    }
    const recomputed = indexingEntryHash(1, env.prev_hash, env.row)
    if (recomputed !== env.entry_hash) {
      return { valid: false, length: envelopes.length, brokenAt: i, reason: `entry_hash mismatch at index ${i} (row tampered)` }
    }
    prev = env.entry_hash
  }
  return { valid: true, length: envelopes.length, brokenAt: null, reason: null }
}

/** Decode a canonicalized envelope row back into a typed IndexingExperimentRow
 *  (bigint money is restored from its decimal string). Used by the crossover
 *  reader. Throws if the stored money string is not a clean integer. */
export function rowFromEnvelope(env: IndexingRowEnvelope): IndexingExperimentRow {
  const r = env.row
  const micros = r.cost_usd_month_micro
  if (typeof micros !== "string" || !/^\d+$/.test(micros)) {
    throw new Error(`indexing-ledger: cost_usd_month_micro not a clean integer string: ${String(micros)}`)
  }
  return { ...(r as unknown as IndexingExperimentRow), cost_usd_month_micro: BigInt(micros) }
}
