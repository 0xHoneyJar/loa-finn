// src/research/indexing-ledger.test.ts — indexing-experiment ledger invariants
// (epic bd-idx-tco-exp-s7r5).
//
// The stakes are MEASUREMENT INTEGRITY: a float in a stored cost, a tampered
// row, or a reordered line each corrupt the experiment that settles the
// contested $133/$84/$70 figures. These tests are the contract.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  IndexingRowWriter,
  readIndexingLedger,
  rowFromEnvelope,
  verifyIndexingChain,
} from "./indexing-ledger.js"
import { GENESIS_HASH } from "./schemas/index.js"
import type { IndexingExperimentRow } from "./schemas/indexing-experiment-row.js"
import { usdToMicro } from "./schemas/indexing-experiment-row.js"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "indexing-ledger-test-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function row(overrides: Partial<IndexingExperimentRow> = {}): IndexingExperimentRow {
  return {
    row_id: "01J0000000000000000000000A",
    run_id: "test-run",
    date: "2026-06-16",
    scenario: "1x",
    layer: "L1-curated",
    config: "ponder-railway",
    chain: 80094,
    collection_count: 93,
    event_count: 3_540_000,
    cost_usd_month_micro: usdToMicro(58),
    cost_source: "measured",
    toil_minutes_setup: 480,
    toil_incidents_30d: 3,
    toil_minutes_per_incident: 60,
    latency_p50_ms: 120,
    freshness_lag_s: 12,
    sovereignty: 1,
    scale_ceiling: "Postgres RAM at ~3x events",
    cost_basis: "freeside-sonar Railway invoice 2026-06-15, productive decomposition",
    retrieved_ts: null,
    notes: "lived baseline",
    ...overrides,
  }
}

// --- Required test 1 — hash-chain continuity --------------------------------
describe("hash-chain continuity", () => {
  it("appends a genesis-rooted chain and verifies from scratch", async () => {
    const path = join(dir, "chain.jsonl")
    const writer = new IndexingRowWriter(path)
    const first = await writer.append(row({ row_id: "a" }))
    const second = await writer.append(row({ row_id: "b", config: "envio-hyperindex", cost_source: "vendor-quote" }))

    expect(first.prev_hash).toBe(GENESIS_HASH)
    expect(second.prev_hash).toBe(first.entry_hash)

    const { envelopes, corrupt_tail } = await readIndexingLedger(path)
    expect(corrupt_tail).toBe(false)
    const v = verifyIndexingChain(envelopes)
    expect(v.valid).toBe(true)
    expect(v.length).toBe(2)
  })

  it("continues an existing chain on re-open (no re-genesis)", async () => {
    const path = join(dir, "chain.jsonl")
    const head = await new IndexingRowWriter(path).append(row({ row_id: "a" }))
    const next = await new IndexingRowWriter(path).append(row({ row_id: "b" }))
    expect(next.prev_hash).toBe(head.entry_hash)
    const { envelopes } = await readIndexingLedger(path)
    expect(verifyIndexingChain(envelopes).valid).toBe(true)
  })

  it("detects a TAMPERED row (entry_hash mismatch)", async () => {
    const path = join(dir, "chain.jsonl")
    const w = new IndexingRowWriter(path)
    await w.append(row({ row_id: "a" }))
    await w.append(row({ row_id: "b" }))
    // Mutate the stored cost of line 1 WITHOUT recomputing entry_hash.
    const lines = readFileSync(path, "utf-8").trim().split("\n")
    const env = JSON.parse(lines[0])
    env.row.cost_usd_month_micro = "999000000"
    lines[0] = JSON.stringify(env)
    writeFileSync(path, lines.join("\n") + "\n")

    const { envelopes } = await readIndexingLedger(path)
    const v = verifyIndexingChain(envelopes)
    expect(v.valid).toBe(false)
    expect(v.brokenAt).toBe(0)
    expect(v.reason).toMatch(/tampered|entry_hash/)
  })

  it("detects a REORDERED chain", async () => {
    const path = join(dir, "chain.jsonl")
    const w = new IndexingRowWriter(path)
    await w.append(row({ row_id: "a" }))
    await w.append(row({ row_id: "b" }))
    const lines = readFileSync(path, "utf-8").trim().split("\n")
    writeFileSync(path, [lines[1], lines[0]].join("\n") + "\n")
    const { envelopes } = await readIndexingLedger(path)
    expect(verifyIndexingChain(envelopes).valid).toBe(false)
  })
})

