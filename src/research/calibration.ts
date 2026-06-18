// src/research/calibration.ts — the calibration engine: resolve a decision against
// ground truth, Brier-score it, and aggregate the reflexive calibration report.
//
// THE MISSING MECHANICAL PIECE. forecast-registry.ts could REGISTER a forecast
// (probability + resolution criterion, outcome/brier null) but nothing ever
// RESOLVED one — Brier scoring had only ever been done by-prompt (the SETTLES.md
// CALIBRATE sections were hand-computed by the TETLOCK desk). This closes the loop:
// resolution + Brier + calibration aggregation are now a deterministic function,
// not a judgment call — so the appraiser can be appraised by the same standard it
// holds everything else to.
//
// Two halves:
//   1. resolveDecision()      — register → resolve, computing brier_ppm (or
//                               leaving it null when the outcome is `insufficient`:
//                               abstain over force, the realness-verdict discipline).
//   2. calibrationReport()    — aggregate calibration over a set of resolved
//                               decisions, BUCKETED BY EFFECT SIZE (the §5b axis),
//                               with the over-confidence-vs-resolution diagnostic.
//
// Plus the durable, hash-chained DecisionForecast ledger (writer/reader/verify),
// mirroring indexing-ledger.ts exactly so the reflexive ledger is a tamper-evident,
// re-runnable artifact like every other ledger in this lab.

import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { canonicalize, canonicalJson } from "./cost-atom-research.js"
import { GENESIS_HASH } from "./schemas/index.js"
import {
  assertDecisionValid,
  brierPpm,
  classifyEffectFromMargin,
  outcomeToBinary,
  type DecisionForecast,
  type DecisionForecastEnvelope,
  type DecisionOutcome,
  type EffectSize,
  type ResolutionInstrument,
} from "./schemas/decision-forecast.js"
import {
  EFFECT_SIZES,
  RESOLUTION_INSTRUMENTS,
  RESOLUTION_TRUST,
  OBJECTIVE_INSTRUMENTS,
} from "./schemas/decision-forecast.js"

/** Default ledger path — git-tracked, the reflexive calibration artifact (holds
 *  RESOLVED records: a prediction + its ground-truth Brier). */
export const CALIBRATION_LEDGER_PATH = "grimoires/loa/lab/cabt-calibration.jsonl"

/** The PRE-REGISTRATION ledger — git-tracked, holds LOGGED, still-UNRESOLVED
 *  forecasts (p fixed BEFORE the outcome is known). This is the forward fix the
 *  retrospective ledger could not be: genuine calibration evidence requires a
 *  prediction logged before the ladder speaks. Mirrors forecast-registry.ts →
 *  SETTLES: register here, resolve into the EVIDENCE ledger when the ladder settles.
 *
 *  TRUST ROOT: the integrity guarantee is GIT-COMMIT PRECEDENCE — the commit that
 *  REGISTERS a forecast must precede the commit that RESOLVES it. The hash chain +
 *  the resolved record's `registered_entry_hash` binding are defense-in-depth that
 *  make a post-hoc edit DETECTABLE; git history is what makes the "logged before the
 *  outcome" claim auditable. A `--write` that changes the set is a deliberate,
 *  reviewable commit, not a silent fixture edit. */
export const CABT_FORECAST_REGISTRY_PATH = "grimoires/loa/lab/cabt-forecasts.jsonl"

/** The EVIDENCE ledger — resolved PRE-REGISTERED (logged) forecasts land here, kept
 *  SEPARATE from the retrospective `cabt-calibration.jsonl` (which holds the 8
 *  reconstructed rows). Co-mingling would be fatal: `headline_eligible` requires
 *  EVERY objective-scored row to be logged, so the immortal reconstructed rows would
 *  pin the headline to `retrospective-demo` forever — the forward fix's payoff would
 *  be structurally unreachable (3-model review H1). A report over THIS ledger is
 *  clean: as logged bets resolve, it flips to `calibration-evidence`. */
export const CALIBRATION_LOGGED_PATH = "grimoires/loa/lab/cabt-calibration-logged.jsonl"

