// src/lab/metabolism/metabolism-ledger.test.ts — the Custodian's contract.
//
// The metabolism ledger is the custody trail for every match measurement. A float
// win-rate, a tampered receipt, or a reordered line corrupts the loop's evidence.
// These tests bind it: chain continuity, tamper at the right index, torn-tail
// recovery, and write-time no-float rejection.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  MetabolismLedgerWriter,
  METABOLISM_LEDGER_PATH,
  readMetabolism,
  verifyMetabolismChain,
  type MetabolismEnvelope,
} from "./metabolism-ledger.js"
import { GENESIS_HASH } from "../../research/schemas/index.js"
import type { MatchReceipt } from "./types.js"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "metabolism-ledger-test-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function receipt(overrides: Partial<MatchReceipt> = {}): MatchReceipt {
  return {
    winrate_ppm: 500_000,
    n_matches: 30,
    hand_kind: "toy",
    strategy_a: "aaaa",
    strategy_b: "bbbb",
    ts: 1_700_000_000_000,
    ...overrides,
  }
}

describe("MetabolismLedgerWriter — the Custodian", () => {
  it("exports a default path in the State zone (grimoires/loa/lab/metabolism)", () => {
    expect(METABOLISM_LEDGER_PATH).toBe("grimoires/loa/lab/metabolism/metabolism.jsonl")
  })

  it("chains from genesis and verifies clean", async () => {
    const path = join(dir, "meta.jsonl")
    const w = new MetabolismLedgerWriter(path)
    const e0 = await w.append(receipt({ winrate_ppm: 600_000 }))
    const e1 = await w.append(receipt({ winrate_ppm: 400_000 }))
    const e2 = await w.append(receipt({ winrate_ppm: 0 }))

    expect(e0.prev_hash).toBe(GENESIS_HASH)
    expect(e1.prev_hash).toBe(e0.entry_hash)
    expect(e2.prev_hash).toBe(e1.entry_hash)

    const { envelopes, receipts } = await readMetabolism(path)
    expect(receipts.map((r) => r.winrate_ppm)).toEqual([600_000, 400_000, 0])
    const v = verifyMetabolismChain(envelopes)
    expect(v.valid).toBe(true)
    expect(v.length).toBe(3)
  })

  it("re-opening continues the chain (lazy head recovery)", async () => {
    const path = join(dir, "meta.jsonl")
    const a = await new MetabolismLedgerWriter(path).append(receipt())
    const b = await new MetabolismLedgerWriter(path).append(receipt({ winrate_ppm: 123_456 }))
    expect(b.prev_hash).toBe(a.entry_hash)
    const { envelopes } = await readMetabolism(path)
    expect(verifyMetabolismChain(envelopes).valid).toBe(true)
  })

  it("tamper detection: mutating a receipt breaks verify at the right index", async () => {
    const path = join(dir, "meta.jsonl")
    const w = new MetabolismLedgerWriter(path)
    await w.append(receipt({ winrate_ppm: 100_000 }))
    await w.append(receipt({ winrate_ppm: 200_000 }))
    await w.append(receipt({ winrate_ppm: 300_000 }))

    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean)
    const tampered = JSON.parse(lines[2]) as MetabolismEnvelope
    ;(tampered.receipt as Record<string, unknown>).winrate_ppm = 999_999
    lines[2] = JSON.stringify(tampered)
    writeFileSync(path, lines.join("\n") + "\n")

    const { envelopes } = await readMetabolism(path)
    const v = verifyMetabolismChain(envelopes)
    expect(v.valid).toBe(false)
    expect(v.brokenAt).toBe(2)
  })

  it("torn-tail recovery: a truncated final line leaves the prefix verifiable", async () => {
    const path = join(dir, "meta.jsonl")
    const w = new MetabolismLedgerWriter(path)
    const a = await w.append(receipt({ winrate_ppm: 100_000 }))
    const b = await w.append(receipt({ winrate_ppm: 200_000 }))
    appendFileSync(path, '{"schema_version":1,"prev_hash":"' + b.entry_hash + '","rec')

    const completeLines = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => {
        const t = l.trim()
        if (!t) return false
        try {
          JSON.parse(t)
          return true
        } catch {
          return false
        }
      })
    expect(completeLines).toHaveLength(2)
    const intact = completeLines.map((l) => JSON.parse(l) as MetabolismEnvelope)
    expect(verifyMetabolismChain(intact).valid).toBe(true)
    expect(intact[0].prev_hash).toBe(GENESIS_HASH)
    expect(intact[1].prev_hash).toBe(a.entry_hash)
  })

  it("write-time no-float rejection: a float winrate_ppm is rejected before serialize", async () => {
    const path = join(dir, "meta.jsonl")
    const w = new MetabolismLedgerWriter(path)
    await expect(w.append(receipt({ winrate_ppm: 500_000.5 }))).rejects.toThrow(/integer-domain/)
  })

  it("write-time domain guard: winrate_ppm outside [0, 1_000_000] is rejected", async () => {
    const path = join(dir, "meta.jsonl")
    const w = new MetabolismLedgerWriter(path)
    await expect(w.append(receipt({ winrate_ppm: 1_000_001 }))).rejects.toThrow(/out of \[0, 1_000_000\]/)
    await expect(w.append(receipt({ winrate_ppm: -1 }))).rejects.toThrow(/out of \[0, 1_000_000\]/)
  })

  it("grep-clean: no float is ever serialized into a .jsonl line", async () => {
    const path = join(dir, "meta.jsonl")
    const w = new MetabolismLedgerWriter(path)
    await w.append(receipt({ winrate_ppm: 333_333, n_matches: 30, ts: 1_700_000_000_000 }))
    await w.append(receipt({ winrate_ppm: 666_667, n_matches: 30, ts: 1_700_000_000_001 }))
    const raw = readFileSync(path, "utf-8")
    expect(raw).not.toMatch(/:\s*-?\d+\.\d/)
    expect(raw).not.toMatch(/,\s*-?\d+\.\d/)
  })
})
