// src/research/sensors/dune.ts — the Dune on-chain sensor: a THIN SHIM over the
// Asson-graduated dune-meter CLI (bd-8ywq.8 · Agent R&D Lab V1 · spec § Sensors
// item 3, Acceptance Contract G).
//
// On-chain settlement is where "is this real?" gets a DETERMINISTIC answer — so
// for the agentic-commerce-realness domain this is the PRIMARY sensor (the
// realness-filter / EXP-002 lineage). Per Contract G the shim reaches data ONLY
// through the Asson-CLI seam: it shells `dune-meter` (the cost-aware adapter that
// already rides veve → ladder → CommandPolicy → sandbox) via child_process. It
// NEVER hits Dune directly and never names a Dune host — the boundary scanner in
// ./index.ts enforces that statically.
//
// COST GATE (the one hard gate): every `run` carries a MANDATORY `--cap`
// (credits) — dune-meter hard-aborts over the cap, and refuses up front if the
// estimate would overspend its budget ledger. There is no uncapped path here, so
// no un-bounded Dune call can ship (the EXP-002 budget-blowout, made structurally
// impossible upstream; this shim only ever invokes the capped `run`).
//
// ASSON-CLI SCAFFOLD: @freeside/dune-meter is not installed in finn. Absent the
// binary, `duneAvailability()` is a typed-unavailable (V2-ready) — ZERO spawns,
// ZERO spend — and the SensorFn raises `SensorUnavailableError`, so the probe
// meters a typed failure rather than failing silently. Install / point
// DUNE_METER_BIN at the CLI to graduate it live.

import { spawn as nodeSpawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ResearchSensorError } from "../cost-atom-research.js"
import type { Citation } from "../schemas/index.js"
import type { SensorFn, SensorInput, SensorOutput } from "../probe.js"
import { SensorUnavailableError, type SensorAvailability } from "./contract.js"

/** The success shape of `dune-meter run` stdout JSON (the fields the shim reads;
 *  dune-meter emits more). On refuse/abort `executed` is absent and
 *  `refused`/`aborted` is set — both are honest non-findings, surfaced as typed
 *  failures here (never a fabricated result). */
export interface DuneRunResult {
  executed?: boolean
  refused?: boolean
  aborted?: boolean
  execution_id?: string
  credits_consumed?: number
  datapoints_scanned?: number
  cap_exceeded?: boolean
  atom_id?: string
  atom_checksum?: string
  [k: string]: unknown
}

export interface DuneSpawnResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Shell-out seam — the ONLY way the shim runs the Dune CLI. Default wraps
 *  child_process.spawn; tests inject a mock (no real dune-meter / Dune call). */
export type DuneSpawn = (
  bin: string,
  args: string[],
  opts: { timeout_ms: number; signal?: AbortSignal },
) => Promise<DuneSpawnResult>

export interface DuneSensorDeps {
  /** Resolve the dune-meter binary path, or null if absent. Default: env
   *  `DUNE_METER_BIN` (if it exists) else a PATH scan. ZERO spawns. */
  resolveBinary?: () => string | null
  /** Shell-out seam (see `DuneSpawn`). Default: child_process.spawn wrapper. */
  spawn?: DuneSpawn
  /** Per-query Dune cost-cap in credits — MANDATORY on `run` (the cost gate;
   *  dune-meter hard-aborts over it). Default 50 (free-tier-safe). */
  cap_credits?: number
  /** Dune compute engine. Default "small" (cheapest). */
  engine?: string
  /** Credits → integer micro-USD for the research ledger. Default is a DOCUMENTED
   *  PLACEHOLDER (1 credit ↦ 1 micro-USD): Dune credits are NOT USD. V2 either
   *  wires Dune's real credit price OR (preferred) references dune-meter's own
   *  credit budget ledger the way the LLM path references MODELINV — a `dune_ref`
   *  schema field, deferred (out of .8 scope). The cost gate that matters (the
   *  `--cap`) holds regardless of this rate. */
  credits_to_micro?: (credits: number) => bigint
  /** Spawn timeout (ms). Default 300_000 (dune-meter's declared p95 budget). */
  timeout_ms?: number
}

/** Default binary resolver — env override, else a PATH scan. Pure filesystem
 *  `existsSync` only; no spawn, no network. */
function defaultResolveDuneMeter(): string | null {
  const fromEnv = process.env.DUNE_METER_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean)
  for (const d of pathDirs) {
    const cand = join(d, "dune-meter")
    if (existsSync(cand)) return cand
  }
  return null
}

/** PLACEHOLDER credits→micro-USD (see `DuneSensorDeps.credits_to_micro`). */
function defaultCreditsToMicro(credits: number): bigint {
  const c = Number.isFinite(credits) ? Math.max(0, Math.trunc(credits)) : 0
  return BigInt(c)
}

