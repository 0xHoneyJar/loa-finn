// src/research/indexing-read.ts — the rlaihf READER CLI for the indexing TCO
// experiment (epic bd-idx-tco-exp-s7r5, synthesis task .4).
//
//   pnpm indexing:read                 print the crossover verdict
//   tsx indexing-read.ts --rate 300    re-price toil at $300/hr (sensitivity)
//   tsx indexing-read.ts --json        emit the machine-readable verdict
//
// It verifies the hash chain FIRST (a tampered/reordered ledger is refused), then
// synthesizes the crossover. The verdict's overall_trust is the WEAKEST
// cost_source it rests on — the Ken-Thompson invariant, surfaced at the top.

import { INDEXING_LEDGER_PATH, readIndexingLedger, rowFromEnvelope, verifyIndexingChain } from "./indexing-ledger.js"
import {
  DEFAULT_CROSSOVER_PARAMS,
  synthesizeCrossover,
  type CrossoverParams,
} from "./indexing-crossover.js"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const path = arg("path") ?? INDEXING_LEDGER_PATH
  const params: CrossoverParams = {
    operator_rate_usd_hr: arg("rate") ? Number(arg("rate")) : DEFAULT_CROSSOVER_PARAMS.operator_rate_usd_hr,
    amortize_months: arg("amortize") ? Number(arg("amortize")) : DEFAULT_CROSSOVER_PARAMS.amortize_months,
  }

  const { envelopes, corrupt_tail } = await readIndexingLedger(path)
  const chain = verifyIndexingChain(envelopes)
  if (!chain.valid) {
    console.error(`REFUSED: ledger chain is broken at index ${chain.brokenAt} (${chain.reason}). The ledger has been tampered/reordered — re-seed or investigate.`)
    process.exit(2)
  }
  const rows = envelopes.map(rowFromEnvelope)
  const verdict = synthesizeCrossover(rows, params)

  if (process.argv.includes("--json")) {
    // bigint-safe stringify (none expected post-decode, but be safe).
    console.log(JSON.stringify(verdict, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2))
    return
  }

  const L = (s = "") => console.log(s)
  L("══════════════════════════════════════════════════════════════════════")
  L(`  INDEXING TCO CROSSOVER — ${verdict.run_id ?? "(mixed runs)"}  ·  ${rows.length} rows`)
  L(`  chain: VALID (${chain.length} envelopes replay from genesis)${corrupt_tail ? " · torn tail quarantined" : ""}`)
  L("══════════════════════════════════════════════════════════════════════")
  L()
  L(`  OVERALL TRUST: ${verdict.overall_trust.toUpperCase()}`)
  L(`  → ${verdict.overall_trust_caveat}`)
  L(`  ${verdict.toil_rate_caveat}`)
  L()

  if (verdict.l1) {
    L("  ── LAYER 1 (registration: ponder vs managed) ───────────────────────")
    if (verdict.l1.footprints.length === 0) {
      L("    no head-to-head footprint yet (need ≥2 configs at the same scenario).")
    }
    for (const f of verdict.l1.footprints) {
      L(`    [${f.scenario}] ${f.collection_count} collections · trust=${f.trust}`)
      for (const r of f.rows) {
        const sov = r.sovereignty ? "self-host" : "managed  "
        L(`      ${r.config.padEnd(20)} ${sov}  $${r.pure_usd_month.toFixed(2).padStart(8)}/mo pure  +$${r.toil_usd_month.toFixed(2).padStart(8)} toil  = $${r.tco_incl_toil_usd.toFixed(2).padStart(9)} TCO  [${r.cost_source}]`)
      }
      L(`      → pure-$ winner: ${f.pure_cost_winner.config} ($${f.pure_cost_winner.usd}) · TCO-incl-toil winner: ${f.tco_incl_toil_winner.config} ($${f.tco_incl_toil_winner.usd})${f.toil_flips_winner ? "  ⚑ TOIL FLIPS THE WINNER" : ""}`)
      if (f.breakeven_toil_rate_usd_hr !== null) {
        L(`        breakeven: above $${f.breakeven_toil_rate_usd_hr}/hr operator-attention, managed wins on TCO (assumption-free crossover)`)
      } else {
        L(`        ${f.pure_cost_winner.config} is also the least-toily — it dominates at EVERY toil rate`)
      }
    }
    if (verdict.l1.reference_rows.length > 0) {
      L("    reference (not head-to-head):")
      for (const r of verdict.l1.reference_rows) {
        L(`      ${r.config.padEnd(20)} [${r.scenario}]  $${r.pure_usd_month.toFixed(2)}/mo pure  = $${r.tco_incl_toil_usd.toFixed(2)} TCO  [${r.cost_source}]`)
      }
    }
    L()
  }

  if (verdict.l2) {
    L("  ── LAYER 2 (firehose scale-wall: hypersync → warehouse) ─────────────")
    for (const p of verdict.l2.curve) {
      L(`      ${p.store.padEnd(11)} ${String(p.collection_count).padStart(8)} cols  $${p.usd_month.toFixed(2).padStart(9)}/mo  ${p.latency_p50_ms === null ? "lat=n/a" : `lat=${p.latency_p50_ms}ms`}  [${p.cost_source}]`)
    }
    L(`      → ${verdict.l2.storage_delta_note}`)
    L(`      → ${verdict.l2.bend_note}`)
    L()
  }

  L("  ── RATIFICATION ────────────────────────────────────────────────────")
  L(`    ${verdict.ratification}`)
  L("══════════════════════════════════════════════════════════════════════")
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