// ---------------------------------------------------------------------------
// Resolve — register → resolve, computing the Brier score
// ---------------------------------------------------------------------------

export interface DecisionResolution {
  resolution_instrument: ResolutionInstrument
  /** The deterministic ground truth, verbatim. */
  ground_truth: string
  outcome: DecisionOutcome
  resolved_ts: number
}

/** Resolve an unresolved DecisionForecast against ground truth, returning a NEW
 *  resolved record (the input is not mutated — the registered prediction is
 *  immutable; resolution is a separate, later event). Computes `brier_ppm` from
 *  the binary outcome, or leaves it NULL when the outcome is `insufficient`
 *  (the instrument could not resolve the difference — abstain over force).
 *  Throws if the input is already resolved (a bet is scored once).
 *
 *  CONTRACT: `outcome` judges the PROPOSITION's truth (held = true, falsified =
 *  false), NOT whether the agent's prediction was right. Brier measures the gap
 *  between the prediction and the proposition's truth, so resolving against
 *  "was the agent right" would invert the score for any p < 0.5. */
export function resolveDecision(forecast: DecisionForecast, resolution: DecisionResolution): DecisionForecast {
  // Validate the INPUT first — a malformed or partially-resolved record (e.g.
  // resolution_instrument set but outcome null) must be rejected, not silently
  // overwritten. assertDecisionValid enforces the all-or-nothing resolution
  // invariant, so a partial input throws here.
  assertDecisionValid(forecast)
  if (forecast.outcome !== null || forecast.brier_ppm !== null || forecast.resolved_ts !== null) {
    throw new Error(`resolveDecision(${forecast.decision_id}): already resolved — a bet is scored once`)
  }
  const binary = outcomeToBinary(resolution.outcome)
  const resolved: DecisionForecast = {
    ...forecast,
    resolution_instrument: resolution.resolution_instrument,
    ground_truth: resolution.ground_truth,
    outcome: resolution.outcome,
    brier_ppm: binary === null ? null : brierPpm(forecast.prediction_ppm, binary),
    resolved_ts: resolution.resolved_ts,
  }
  assertDecisionValid(resolved)
  return resolved
}

// ---------------------------------------------------------------------------
// Pre-registration — the forward fix (log p BEFORE the outcome)
// ---------------------------------------------------------------------------

/** Raised when a resolution is attempted for a decision that was never
 *  pre-registered (the franchise rule: a settle cannot score a bet that has no
 *  logged, before-the-outcome prediction). */
export class NoRegisteredDecisionError extends Error {
  constructor(readonly decision_id: string) {
    super(`no pre-registered forecast for decision "${decision_id}" — a resolution cannot score a bet that was never logged before its outcome (the franchise rule)`)
    this.name = "NoRegisteredDecisionError"
  }
}

/** Pre-register a LOGGED, still-unresolved forecast to the registry ledger. The
 *  guards make pre-registration meaningful: the prediction MUST be `logged` (a
 *  reconstructed prediction is not evidence), MUST be unresolved (you cannot
 *  pre-register a bet whose outcome you already hold), and MUST be the first
 *  registration of its decision_id (register-once). Returns the written envelope.
 *
 *  ENFORCEMENT LEVEL (not overstated): register-once is checked by a read-then-append
 *  that is atomic only under SINGLE-WRITER, sequential use (the actual usage — the
 *  deterministic seed + a manual resolve step). It is NOT lock-guarded against
 *  concurrent registrars; two parallel calls could both pass the check and append a
 *  duplicate decision_id. That is caught LOUDLY downstream (calibrationReport's
 *  duplicate-id guard throws) rather than silently corrupting — but if concurrent
 *  registration is ever introduced, port the advisory `flock` from spine-ledger.ts.
 *  Immutability of a registered prediction rests on GIT (the committed registry),
 *  not on a runtime lock. */
