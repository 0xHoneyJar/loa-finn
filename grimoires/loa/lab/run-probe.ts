// grimoires/loa/lab/run-probe.ts — the lab's reproducible PROBE runner.
//
// PROBE-001/002 were fired inline and the exact invocation was lost (no committed
// runner), so the loop's first step was not reproducible. This is the fix: a thin,
// committed CLI over `probe()` that fires a metered, grounded probe through the REAL
// engine onto the LAB ledgers (grimoires/loa/lab/), matching the provenance of the
// existing settles. It runs the engine; it does not reimplement any of it.
//
// Usage (from repo root):
//   npx tsx grimoires/loa/lab/run-probe.ts \
//     --question "…" [--depth 3] [--sensor gemini] [--freshness-days 120] \
//     [--out grimoires/loa/lab/probes/<slug>.json]
//
// State Zone only: writes atoms + spine events under grimoires/loa/lab/, plus an
// optional full-result JSON. Never touches src/ or observatory/spine-data.json.

import { writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { probe, makeGeminiDigSearchSensor, type ProbeResult } from "../../../src/research/probe.js"
import type { ResearchSensor } from "../../../src/research/schemas/index.js"

const LAB_ATOM_LEDGER = "grimoires/loa/lab/research-atoms.jsonl"
const LAB_SPINE_LEDGER = "grimoires/loa/lab/spine-events.jsonl"

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

/** JSON replacer: bigint → string (ProbeResult carries micro-USD as bigint). */
function bigintSafe(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v
}

async function main(): Promise<void> {
  const question = arg("--question")
  if (!question) {
    console.error("run-probe: --question is required")
    process.exit(2)
  }
  const depth = Number(arg("--depth", "3"))
  const sensor = (arg("--sensor", "gemini") as ResearchSensor) ?? "gemini"
  const freshnessDays = arg("--freshness-days")
  const out = arg("--out")

  const freshness_max_age = freshnessDays ? Number(freshnessDays) * 86_400_000 : undefined

  // gemini at a custom dig depth → inject the sensor body (the registered gemini
  // path is depth 2; the contract-address hunt wants a deeper dig). Other sensors
  // resolve through the registry (grok/dune scaffolds raise typed-unavailable).
  const sensorImpl =
    sensor === "gemini" ? makeGeminiDigSearchSensor({ depth }) : undefined

  console.error(`run-probe: sensor=${sensor} depth=${depth} — firing (dig can take 2-3 min)…`)

  const result: ProbeResult = await probe(question, {
    sensor,
    sensorImpl,
    freshness_max_age,
    atom_ledger_path: LAB_ATOM_LEDGER,
    spine_ledger_path: LAB_SPINE_LEDGER,
    onCostSurfaced: (estimate_micro, s) =>
      console.error(`run-probe: cost surfaced BEFORE finding — estimate ${estimate_micro} µ$ (sensor ${s})`),
  })

  // Compact human summary to stderr; machine-readable result to stdout / --out.
  console.error("─".repeat(60))
  console.error(`finding_class : ${result.finding_class}`)
  console.error(`provider      : intended=${result.provider_intended} resolved=${result.provider_resolved}`)
  console.error(`citations     : ${result.citations.length} total · ${result.valid_citations.length} valid`)
  console.error(`grounding     : sufficient=${result.grounding.sufficient}${result.grounding.insufficient_reason ? ` (${result.grounding.insufficient_reason})` : ""}`)
  console.error(`cost_atom     : ${result.cost_atom.atom.atom_id} (${result.cost_micro} µ$)`)
  console.error(`spine_event   : ${result.spine_event ? `landed @ ${result.spine_event.ts}` : "NOT landed (insufficient/routing_fallback)"}`)
  console.error("─".repeat(60))
  if (result.finding) console.error("\nFINDING:\n" + result.finding)

  const json = JSON.stringify(result, bigintSafe, 2)
  if (out) {
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, json)
    console.error(`\nrun-probe: full result → ${out}`)
  } else {
    process.stdout.write(json)
  }
}

main().catch((err) => {
  console.error("run-probe FAILED:", err?.stack ?? err)
  process.exit(1)
})