/** Default shell-out — child_process.spawn, stdout/stderr captured, SIGTERM on
 *  timeout. Only ever runs on the PRODUCTION path (tests inject a mock). */
function defaultDuneSpawn(
  bin: string,
  args: string[],
  opts: { timeout_ms: number; signal?: AbortSignal },
): Promise<DuneSpawnResult> {
  return new Promise((res, rej) => {
    const child = nodeSpawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeout_ms)
    child.stdout?.on("data", (d) => {
      stdout += d.toString()
    })
    child.stderr?.on("data", (d) => {
      stderr += d.toString()
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      rej(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      res({ code, stdout, stderr })
    })
  })
}

/** Pure, zero-call availability of the Dune on-chain seam: is the dune-meter CLI
 *  present? Absent ⇒ typed-unavailable (Asson-CLI scaffold, V2-ready). */
export function duneAvailability(deps: DuneSensorDeps = {}): SensorAvailability {
  const bin = (deps.resolveBinary ?? defaultResolveDuneMeter)()
  if (!bin) {
    return {
      available: false,
      reason:
        "dune-meter CLI not found (set DUNE_METER_BIN or install @freeside/dune-meter) — dune is an Asson-CLI scaffold here; zero calls, zero spend",
    }
  }
  return { available: true }
}

/** Build the Dune on-chain SensorFn. Unavailable ⇒ `SensorUnavailableError`
 *  (cost 0, zero spawns). Available ⇒ shell the cost-capped `dune-meter run`
 *  (NEVER raw Dune, ALWAYS `--cap`), parse its CostAtom-bearing JSON, and map to
 *  a `SensorOutput`. A refuse / cap-abort / non-zero exit is a TYPED failure
 *  (no fabricated finding); the probe meters it. */
export function makeDuneSensor(deps: DuneSensorDeps = {}): SensorFn {
  const cap = deps.cap_credits ?? 50
  const engine = deps.engine ?? "small"
  const timeoutMs = deps.timeout_ms ?? 300_000
  const toMicro = deps.credits_to_micro ?? defaultCreditsToMicro
  const spawnImpl = deps.spawn ?? defaultDuneSpawn
  const resolveBin = deps.resolveBinary ?? defaultResolveDuneMeter

  return async (input: SensorInput): Promise<SensorOutput> => {
    const avail = duneAvailability(deps)
    if (!avail.available) {
      throw new SensorUnavailableError("dune", avail.reason)
    }
    const bin = resolveBin() as string

    // Cost-capped run — the cap is mandatory; there is no uncapped path.
    const args = ["run", input.question, "--cap", String(cap), "--engine", engine]

    let r: DuneSpawnResult
    try {
      r = await spawnImpl(bin, args, { timeout_ms: timeoutMs, signal: input.signal })
    } catch (err) {
      throw new ResearchSensorError(`dune-meter spawn failed: ${(err as Error).message}`)
    }
    if (r.code !== 0) {
      // exit 2 caller · 3 budget-refuse · 4 cap-aborted — all typed, no finding.
      const tail = (r.stderr || r.stdout).slice(-300)
      throw new ResearchSensorError(`dune-meter exited ${r.code}: ${tail}`)
    }

    const brace = r.stdout.indexOf("{")
    if (brace === -1) {
      throw new ResearchSensorError("dune-meter produced no JSON output")
    }
    let parsed: DuneRunResult
    try {
      parsed = JSON.parse(r.stdout.slice(brace)) as DuneRunResult
    } catch (err) {
      throw new ResearchSensorError(`dune-meter output parse failed: ${String(err)}`)
    }
    if (!parsed.executed) {
      const why = parsed.refused ? "budget refuse" : parsed.aborted ? "cap aborted" : "no execution"
      throw new ResearchSensorError(`dune-meter did not execute (${why})`)
    }

    const credits = Number.isInteger(parsed.credits_consumed) ? (parsed.credits_consumed as number) : 0
    const datapoints = Number.isInteger(parsed.datapoints_scanned) ? (parsed.datapoints_scanned as number) : 0
    const ref = String(parsed.execution_id ?? parsed.atom_id ?? "dune-run")

    const citation: Citation = {
      // The metered CLI run IS the citation — an on-chain settlement read, not a
      // web page. http_status 200 marks it a live data read for the linkrot gate.
      url: `dune-meter://run/${ref}`,
      retrieved_ts: input.now(),
      http_status: 200,
      source_type: "on-chain-dune",
      claim_support: null,
      confidence: "high",
    }

    return {
      finding: `dune-meter run ${ref}: ${credits} credits, ${datapoints} datapoints scanned`,
      citations: [citation],
      cost_micro: toMicro(credits),
      inference_micro: 0n, // dune is DATA, not inference
      modelinv_ref: null, // dune cost is Dune credits, not MODELINV
      provider_intended: "dune",
      provider_resolved: "dune",
    }
  }
}
