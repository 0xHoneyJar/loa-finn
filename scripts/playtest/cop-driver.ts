// scripts/playtest/cop-driver.ts — synthetic load driver for playtest phases 0–3
// (cycle-041 S5 / sprint-169, T5.6 — Finn cost-of-play V1)
//
// Phases (arch doc §3 run plan):
//   0 smoke      — 5 calls (3A/2B): wiring proof
//   1 pilot      — 50 calls @ ~10 rpm (40A/10B): per-class variance
//   2 load curve — 3 levels ≈1/10/60 rpm × 1h each, mix 80A/20B (--level 1|2|3)
//   3 cold start — 3 probes after a container restart (operator restarts first)
//
// Request-side JSONL record (flatline HC4):
//   {ts, phase, seq, call_class, url, http_status, latency_ms,
//    enrich_requested, gate_decision?}
// joins with server-side atoms on gate_decision + time window (drift check).
//
// KILL-SWITCH ABORT (flatline B5): a `:kill_switch` gate decision mid-phase
// silently shifts the designed mix from 80/20 to 100/0 and invalidates H1/H2.
// The driver ABORTS the phase on the FIRST kill-switch decision observed and
// flags the run; the readout truncates the window at that timestamp.
//
// Usage:
//   pnpm tsx scripts/playtest/cop-driver.ts --phase 0 --base-url http://localhost:3000 [--auth-token T]
//   pnpm tsx scripts/playtest/cop-driver.ts --phase 2 --level 2 --base-url ... [--duration-min 60]

import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

interface DriverArgs {
  phase: 0 | 1 | 2 | 3
  baseUrl: string
  authToken?: string
  level?: 1 | 2 | 3
  durationMin?: number
  out?: string
}

interface DriverRecord {
  ts: number
  phase: number
  level?: number
  seq: number
  call_class: "A_relay" | "B_enrich"
  url: string
  http_status: number
  latency_ms: number
  enrich_requested: boolean
  gate_decision?: string
  error?: string
}

function parseArgs(argv: string[]): DriverArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const phase = Number.parseInt(get("--phase") ?? "", 10)
  const baseUrl = get("--base-url")
  if (![0, 1, 2, 3].includes(phase) || !baseUrl) {
    console.error(
      "usage: cop-driver.ts --phase 0|1|2|3 --base-url URL [--auth-token T] [--level 1|2|3] [--duration-min N] [--out FILE]",
    )
    process.exit(2)
  }
  const levelRaw = get("--level")
  const durationRaw = get("--duration-min")
  return {
    phase: phase as DriverArgs["phase"],
    baseUrl: baseUrl.replace(/\/$/, ""),
    authToken: get("--auth-token") ?? process.env.FINN_AUTH_TOKEN,
    level: levelRaw ? (Number.parseInt(levelRaw, 10) as 1 | 2 | 3) : undefined,
    durationMin: durationRaw ? Number.parseFloat(durationRaw) : undefined,
    out: get("--out"),
  }
}