export async function registerDecision(
  forecast: DecisionForecast,
  path: string = CABT_FORECAST_REGISTRY_PATH,
): Promise<DecisionForecastEnvelope> {
  assertDecisionValid(forecast)
  if (forecast.prediction_basis !== "logged") {
    throw new Error(`registerDecision(${forecast.decision_id}): a pre-registered forecast MUST be prediction_basis="logged" (got "${forecast.prediction_basis}") — reconstructed predictions are not evidence`)
  }
  if (forecast.outcome !== null || forecast.brier_ppm !== null || forecast.resolved_ts !== null) {
    throw new Error(`registerDecision(${forecast.decision_id}): cannot pre-register an already-resolved forecast`)
  }
  const existing = findRegisteredDecision(await readDecisionRegistry(path), forecast.decision_id)
  if (existing) {
    throw new Error(`registerDecision(${forecast.decision_id}): already registered — a bet's prediction is immutable (register once)`)
  }
  return new DecisionLedgerWriter(path).append(forecast)
}

/** Read all pre-registered forecasts (hash-chained registry ledger). Missing ⇒ []. */
export async function readDecisionRegistry(
  path: string = CABT_FORECAST_REGISTRY_PATH,
): Promise<DecisionForecast[]> {
  const { envelopes } = await readCalibrationLedger(path)
  return envelopes.map(decisionFromEnvelope)
}

/** Find a registered forecast by decision_id, or null. */
export function findRegisteredDecision(
  forecasts: DecisionForecast[],
  decision_id: string,
): DecisionForecast | null {
  return forecasts.find((f) => f.decision_id === decision_id) ?? null
}

/** Resolve a PRE-REGISTERED decision against ground truth and append the resolved
 *  record to the calibration ledger — the "ladder speaks" step. The franchise rule
 *  is enforced: the decision MUST have been registered (else NoRegisteredDecisionError),
 *  and the registered prediction is used verbatim (it cannot be edited at resolution).
 *  The effect_size is set MECHANICALLY from the observed self-play margin
 *  (classifyEffectFromMargin) — data, not narrator (review M5) — overriding the
 *  predicted effect the bet carried. */
export async function resolveRegisteredDecision(
  decision_id: string,
  resolution: DecisionResolution,
  observedMarginPpm: number | null,
  opts: { registryPath?: string; calibrationPath?: string } = {},
): Promise<DecisionForecast> {
  const registryPath = opts.registryPath ?? CABT_FORECAST_REGISTRY_PATH
  // Default to the EVIDENCE ledger, NOT the retrospective one (H1): co-mingling
  // logged evidence with reconstructed rows pins headline_eligible false forever.
  const calibrationPath = opts.calibrationPath ?? CALIBRATION_LOGGED_PATH

  // The registry must replay clean before we trust any record in it as evidence —
  // a hand-edited `logged` line that passed validation must not be resolvable
  // (codex: evidence-grade resolution requires an intact chain).
  const registryRead = await readCalibrationLedger(registryPath)
  const registryCheck = verifyCalibrationLedger(registryRead.envelopes)
  if (!registryCheck.valid) {
    throw new Error(`resolveRegisteredDecision(${decision_id}): registry ledger failed verification (${registryCheck.reason ?? registryCheck.semantic_reason}) — refusing to resolve against a tampered registry`)
  }
  const registeredEnvelope = registryRead.envelopes.find(
    (e) => (e.forecast as { decision_id?: string }).decision_id === decision_id,
  )
  const registered = registeredEnvelope ? decisionFromEnvelope(registeredEnvelope) : null
  if (!registered || !registeredEnvelope) throw new NoRegisteredDecisionError(decision_id)

  // Effect-rule bypass guard: an OBJECTIVE (ladder-measured) ship/reject resolution
  // MUST carry a numeric margin — otherwise a null margin would mechanically classify
  // it `framing` and dodge the effect-size rule (codex). Framing/reframe decisions
  // legitimately have no margin.
  const objectiveShipReject =
    OBJECTIVE_INSTRUMENTS.includes(resolution.resolution_instrument) &&
    (registered.action === "ship" || registered.action === "reject")
  if (objectiveShipReject && observedMarginPpm === null) {
    throw new Error(`resolveRegisteredDecision(${decision_id}): a ladder-measured ${registered.action} needs a numeric observedMarginPpm (null would bypass the effect-size rule as "framing")`)
  }

  // Already-resolved guard: refuse if this decision_id is already in the calibration
  // ledger. Without this, a re-run appends a duplicate that makes calibrationReport
  // throw `duplicate decision_id` — rendering the whole ledger unreportable.
  const priorResolved = await readCalibrationLedger(calibrationPath)
  if (priorResolved.envelopes.some((e) => (e.forecast as { decision_id?: string }).decision_id === decision_id)) {
    throw new Error(`resolveRegisteredDecision(${decision_id}): already resolved on the calibration ledger — a bet is scored once`)
  }

  // Effect size is the MEASURED classification, not the bet's predicted label; and
  // bind the resolved record to its immutable registration by the registry envelope
  // hash (the cryptographic half of the trust root — a rewritten registry no longer
  // matches this committed binding).
  const measured: DecisionForecast = {
    ...registered,
    effect_size: classifyEffectFromMargin(observedMarginPpm),
    registered_entry_hash: registeredEnvelope.entry_hash,
  }
  const resolved = resolveDecision(measured, resolution)
  await new DecisionLedgerWriter(calibrationPath).append(resolved)
  return resolved
}

