// src/research/forecast-registry.ts — the TETLOCK forecast registration contract
// (sprint:corpus-a T0b · SDD DD-3 / DD-3′).
//
// The franchise rule, made mechanical: a settle may NOT score a bet that has no
// PRE-REGISTERED probability. `requireForecast()` is the guard `src/corpus/settle.ts`
// calls before any settle — it throws `NoForecastError` when the (question_hash,
// horizon) pair was never registered. And forecasts are PER HORIZON: a survival
// re-settle at t+30 resolves the `survival_30d` forecast, never the discovery `p`
// (scoring discovery-realness against 30-day-survival is statistically invalid —
// they are different events; DD-3′).
//
// The registry is an append-only JSONL ledger (one TetlockForecast per line),
// mirroring the spine-ledger's append discipline at a lighter weight. Pure over an
// injected `now`/`idgen` so tests are deterministic and never touch the real ledger.

import { appendFile, readFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { ulid } from "ulid"
import { questionHash } from "./cost-atom-research.js"
import type { TetlockForecast, ForecastHorizon } from "./schemas/index.js"

/** Default forecast-registry ledger path (the lab's Ledger of Bets, forecast side). */
export const FORECAST_REGISTRY_PATH = "src/research/forecasts.jsonl"

/** Raised when a settle is attempted with no pre-registered forecast for its
 *  (question_hash, horizon). The DD-3 guard — abstain over score-an-unregistered-bet. */
export class NoForecastError extends Error {
  constructor(
    readonly question_hash: string,
    readonly horizon: ForecastHorizon,
  ) {
    super(
      `no registered forecast for question_hash ${question_hash.slice(0, 12)}… horizon "${horizon}" — a settle cannot score a bet that was never registered (DD-3)`,
    )
    this.name = "NoForecastError"
  }
}

export interface RegisterForecastInput {
  /** The belief/question (hashed to join the probe + cost atom). */
  question: string
  horizon: ForecastHorizon
  /** Claimed probability the belief holds at this horizon, integer ppm (0..1e6). */
  probability_ppm: number
  /** PLATT's pre-registered crucial-experiment bar (the deterministic test). */
  resolution_criterion: string
  /** Outside-view base rate, integer ppm. Null until established. */
  base_rate_ppm?: number | null
}

export interface RegisterForecastOptions {
  path?: string
  now?: () => number
  /** Injectable id generator (default ulid) — deterministic in tests. */
  idgen?: () => string
}

/** Register a forecast for (question, horizon) BEFORE its settle. Appends one
 *  `TetlockForecast` (outcome/brier/attestation null until a deterministic settle
 *  resolves it) to the registry and returns it. */
export async function registerForecast(
  input: RegisterForecastInput,
  opts: RegisterForecastOptions = {},
): Promise<TetlockForecast> {
  const now = opts.now ?? Date.now
  const idgen = opts.idgen ?? ulid
  const path = opts.path ?? FORECAST_REGISTRY_PATH

  if (!Number.isInteger(input.probability_ppm) || input.probability_ppm < 0 || input.probability_ppm > 1_000_000) {
    throw new Error(`probability_ppm must be an integer in [0, 1_000_000], got ${input.probability_ppm}`)
  }

  const forecast: TetlockForecast = {
    forecast_id: idgen(),
    question_hash: questionHash(input.question),
    horizon: input.horizon,
    probability_ppm: input.probability_ppm,
    resolution_criterion: input.resolution_criterion,
    base_rate_ppm: input.base_rate_ppm ?? null,
    created_ts: now(),
    resolved_ts: null,
    outcome: null,
    brier_ppm: null,
    attestation: null,
  }

  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(forecast) + "\n")
  return forecast
}

/** Read all registered forecasts (append-only JSONL). Missing file ⇒ []. A torn
 *  final line (crash mid-append) is skipped, not fatal. */
export async function readForecasts(path: string = FORECAST_REGISTRY_PATH): Promise<TetlockForecast[]> {
  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch {
    return []
  }
  const out: TetlockForecast[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as TetlockForecast)
    } catch {
      // torn-tail quarantine: skip an unparseable (crash-truncated) final line
    }
  }
  return out
}

/** Find the most-recently-registered forecast for a (question_hash, horizon),
 *  or null. Last-write-wins: a re-registration supersedes an earlier one. */
export function findForecast(
  forecasts: TetlockForecast[],
  question_hash: string,
  horizon: ForecastHorizon,
): TetlockForecast | null {
  let found: TetlockForecast | null = null
  for (const f of forecasts) {
    if (f.question_hash === question_hash && f.horizon === horizon) found = f
  }
  return found
}

/** The DD-3 guard: return the registered forecast for (question, horizon) or throw
 *  `NoForecastError`. `src/corpus/settle.ts` calls this BEFORE scoring any settle —
 *  a settle with no prior forecast is rejected, never fabricated. */
export async function requireForecast(
  question: string,
  horizon: ForecastHorizon,
  path: string = FORECAST_REGISTRY_PATH,
): Promise<TetlockForecast> {
  const qh = questionHash(question)
  const f = findForecast(await readForecasts(path), qh, horizon)
  if (!f) throw new NoForecastError(qh, horizon)
  return f
}
