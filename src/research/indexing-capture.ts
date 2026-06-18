// src/research/indexing-capture.ts — the rlaihf CAPTURE seam for the indexing
// TCO experiment (epic bd-idx-tco-exp-s7r5).
//
// Two modes:
//   pnpm indexing:seed                  regenerate the ledger from indexing-seed.ts
//                                        (deterministic — hash-stable across runs)
//   tsx indexing-capture.ts add --row '<json>'
//                                        append ONE measured/quoted row (the seam
//                                        a stand-up script calls to upgrade a
//                                        vendor-quote to a measured row)
//
// The `add` JSON accepts `cost_usd_month` (a float) for ergonomics and converts
// it to integer micro-USD at the boundary (the ONLY float→int crossing allowed).

import { rm } from "node:fs/promises"
import { IndexingRowWriter, INDEXING_LEDGER_PATH, readIndexingLedger, verifyIndexingChain } from "./indexing-ledger.js"
import { seedRows } from "./indexing-seed.js"
import { usdToMicro, type IndexingExperimentRow } from "./schemas/indexing-experiment-row.js"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function regenerateFromSeed(path: string): Promise<void> {
  await rm(path, { force: true })
  await rm(`${path}.lock`, { force: true })
  const writer = new IndexingRowWriter(path)
  const rows = seedRows()
  for (const row of rows) {
    await writer.append(row)
  }
  const { envelopes } = await readIndexingLedger(path)
  const v = verifyIndexingChain(envelopes)
  if (!v.valid) throw new Error(`seed produced an invalid chain: ${v.reason}`)
  console.log(`seeded ${rows.length} rows → ${path} (chain valid, head replays from genesis)`)
}

/** Parse a row from JSON. Accepts cost_usd_month (float) OR cost_usd_month_micro
 *  (decimal string / number). All other fields pass through. */
function rowFromJson(json: string): IndexingExperimentRow {
  const o = JSON.parse(json) as Record<string, unknown>
  let micro: bigint
  if (typeof o.cost_usd_month_micro === "string") micro = BigInt(o.cost_usd_month_micro)
  else if (typeof o.cost_usd_month === "number") micro = usdToMicro(o.cost_usd_month)
  else throw new Error("row JSON needs cost_usd_month (number) or cost_usd_month_micro (string)")
  delete o.cost_usd_month
  return { ...(o as unknown as IndexingExperimentRow), cost_usd_month_micro: micro }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  const path = arg("path") ?? INDEXING_LEDGER_PATH
  if (cmd === "seed") {
    await regenerateFromSeed(path)
    return
  }
  if (cmd === "add") {
    const json = arg("row")
    if (!json) throw new Error("usage: indexing-capture add --row '<json>'")
    const env = await new IndexingRowWriter(path).append(rowFromJson(json))
    console.log(`appended ${env.entry_hash.slice(0, 12)}… (${(env.row as { config?: string }).config}/${(env.row as { scenario?: string }).scenario})`)
    return
  }
  console.error("usage: indexing-capture <seed|add> [--row '<json>'] [--path <ledger>]")
  process.exit(1)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