// ---------------------------------------------------------------------------
// Report — aggregate calibration, bucketed by effect size
// ---------------------------------------------------------------------------

export interface ScoredBucket {
  n: number
  n_scored: number
  n_insufficient: number
  /** Mean Brier over the SCORED decisions in this bucket, integer ppm, or null
   *  when nothing in the bucket was scoreable. */
  mean_brier_ppm: number | null
}

export interface EffectBucket extends ScoredBucket {
  effect_size: EffectSize
}

export interface InstrumentBucket extends ScoredBucket {
  instrument: ResolutionInstrument
}

/** Whether the scored set is genuine calibration EVIDENCE or a retrospective demo.
 *  Evidence requires BOTH: predictions LOGGED before the outcome (not reconstructed
 *  post-hoc — the hindsight-bias guard) AND resolution by an OBJECTIVE instrument
 *  (the real target). Anything else is a worked example, not a track record. */
export type EvidenceClass = "calibration-evidence" | "retrospective-demo"

export interface CalibrationReport {
  n_total: number
  /** Resolved AND scoreable (outcome held/falsified). */
  n_scored: number
  /** Resolved but UNSCOREABLE (outcome insufficient — the honest gap). */
  n_insufficient: number
  n_unresolved: number

  // --- THE HONESTY GATE (3-model review consensus) ------------------------------
  /** `calibration-evidence` iff EVERY objective-scored decision was LOGGED (not
   *  reconstructed); else `retrospective-demo`. A consumer MUST NOT report this as
   *  a calibration track record unless `headline_eligible` is true. */
  evidence_class: EvidenceClass
  headline_eligible: boolean
  /** prediction_basis counts among SCORED decisions — surfaces the reconstructed
   *  contamination that bars headline calibration language. */
  scored_prediction_basis: { logged: number; reconstructed: number }

  // --- THE HEADLINE SUBSET: objective-instrument scored only --------------------
  /** Decisions resolved by an OBJECTIVE instrument (the real target). Necessary for
   *  evidence but NOT sufficient — a reconstructed objective row (e.g. the original
   *  cabt-calibration rows) is still not calibration evidence. See `evidence`. */
  objective: ScoredBucket
  /** THE calibration-evidence subset: objective AND `logged` (pre-registered before
   *  the outcome). This is the ONLY bucket that is genuine calibration evidence, and
   *  the one that grows as pre-registered forecasts resolve — even when the ledger
   *  also holds reconstructed objective rows that keep `headline_eligible` false. */
  evidence: ScoredBucket
  /** Decisions resolved by a PROXY/structural/framing instrument — recorded as
   *  reflection (the gate or the reasoning was sound), NOT calibration evidence. */
  reflection: ScoredBucket