/** Deterministic agent-id streams. Class B ids must be enrichable, so the
 *  driver picks ids whose stub fixture does NOT abstain (the gate's abstain
 *  rule would otherwise zero out the B mix — the mix is designed load).
 *  Uses the same fnv1a/claim derivation as the stub fixtures. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function isAbstainId(id: string): boolean {
  return fnv1a(id) % 3 === 0
}

function* agentIds(prefix: string, wantAbstain: boolean): Generator<string> {
  let i = 0
  while (true) {
    const id = `${prefix}${i++}`
    if (isAbstainId(id) === wantAbstain) yield id
  }
}

interface PhasePlan {
  total: number
  bRatio: number // fraction of calls that are Class B
  intervalMs: number // pacing between request starts
  level?: number
}

function planFor(args: DriverArgs): PhasePlan {
  switch (args.phase) {
    case 0:
      return { total: 5, bRatio: 2 / 5, intervalMs: 1_000 }
    case 1:
      return { total: 50, bRatio: 10 / 50, intervalMs: 6_000 } // ~10 rpm
    case 2: {
      const level = args.level
      if (!level) {
        console.error("--phase 2 requires --level 1|2|3 (≈1/10/60 rpm)")
        process.exit(2)
      }
      const rpm = level === 1 ? 1 : level === 2 ? 10 : 60
      const minutes = args.durationMin ?? 60
      return {
        total: Math.max(1, Math.round(rpm * minutes)),
        bRatio: 0.2,
        intervalMs: Math.round(60_000 / rpm),
        level,
      }
    }
    case 3:
      return { total: 3, bRatio: 0, intervalMs: 2_000 }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const plan = planFor(args)
  const outPath =
    args.out ?? `scripts/playtest/out/driver-phase${args.phase}${plan.level ? `-l${plan.level}` : ""}-${Date.now()}.jsonl`
  await mkdir(dirname(outPath), { recursive: true })

  // Interleave deterministically: spread B calls evenly through the run.
  const isB = (seq: number): boolean =>
    plan.bRatio > 0 && Math.floor(seq * plan.bRatio) !== Math.floor((seq - 1) * plan.bRatio)

  const claimIds = agentIds("0xcop-claim-", false)
  // Class A traffic mixes abstain + claim fixtures (realistic relay mix);
  // Class B targets claim fixtures so the designed mix actually exercises
  // the inference path (abstains never earn inference by design).
  const anyIds = (function* (): Generator<string> {
    let i = 0
    while (true) yield `0xcop-any-${i++}`
  })()

  console.log(
    `[cop-driver] phase ${args.phase}${plan.level ? ` level ${plan.level}` : ""}: ` +
      `${plan.total} calls, B-ratio ${(plan.bRatio * 100).toFixed(0)}%, interval ${plan.intervalMs}ms → ${outPath}`,
  )

  let aborted = false
  for (let seq = 1; seq <= plan.total; seq++) {
    const enrich = isB(seq)
    const agentId = enrich ? claimIds.next().value : anyIds.next().value
    const url = `${args.baseUrl}/api/v1/score/verdict/${agentId}${enrich ? "?enrich=true" : ""}`
    const started = Date.now()
    const record: DriverRecord = {
      ts: started,
      phase: args.phase,
      ...(plan.level ? { level: plan.level } : {}),
      seq,
      call_class: enrich ? "B_enrich" : "A_relay",
      url,
      http_status: 0,
      latency_ms: 0,
      enrich_requested: enrich,
    }
    try {
      const res = await fetch(url, {
        headers: args.authToken ? { Authorization: `Bearer ${args.authToken}` } : {},
      })
      record.http_status = res.status
      record.latency_ms = Date.now() - started
      try {
        const body = (await res.json()) as { gate_decision?: string }
        if (typeof body.gate_decision === "string") record.gate_decision = body.gate_decision
      } catch {
        // non-JSON body — status + latency still recorded
      }
    } catch (err) {
      record.http_status = -1
      record.latency_ms = Date.now() - started
      record.error = err instanceof Error ? err.message : String(err)
    }
    await appendFile(outPath, JSON.stringify(record) + "\n", "utf-8")

    const tag = record.gate_decision ?? record.error ?? ""
    console.log(
      `[cop-driver] ${seq}/${plan.total} ${record.call_class} → ${record.http_status} ${record.latency_ms}ms ${tag}`,
    )

    // B5: first kill-switch decision aborts the phase.
    if (record.gate_decision?.includes("kill_switch")) {
      console.error(
        `[cop-driver] KILL-SWITCH observed at seq ${seq} — ABORTING PHASE (flatline B5). ` +
          "Post-breach data is invalid; the readout truncates at this timestamp.",
      )
      await appendFile(
        outPath,
        JSON.stringify({ ts: Date.now(), phase: args.phase, abort: "kill_switch", at_seq: seq }) + "\n",
        "utf-8",
      )
      aborted = true
      break
    }

    if (seq < plan.total) {
      await new Promise((resolve) => setTimeout(resolve, plan.intervalMs))
    }
  }

  console.log(`[cop-driver] ${aborted ? "ABORTED" : "complete"} → ${outPath}`)
  process.exit(aborted ? 3 : 0)
}

main().catch((err) => {
  console.error("[cop-driver] fatal:", err)
  process.exit(1)
})
