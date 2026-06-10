// scripts/playtest/cop-readout.ts — H1/H2/H3 readout vs pre-registered bars
// (cycle-041 S5 / sprint-169, T5.7 — Finn cost-of-play V1)
//
// Reads cost-atoms JSONL (+ driver JSONL for load-level labels, + optional
// Railway usage CSV) and emits the readout with the THREE-VERDICT discipline:
// HELD / FALSIFIED / INSUFFICIENT — judged ONLY against the sha-pinned bars
// in cop-bars.json (flatline B6/HC5: bars are config, never edited mid-run).
//
// Float policy: transient float math here is permitted — the readout is
// ANALYSIS, not ledger (enhance doc Quality Rules). Stored fields remain
// integer micro-USD strings.
//
// Usage:
//   pnpm tsx scripts/playtest/cop-readout.ts --atoms PATH [--driver PATH ...]
//     [--railway-usage-micro N] [--bars scripts/playtest/cop-bars.json]

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

type Verdict = "HELD" | "FALSIFIED" | "INSUFFICIENT"

interface Bars {
  h1_held_max: number
  h1_falsified_min: number
  h2_flat_threshold: number
  h2_crossover_min_r2: number
  malformed_line_max_ratio: number
}

interface AtomView {
  ts: number
  call_class: "A_relay" | "B_enrich"
  inference_micro: bigint
  infra_micro: bigint
  orchestration_micro: bigint
  total_micro: bigint
  cheval_spawn_ms: number | null
  gate_decision: string
  wall_ms: number
}

interface DriverRow {
  ts: number
  phase?: number
  level?: number
  abort?: string
  gate_decision?: string
}

function parseArgs(argv: string[]): {
  atomsPath: string
  driverPaths: string[]
  barsPath: string
  railwayUsageMicro: bigint | null
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const atomsPath = get("--atoms")
  if (!atomsPath) {
    console.error(
      "usage: cop-readout.ts --atoms PATH [--driver PATH ...] [--railway-usage-micro N] [--bars PATH]",
    )
    process.exit(2)
  }
  const driverPaths: string[] = []
  argv.forEach((a, i) => {
    if (a === "--driver" && argv[i + 1]) driverPaths.push(argv[i + 1])
  })
  const usage = get("--railway-usage-micro")
  return {
    atomsPath,
    driverPaths,
    barsPath: get("--bars") ?? "scripts/playtest/cop-bars.json",
    railwayUsageMicro: usage ? BigInt(usage) : null,
  }
}