  /** Mean Brier over ALL scored decisions, integer ppm — BLENDED (objective +
   *  proxy + framing). Illustrative ONLY; do not headline it (it mixes settlement
   *  qualities). Use `objective.mean_brier_ppm` for any calibration claim. */
  blended_mean_brier_ppm: number | null

  /** Per-effect-size buckets — the §5b axis: the loop is well-calibrated where the
   *  effect is large enough for its instrument to resolve, and not where it is not. */
  by_effect: EffectBucket[]
  /** Per-resolution-instrument buckets — separates measured ground truth from
   *  proxy/subjective settlements (the dilution the review flagged). */
  by_instrument: InstrumentBucket[]
  by_outcome: Record<DecisionOutcome, number>
  /** The over-confidence-vs-resolution diagnostic: decisions the instrument could
   *  NOT resolve (`insufficient`) yet which carried a CONFIDENT prediction (far
   *  from 0.5). Each is a "you committed to a call your measure could not support"
   *  flag — the n_worlds lesson, derived mechanically. */
  overconfident_vs_resolution: DecisionForecast[]
  /** Highest / lowest Brier among scored decisions (the worst miss / best call). */
  worst: DecisionForecast | null
  best: DecisionForecast | null
  /** The WEAKEST resolution-instrument trust among scored decisions (Ken-Thompson:
   *  the aggregate verdict is only as trustworthy as its weakest backing). */
  min_resolution_trust: number | null
}

/** Default |p − 0.5| band (in ppm) above which an `insufficient` outcome counts as
 *  over-confident-vs-resolution. 0.1 → a prediction outside [0.4, 0.6] on a
 *  difference the instrument cannot resolve was a committed call with no backing. */
export const OVERCONFIDENCE_BAND_PPM = 100_000

const meanRound = (xs: number[]): number | null =>
  xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)

const isScored = (f: DecisionForecast): boolean =>
  f.outcome === "held" || f.outcome === "falsified"

/** Aggregate calibration over a set of (resolved or unresolved) decisions. Pure —
 *  no I/O, deterministic. Every decision is validated first (a malformed record
 *  fails here, not silently in the average). */