// --- Required test 2 — integer-micro money (no floats) ----------------------
describe("integer-micro money discipline", () => {
  it("rejects a float cost at append (not at read)", async () => {
    const w = new IndexingRowWriter(join(dir, "chain.jsonl"))
    const bad = row({ cost_usd_month_micro: 133.21 as unknown as bigint })
    await expect(w.append(bad)).rejects.toThrow(/integer-micro/)
  })

  it("rejects negative money", async () => {
    const w = new IndexingRowWriter(join(dir, "chain.jsonl"))
    await expect(w.append(row({ cost_usd_month_micro: -1n }))).rejects.toThrow(/integer-micro/)
  })

  it("round-trips bigint money through the envelope (stored as decimal string)", async () => {
    const path = join(dir, "chain.jsonl")
    await new IndexingRowWriter(path).append(row({ cost_usd_month_micro: 133_210_000n }))
    const { envelopes } = await readIndexingLedger(path)
    expect(typeof envelopes[0].row.cost_usd_month_micro).toBe("string")
    const decoded = rowFromEnvelope(envelopes[0])
    expect(decoded.cost_usd_month_micro).toBe(133_210_000n)
  })
})

// --- Required test 3 — schema validation ------------------------------------
describe("schema validation at write time", () => {
  it("rejects an unknown config", async () => {
    const w = new IndexingRowWriter(join(dir, "chain.jsonl"))
    await expect(
      w.append(row({ config: "subgraph" as unknown as IndexingExperimentRow["config"] })),
    ).rejects.toThrow(/unknown config/)
  })
  it("rejects an unknown cost_source", async () => {
    const w = new IndexingRowWriter(join(dir, "chain.jsonl"))
    await expect(
      w.append(row({ cost_source: "guess" as unknown as IndexingExperimentRow["cost_source"] })),
    ).rejects.toThrow(/unknown cost_source/)
  })
  it("rejects a fractional toil minute", async () => {
    const w = new IndexingRowWriter(join(dir, "chain.jsonl"))
    await expect(w.append(row({ toil_minutes_setup: 12.5 }))).rejects.toThrow(/non-negative integer/)
  })
})

// --- Required test 4 — corrupt-tail tolerance -------------------------------
describe("corrupt-tail quarantine", () => {
  it("tolerates a torn FINAL line but reads the rest", async () => {
    const path = join(dir, "chain.jsonl")
    const w = new IndexingRowWriter(path)
    await w.append(row({ row_id: "a" }))
    await w.append(row({ row_id: "b" }))
    // Simulate a crash mid-write: append a partial (unparseable) line.
    writeFileSync(path, readFileSync(path, "utf-8") + '{"schema_version":1,"prev_h', { flag: "w" })
    const { envelopes, corrupt_tail } = await readIndexingLedger(path)
    expect(corrupt_tail).toBe(true)
    expect(envelopes.length).toBe(2)
    expect(verifyIndexingChain(envelopes).valid).toBe(true)
  })

  it("THROWS on a corrupt non-tail line (real corruption)", async () => {
    const path = join(dir, "chain.jsonl")
    const w = new IndexingRowWriter(path)
    await w.append(row({ row_id: "a" }))
    await w.append(row({ row_id: "b" }))
    const lines = readFileSync(path, "utf-8").trim().split("\n")
    writeFileSync(path, ["{garbage", lines[1]].join("\n") + "\n")
    await expect(readIndexingLedger(path)).rejects.toThrow(/corrupt envelope/)
  })
})