/** Parse the atoms JSONL with the HC8 malformed-line policy. */
function parseAtoms(raw: string): { atoms: AtomView[]; malformed: Array<{ line: number; reason: string }>; totalLines: number } {
  const atoms: AtomView[] = []
  const malformed: Array<{ line: number; reason: string }> = []
  const lines = raw.split("\n").filter((l) => l.trim().length > 0)
  for (let i = 0; i < lines.length; i++) {
    try {
      const envelope = JSON.parse(lines[i]) as { schema_version: number; atom: Record<string, any>; checksum: string }
      if (envelope.schema_version !== 1) throw new Error(`schema_version ${envelope.schema_version}`)
      const a = envelope.atom
      atoms.push({
        ts: Number(a.ts),
        call_class: a.call_class,
        inference_micro: BigInt(a.inference.cost_micro),
        infra_micro: BigInt(a.infra.cost_micro),
        orchestration_micro: BigInt(a.orchestration.cost_micro),
        total_micro: BigInt(a.total_micro),
        cheval_spawn_ms: a.orchestration.cheval_spawn_ms,
        gate_decision: String(a.orchestration.gate_decision ?? ""),
        wall_ms: Number(a.infra.wall_ms),
      })
    } catch (err) {
      malformed.push({ line: i + 1, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { atoms, malformed, totalLines: lines.length }
}

function share(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null
  return Number(numerator) / Number(denominator)
}

/** Least-squares fit y = a + b·x. Returns slope/intercept/r2 (analysis floats). */
function leastSquares(points: Array<{ x: number; y: number }>): { slope: number; intercept: number; r2: number } | null {
  const n = points.length
  if (n < 2) return null
  const mx = points.reduce((s, p) => s + p.x, 0) / n
  const my = points.reduce((s, p) => s + p.y, 0) / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of points) {
    sxx += (p.x - mx) ** 2
    sxy += (p.x - mx) * (p.y - my)
    syy += (p.y - my) ** 2
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy)
  return { slope, intercept, r2 }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // --- Bars: sha-pinned config (B6/HC5) ---
  const barsRaw = await readFile(args.barsPath, "utf-8")
  const barsSha = createHash("sha256").update(barsRaw).digest("hex")
  const bars = JSON.parse(barsRaw) as Bars

  // --- Atoms ---
  const { atoms: allAtoms, malformed, totalLines } = parseAtoms(await readFile(args.atomsPath, "utf-8"))
  const malformedRatio = totalLines === 0 ? 0 : malformed.length / totalLines
  const malformedForcesInsufficient = malformedRatio > bars.malformed_line_max_ratio

  // --- Driver rows: load-level labels + kill-switch truncation (B5) ---
  const driverRows: DriverRow[] = []
  for (const path of args.driverPaths) {
    const raw = await readFile(path, "utf-8")
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        driverRows.push(JSON.parse(line) as DriverRow)
      } catch {
        // driver-side malformed lines are non-fatal; counted separately below
      }
    }
  }
  const abortRow = driverRows.find((r) => r.abort === "kill_switch")
  const killSwitchFlag = abortRow !== undefined
  const atoms = killSwitchFlag ? allAtoms.filter((a) => a.ts < abortRow!.ts) : allAtoms

  // --- H1: inference share at steady state ---
  const bAtoms = atoms.filter((a) => a.call_class === "B_enrich")
  const sumB = {
    inference: bAtoms.reduce((s, a) => s + a.inference_micro, 0n),
    total: bAtoms.reduce((s, a) => s + a.total_micro, 0n),
  }
  const sumAll = {
    inference: atoms.reduce((s, a) => s + a.inference_micro, 0n),
    total: atoms.reduce((s, a) => s + a.total_micro, 0n),
  }
  const perBShare = share(sumB.inference, sumB.total)
  const blendedShare = share(sumAll.inference, sumAll.total)

  // Regime label: an H1 readout without one is uninterpretable (arch doc §1).
  const aAtoms = atoms.filter((a) => a.call_class === "A_relay")
  const meanInfraMicro = atoms.length ? Number(atoms.reduce((s, a) => s + a.infra_micro, 0n)) / atoms.length : 0
  const meanInferenceMicro = atoms.length ? Number(sumAll.inference) / atoms.length : 0
  const regime =
    atoms.length === 0
      ? "no-data"
      : meanInfraMicro >= meanInferenceMicro
        ? "infra-dominated"
        : "inference-dominated"

  const h1Verdict: Verdict =
    malformedForcesInsufficient || perBShare === null || bAtoms.length < 10
      ? "INSUFFICIENT"
      : perBShare <= bars.h1_held_max
        ? "HELD"
        : perBShare > bars.h1_falsified_min
          ? "FALSIFIED"
          : "INSUFFICIENT"

  // --- H2: unit cost across load levels (driver phase-2 level labels) ---
  const levelWindows = new Map<number, { from: number; to: number }>()
  for (const row of driverRows) {
    if (row.level === undefined || row.ts === undefined) continue
    const w = levelWindows.get(row.level) ?? { from: row.ts, to: row.ts }
    w.from = Math.min(w.from, row.ts)
    w.to = Math.max(w.to, row.ts)
    levelWindows.set(row.level, w)
  }
  const RPM_BY_LEVEL: Record<number, number> = { 1: 1, 2: 10, 3: 60 }
  const levels = [...levelWindows.entries()]
    .map(([level, w]) => {
      // +120s tail: atoms close after the driver records its request start
      const windowAtoms = atoms.filter((a) => a.ts >= w.from && a.ts <= w.to + 120_000)
      const unit =
        windowAtoms.length === 0
          ? null
          : Number(windowAtoms.reduce((s, a) => s + a.total_micro, 0n)) / windowAtoms.length
      return { level, rpm: RPM_BY_LEVEL[level] ?? null, atom_count: windowAtoms.length, unit_cost_micro: unit }
    })
    .sort((a, b) => a.level - b.level)

  const measuredLevels = levels.filter((l) => l.unit_cost_micro !== null && l.rpm !== null)
  let h2Verdict: Verdict = "INSUFFICIENT"
  let amortizationObserved: boolean | null = null
  let crossover: { projected_rpm: number | null; r2: number | null; note: string } = {
    projected_rpm: null,
    r2: null,
    note: "insufficient load levels (H2 needs 3 points)",
  }
  if (!malformedForcesInsufficient && measuredLevels.length >= 3) {
    const low = measuredLevels[0].unit_cost_micro!
    const high = measuredLevels[measuredLevels.length - 1].unit_cost_micro!
    amortizationObserved = (low - high) / low > bars.h2_flat_threshold
    h2Verdict = amortizationObserved ? "HELD" : "FALSIFIED"
    // Crossover: fit per-call INFRA cost vs rpm; project where infra share
    // equals inference share (HC10 — reported ONLY with fit quality).
    const infraPoints = measuredLevels.map((l) => {
      const w = levelWindows.get(l.level)!
      const windowAtoms = atoms.filter((a) => a.ts >= w.from && a.ts <= w.to + 120_000)
      const meanInfra = windowAtoms.length
        ? Number(windowAtoms.reduce((s, a) => s + a.infra_micro, 0n)) / windowAtoms.length
        : 0
      return { x: l.rpm!, y: meanInfra }
    })
    const fit = leastSquares(infraPoints)
    if (fit && fit.r2 >= bars.h2_crossover_min_r2 && fit.slope < 0) {
      const meanInfPerCall = atoms.length ? Number(sumAll.inference) / atoms.length : 0
      const projected = (meanInfPerCall - fit.intercept) / fit.slope
      crossover = {
        projected_rpm: projected > 0 ? Math.round(projected * 100) / 100 : null,
        r2: Math.round(fit.r2 * 1000) / 1000,
        note: projected > 0 ? "linear projection over 3 level means" : "projection negative — regimes do not cross in range",
      }
    } else {
      crossover = {
        projected_rpm: null,
        r2: fit ? Math.round(fit.r2 * 1000) / 1000 : null,
        note: "no reliable crossover (R² below bar or non-decreasing infra curve)",
      }
    }
  }

  // --- H3: cheval seam overhead (first measurement establishes the baseline) ---
  const spawnAtoms = bAtoms.filter((a) => a.cheval_spawn_ms !== null)
  const h3 =
    spawnAtoms.length === 0
      ? { verdict: "INSUFFICIENT" as Verdict, note: "no cheval invocations measured" }
      : (() => {
          const meanSpawnMs =
            spawnAtoms.reduce((s, a) => s + (a.cheval_spawn_ms ?? 0), 0) / spawnAtoms.length
          const sumOrch = spawnAtoms.reduce((s, a) => s + a.orchestration_micro, 0n)
          const sumSpawnShare = share(sumOrch, sumB.total)
          return {
            verdict: "HELD" as Verdict, // no pre-set bar (arch doc): baseline-establishing
            note: "no bar pre-set — first measurement establishes the baseline",
            mean_spawn_ms: Math.round(meanSpawnMs),
            orchestration_share_of_b: sumSpawnShare,
            samples: spawnAtoms.length,
          }
        })()

  // --- Unallocated infra (B8): Railway usage minus Σ allocated — its own line ---
  const allocatedInfra = atoms.reduce((s, a) => s + a.infra_micro, 0n)
  const unallocatedInfra =
    args.railwayUsageMicro !== null ? args.railwayUsageMicro - allocatedInfra : null

  const readout = {
    generated_for: "sprint-169 cost-of-play V1",
    bars_file: args.barsPath,
    bars_sha256: barsSha,
    bars,
    data: {
      atoms_total: allAtoms.length,
      atoms_in_window: atoms.length,
      class_a: aAtoms.length,
      class_b: bAtoms.length,
      malformed_lines: malformed.length,
      malformed_ratio: Math.round(malformedRatio * 10_000) / 10_000,
      malformed_detail: malformed.slice(0, 10),
      kill_switch_abort: killSwitchFlag,
      ...(killSwitchFlag ? { truncated_at_ts: abortRow!.ts } : {}),
    },
    h1_cost_split: {
      claim: "inference is a minor share of per-call cost",
      regime,
      per_class_b_share: perBShare,
      blended_share: blendedShare,
      blended_note: "blended is a function of the designed mix — mix-dependent, not regime-robust",
      verdict: h1Verdict,
      ...(malformedForcesInsufficient ? { forced_by: "malformed-line ratio over bar (HC8)" } : {}),
    },
    h2_scale_behavior: {
      claim: "unit cost falls as volume amortizes infra",
      levels,
      amortization_observed: amortizationObserved,
      crossover,
      verdict: h2Verdict,
    },
    h3_cheval_seam: h3,
    infra_reconciliation: {
      allocated_infra_micro: allocatedInfra.toString(10),
      railway_usage_micro: args.railwayUsageMicro?.toString(10) ?? null,
      unallocated_infra_micro: unallocatedInfra?.toString(10) ?? null,
      note: "unallocated infra is reported, never redistributed into per-call numbers (B8)",
    },
  }

  console.log(JSON.stringify(readout, null, 2))
}

main().catch((err) => {
  console.error("[cop-readout] fatal:", err)
  process.exit(1)
})