export function calibrationReport(
  decisions: DecisionForecast[],
  overconfidenceBandPpm: number = OVERCONFIDENCE_BAND_PPM,
): CalibrationReport {
  for (const d of decisions) assertDecisionValid(d)
  // Reject duplicate decision_ids — they would silently double-count in the means.
  const seen = new Set<string>()
  for (const d of decisions) {
    if (seen.has(d.decision_id)) {
      throw new Error(`calibrationReport: duplicate decision_id "${d.decision_id}" — each decision is scored once`)
    }
    seen.add(d.decision_id)
  }

  const scored = decisions.filter(isScored)
  const insufficient = decisions.filter((d) => d.outcome === "insufficient")
  const unresolved = decisions.filter((d) => d.outcome === null)

  const by_outcome: Record<DecisionOutcome, number> = { held: 0, falsified: 0, insufficient: 0 }
  for (const d of decisions) if (d.outcome) by_outcome[d.outcome]++

  const bucketOf = (subset: DecisionForecast[]): ScoredBucket => {
    const s = subset.filter(isScored)
    return {
      n: subset.length,
      n_scored: s.length,
      n_insufficient: subset.filter((d) => d.outcome === "insufficient").length,
      mean_brier_ppm: meanRound(s.map((d) => d.brier_ppm as number)),
    }
  }

  const by_effect: EffectBucket[] = EFFECT_SIZES.map((effect) => ({
    effect_size: effect,
    ...bucketOf(decisions.filter((d) => d.effect_size === effect)),
  }))

  const by_instrument: InstrumentBucket[] = RESOLUTION_INSTRUMENTS.map((instrument) => ({
    instrument,
    ...bucketOf(decisions.filter((d) => d.resolution_instrument === instrument)),
  }))

  // The headline subset: only decisions resolved by an OBJECTIVE instrument (the
  // real target) are calibration evidence. Everything else is reflection.
  const isObjective = (d: DecisionForecast): boolean =>
    d.resolution_instrument !== null && OBJECTIVE_INSTRUMENTS.includes(d.resolution_instrument)
  const objective = bucketOf(decisions.filter(isObjective))
  // The evidence subset: objective AND logged-before-the-outcome. The only genuine
  // calibration evidence; grows as pre-registered forecasts resolve.
  const evidence = bucketOf(decisions.filter((d) => isObjective(d) && d.prediction_basis === "logged"))
  const reflection = bucketOf(decisions.filter((d) => d.outcome !== null && !isObjective(d)))

  // The honesty gate: evidence requires objective resolution AND a LOGGED (not
  // reconstructed) prediction. Any reconstructed objective-scored prediction
  // downgrades the whole set to a retrospective demo.
  const objectiveScored = decisions.filter((d) => isObjective(d) && isScored(d))
  const scored_prediction_basis = {
    logged: scored.filter((d) => d.prediction_basis === "logged").length,
    reconstructed: scored.filter((d) => d.prediction_basis === "reconstructed").length,
  }
  const headline_eligible =
    objectiveScored.length > 0 && objectiveScored.every((d) => d.prediction_basis === "logged")
  const evidence_class: EvidenceClass = headline_eligible ? "calibration-evidence" : "retrospective-demo"

  const overconfident_vs_resolution = insufficient.filter(
    (d) => Math.abs(d.prediction_ppm - 500_000) > overconfidenceBandPpm,
  )

  // worst / best by Brier (highest / lowest) among scored.
  let worst: DecisionForecast | null = null
  let best: DecisionForecast | null = null
  for (const d of scored) {
    const b = d.brier_ppm as number
    if (worst === null || b > (worst.brier_ppm as number)) worst = d
    if (best === null || b < (best.brier_ppm as number)) best = d
  }

  const trusts = scored
    .map((d) => (d.resolution_instrument ? RESOLUTION_TRUST[d.resolution_instrument] : null))
    .filter((t): t is number => t !== null)

  return {
    n_total: decisions.length,
    n_scored: scored.length,
    n_insufficient: insufficient.length,
    n_unresolved: unresolved.length,
    evidence_class,
    headline_eligible,
    scored_prediction_basis,
    objective,
    evidence,
    reflection,
    blended_mean_brier_ppm: meanRound(scored.map((d) => d.brier_ppm as number)),
    by_effect,
    by_instrument,
    by_outcome,
    overconfident_vs_resolution,
    worst,
    best,
    min_resolution_trust: trusts.length ? Math.min(...trusts) : null,
  }
}

// ---------------------------------------------------------------------------
// The durable, hash-chained DecisionForecast ledger — mirrors indexing-ledger.ts
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/** entry_hash = sha256 of canonical { schema_version, prev_hash, forecast }. The
 *  `forecast` is already canonicalized (keys sorted); canonicalJson is idempotent
 *  so this is stable. Identical formula to the research-atom / indexing ledgers. */
export function decisionEntryHash(
  schemaVersion: 1,
  prevHash: string,
  forecast: Record<string, unknown>,
): string {
  return sha256Hex(canonicalJson({ schema_version: schemaVersion, prev_hash: prevHash, forecast }))
}

/** Append-only JSONL writer that maintains the prev_hash chain head. No
 *  update/rewrite path. Appends serialize through a promise chain so concurrent
 *  writes never interleave a partial line OR fork the chain — order IS the chain.
 *  The head is recovered lazily from the file tail, so re-opening an existing
 *  ledger CONTINUES its chain rather than re-genesis-ing it.
 *
 *  SINGLE-WRITER ONLY. The promise chain serializes appends WITHIN one instance;
 *  it does NOT guard against two instances/processes appending concurrently (they
 *  would read the same head and fork the chain on a shared prev_hash). This ledger
 *  is written once by a deterministic seed, so single-writer holds by construction
 *  — but a future concurrent writer needs the advisory flock the spine-ledger uses. */
export class DecisionLedgerWriter {
  private chain: Promise<void> = Promise.resolve()
  private head: string | null = null

  constructor(readonly path: string = CALIBRATION_LEDGER_PATH) {}

  /** Recover the chain head (entry_hash of the last PARSEABLE envelope), or
   *  GENESIS for a missing/empty ledger. A torn FINAL line (a crash mid-append)
   *  is quarantined by walking back to the last parseable line — NOT collapsed to
   *  GENESIS, which would fork a second genesis link and turn the torn tail into
   *  interior corruption. Only a genuinely-absent file (ENOENT) is GENESIS. */
  private async ensureHead(): Promise<void> {
    if (this.head !== null) return
    let raw: string
    try {
      raw = await readFile(this.path, "utf-8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.head = GENESIS_HASH
        return
      }
      throw err // a real read error (EACCES, EISDIR, …) must surface, not silently re-genesis
    }
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const env = JSON.parse(lines[i]) as DecisionForecastEnvelope
        this.head = env.entry_hash
        return
      } catch {
        // torn-tail quarantine: skip the unparseable line, try the one before it
      }
    }
    this.head = GENESIS_HASH
  }

  /** Validate + chain + append one forecast. Resolves with the written envelope.
   *  Rejects on an invalid record or any fs failure — the head is NOT advanced on
   *  failure, so the chain stays intact and the next append retries from the same
   *  link. */
  append(forecast: DecisionForecast): Promise<DecisionForecastEnvelope> {
    try {
      assertDecisionValid(forecast)
    } catch (err) {
      return Promise.reject(err)
    }
    const run = this.chain.then(async () => {
      await this.ensureHead()
      const prevHash = this.head as string
      const canon = canonicalize(forecast) as Record<string, unknown>
      const eh = decisionEntryHash(1, prevHash, canon)
      const envelope: DecisionForecastEnvelope = {
        schema_version: 1,
        prev_hash: prevHash,
        forecast: canon,
        entry_hash: eh,
      }
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, JSON.stringify(envelope) + "\n", { encoding: "utf-8", flush: true })
      this.head = eh
      return envelope
    })
    this.chain = run.then(
      () => {},
      () => {},
    )
    return run
  }
}

export function parseDecisionEnvelopeLine(line: string): DecisionForecastEnvelope {
  const env = JSON.parse(line) as DecisionForecastEnvelope
  if (env.schema_version !== 1) {
    throw new Error(`calibration-ledger: unexpected schema_version ${String(env.schema_version)}`)
  }
  if (typeof env.prev_hash !== "string" || typeof env.entry_hash !== "string") {
    throw new Error("calibration-ledger: envelope missing prev_hash/entry_hash")
  }
  return env
}

export interface DecisionReadResult {
  envelopes: DecisionForecastEnvelope[]
  /** A torn final line was skipped (crash mid-append) — informational. */
  corrupt_tail: boolean
}

/** Read the ledger into envelopes. A torn FINAL line is quarantined (skipped); a
 *  corrupt line that is NOT the tail throws (real corruption). Missing file ⇒ []. */
export async function readCalibrationLedger(
  path: string = CALIBRATION_LEDGER_PATH,
): Promise<DecisionReadResult> {
  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch {
    return { envelopes: [], corrupt_tail: false }
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
  const envelopes: DecisionForecastEnvelope[] = []
  let corruptTail = false
  for (let i = 0; i < lines.length; i++) {
    try {
      envelopes.push(parseDecisionEnvelopeLine(lines[i]))
    } catch (err) {
      if (i === lines.length - 1) {
        corruptTail = true
        break
      }
      throw new Error(`calibration-ledger: corrupt envelope at line ${i} (not the tail): ${String(err)}`)
    }
  }
  return { envelopes, corrupt_tail: corruptTail }
}

export interface DecisionChainVerification {
  valid: boolean
  length: number
  brokenAt: number | null
  reason: string | null
}

/** Optional external anchor. WITHOUT it, a hash chain detects INTERIOR mutation
 *  and reordering, but NOT suffix truncation (deleting the last k records leaves a
 *  valid prefix) NOR a full rewrite with recomputed hashes (the chain is internally
 *  consistent). Pin `expectedHead` (the committed head entry_hash) and/or
 *  `expectedLength` — committed separately (e.g. in CALIBRATION.md / a manifest) —
 *  to upgrade "chain-consistent" to "tamper-evident against truncation + rewrite". */
export interface ChainAnchor {
  expectedHead?: string
  expectedLength?: number
}

/** Replay from genesis: every envelope's prev_hash must equal the prior
 *  envelope's entry_hash (GENESIS for the first), AND each entry_hash must
 *  recompute from its stored { schema_version, prev_hash, forecast }. A lost
 *  (interior), duplicated, reordered, or tampered record breaks the replay. With
 *  an `anchor`, a truncated suffix or a recomputed full rewrite is ALSO caught. */
export function verifyCalibrationChain(
  envelopes: DecisionForecastEnvelope[],
  anchor: ChainAnchor = {},
): DecisionChainVerification {
  let prev = GENESIS_HASH
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]
    if (env.prev_hash !== prev) {
      return { valid: false, length: envelopes.length, brokenAt: i, reason: `prev_hash break at index ${i}` }
    }
    const recomputed = decisionEntryHash(1, env.prev_hash, env.forecast)
    if (recomputed !== env.entry_hash) {
      return {
        valid: false,
        length: envelopes.length,
        brokenAt: i,
        reason: `entry_hash mismatch at index ${i} (record tampered)`,
      }
    }
    prev = env.entry_hash
  }
  // External-anchor checks (catch what a self-consistent chain cannot).
  if (anchor.expectedLength !== undefined && envelopes.length !== anchor.expectedLength) {
    return {
      valid: false,
      length: envelopes.length,
      brokenAt: null,
      reason: `length ${envelopes.length} ≠ expected ${anchor.expectedLength} (suffix truncated/extended)`,
    }
  }
  if (anchor.expectedHead !== undefined && prev !== anchor.expectedHead) {
    return {
      valid: false,
      length: envelopes.length,
      brokenAt: null,
      reason: `head ${prev.slice(0, 12)}… ≠ expected ${anchor.expectedHead.slice(0, 12)}… (rewritten/truncated)`,
    }
  }
  return { valid: true, length: envelopes.length, brokenAt: null, reason: null }
}

/** Decode a canonicalized envelope back into a typed DecisionForecast. All
 *  DecisionForecast fields are JSON-native (no bigint), so this is a typed cast +
 *  a validity check. */
export function decisionFromEnvelope(env: DecisionForecastEnvelope): DecisionForecast {
  const f = env.forecast as unknown as DecisionForecast
  assertDecisionValid(f)
  return f
}

export interface LedgerVerification extends DecisionChainVerification {
  /** True iff every record ALSO passes assertDecisionValid (Brier invariant,
   *  enum sanity). A hash-consistent chain can still carry a semantically invalid
   *  record (e.g. `insufficient` with a non-null brier) — chain-valid ≠ valid. */
  semantically_valid: boolean
  semantic_reason: string | null
}

/** Combined gate: the hash chain (optionally anchored) AND the semantic validity
 *  of every record. Use this — not bare verifyCalibrationChain — when reading a
 *  ledger from disk before trusting its contents. */
export function verifyCalibrationLedger(
  envelopes: DecisionForecastEnvelope[],
  anchor: ChainAnchor = {},
): LedgerVerification {
  const chain = verifyCalibrationChain(envelopes, anchor)
  let semantically_valid = true
  let semantic_reason: string | null = null
  for (let i = 0; i < envelopes.length; i++) {
    try {
      assertDecisionValid(envelopes[i].forecast as unknown as DecisionForecast)
    } catch (err) {
      semantically_valid = false
      semantic_reason = `record ${i}: ${err instanceof Error ? err.message : String(err)}`
      break
    }
  }
  return { ...chain, valid: chain.valid && semantically_valid, semantically_valid, semantic_reason }
}
