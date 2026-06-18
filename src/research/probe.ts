// src/research/probe.ts — the reality-grounded research probe (bd-8ywq.7 ·
// Agent R&D Lab V1 · Acceptance Contracts A, B, C, D + spec §2).
//
// The lab's core instrument: probe(question) → a metered, grounded, attributed
// finding, or an honest abstention. It is a THIN ORCHESTRATOR over two seams we
// already own — NOT a bespoke adapter:
//   · the .6 cost gate (runMeteredResearch + ResearchAtomWriter) — the closure
//     that holds the CostAtom handle, so closes-before-return is STRUCTURAL.
//   · the Gemini OSINT sensor = k-hole's dig-search.ts, shelled (npx tsx).
//
// The one hard gate (spec): NO un-metered, un-grounded finding can escape.
//   · un-metered  — impossible: the finding is the resolved value of
//                   runMeteredResearch, which closes the hash-chained CostAtom
//                   BEFORE it returns. There is no code path to a finding
//                   without a closed atom (Contract A, inherited from .6).
//   · un-grounded — the grounding gate (Contract D) validates citation QUALITY
//                   (linkrot · circular · freshness · confidence), not count.
//                   Zero valid citations → INSUFFICIENT, finding withheld
//                   (`null`), never asserted (the deterministic-layers law).
//
// Provider honesty (Contract B): the atom records provider_intended +
// provider_resolved; a mismatch is `routing_fallback` — surfaced but NEVER
// counted as evidence the intended provider works, and never landed as a claim.
// Gemini-via-dig-search is a DIRECT path (intended === resolved === "gemini").
// The full Cheval xai (grok) wiring is .8; the field + assertion helper land now.
//
// Durable spine (Contract C): a claimed finding lands a `claimed`-tier bet on
// the append-only, advisory-flock'd, fsync'd JSONL ledger (spine-ledger.ts).
// This module NEVER touches observatory/spine-data.json.
//
// SENSOR BOUNDARY (spec Contract G): probe.ts calls ONLY the stable SensorFn
// seam — zero direct provider API calls. The Gemini sensor shells dig-search;
// grok/dune are registered-but-not-wired (.8 graduates them via Cheval / Asson).
// Tests MUST inject `sensorImpl` (the mock body) — no real dig-search / Gemini
// call ever runs during build or test (no real spend).

import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ResearchAtomWriter,
  ResearchSensorError,
  atomTotalMicro,
  decodeAtom,
  questionHash,
  runMeteredResearch,
} from "./cost-atom-research.js"
import { makeRegisteredSensor } from "./sensors/index.js"
import { SPINE_EVENTS_PATH, SpineEventWriter } from "./spine-ledger.js"
import type {
  Citation,
  ModelinvRef,
  ResearchAtomEnvelope,
  ResearchSensor,
  ResearchSpineEvent,
} from "./schemas/index.js"

// ---------------------------------------------------------------------------
// Default ledger paths (configurable per-call).
// ---------------------------------------------------------------------------

/** Default research-atom (cost) ledger path. */
export const RESEARCH_ATOM_LEDGER_PATH = "src/research/research-atoms.jsonl"
export { SPINE_EVENTS_PATH }

// ---------------------------------------------------------------------------
// The sensor seam — a SensorFn is the ONLY thing probe.ts calls. Provider-
// specific code lives INSIDE the sensor (the Gemini sensor shells dig-search;
// grok/dune graduate via Cheval / Asson in .8). Tests inject a mock SensorFn.
// ---------------------------------------------------------------------------

export interface SensorInput {
  question: string
  /** Max citation age (ms) the caller will accept — threaded for sensors that
   *  can scope their search; the grounding gate also enforces it. */
  freshness_max_age?: number
  now: () => number
  signal?: AbortSignal
}

export interface SensorOutput {
  finding: string
  citations: Citation[]
  /** Actual cost charged to the RESEARCH ledger, integer micro-USD. 0 for the
   *  subscription Gemini path (no marginal spend). When the LLM spend is metered
   *  by MODELINV (Cheval routes, .8), this excludes inference (see modelinv_ref). */
  cost_micro: bigint
  /** Inference portion of cost_micro. MUST be 0 when modelinv_ref is set. */
  inference_micro?: bigint
  modelinv_ref?: ModelinvRef | null
  /** Provider honesty (Contract B): what the sensor ASKED for vs what answered. */
  provider_intended: string
  provider_resolved: string
}

export type SensorFn = (input: SensorInput) => Promise<SensorOutput>

// ---------------------------------------------------------------------------
// Provider-resolution honesty — Contract B.
// ---------------------------------------------------------------------------

/** Raised when a result is treated as evidence the INTENDED provider works but
 *  a different provider actually served it (the 0/758-Bedrock map/territory
 *  trap). The probe never throws this itself — it routes to a `routing_fallback`
 *  finding class — but the Bedrock-premise smoke test calls `assertProviderResolved`. */
export class ProviderResolutionError extends Error {
  constructor(
    readonly intended: string,
    readonly resolved: string,
  ) {
    super(
      `provider resolution mismatch: intended "${intended}", resolved "${resolved}" — a routing fallback is NOT evidence the intended provider works`,
    )
    this.name = "ProviderResolutionError"
  }
}

/** True when Cheval (or any seam) served a different provider than asked for. */
export function isRoutingFallback(intended: string, resolved: string): boolean {
  return intended !== resolved
}

/** Contract B assertion: before declaring the intended provider "tested", assert
 *  it actually served the call. Used by the Bedrock-premise smoke test. */
export function assertProviderResolved(intended: string, resolved: string): void {
  if (isRoutingFallback(intended, resolved)) {
    throw new ProviderResolutionError(intended, resolved)
  }
}

// ---------------------------------------------------------------------------
// Grounding gate — Contract D: citation QUALITY, not count > 0.
// ---------------------------------------------------------------------------

/** Bare registrable domain of a URL (host minus a leading `www.`), or null if
 *  the URL is unparseable. */
export function domainOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h.startsWith("www.") ? h.slice(4) : h
  } catch {
    return null
  }
}

/** Per-citation gate result. `valid` ⇒ this citation COUNTS toward grounding. */
export interface CitationGate {
  citation: Citation
  /** http_status is 2xx (a live, non-rotted link). */
  linkrot_ok: boolean
  /** citation domain ≠ the question's own source domain (not self-citing). */
  circular_ok: boolean
  /** retrieved within freshness_max_age (always true when no max is set). */
  fresh_ok: boolean
  /** confidence is medium/high — only enforced for high-stakes probes. */
  confidence_ok: boolean
  valid: boolean
  /** Which gates failed (for surfacing the INSUFFICIENT reason). */
  reasons: string[]
}

export interface CitationValidation {
  gates: CitationGate[]
  /** Citations that passed every applicable gate — the grounding evidence. */
  valid: Citation[]
  /** valid.length > 0. False ⇒ the probe returns INSUFFICIENT. */
  sufficient: boolean
  /** Human-readable reason when not sufficient, else null. */
  insufficient_reason: string | null
}

export interface ValidateCitationsOptions {
  /** The question's own source URL — citations from THIS domain are circular. */
  question_source_url?: string | null
  /** Max citation age (ms). Unset ⇒ freshness not gated (Contract G: enforced). */
  freshness_max_age?: number
  /** High-stakes ⇒ a low-confidence citation does NOT count (only-low → INSUFFICIENT). */
  high_stakes?: boolean
  now?: () => number
}

/** Validate citations for QUALITY (Contract D). A citation counts only if it is
 *  live (linkrot 2xx), independent (not the question's own domain), fresh
 *  (within freshness_max_age), and — for high-stakes probes — not low-confidence.
 *  Zero counting citations ⇒ INSUFFICIENT. */
export function validateCitations(
  citations: Citation[],
  opts: ValidateCitationsOptions = {},
): CitationValidation {
  const now = opts.now ?? Date.now
  const nowMs = now()
  const sourceDomain = opts.question_source_url ? domainOf(opts.question_source_url) : null

  const gates: CitationGate[] = citations.map((c) => {
    const reasons: string[] = []

    const linkrot_ok = typeof c.http_status === "number" && c.http_status >= 200 && c.http_status < 300
    if (!linkrot_ok) reasons.push("linkrot")

    const cd = domainOf(c.url)
    const circular_ok = sourceDomain == null || cd == null || cd !== sourceDomain
    if (!circular_ok) reasons.push("circular")

    let fresh_ok = true
    if (opts.freshness_max_age != null) {
      fresh_ok = typeof c.retrieved_ts === "number" && nowMs - c.retrieved_ts <= opts.freshness_max_age
    }
    if (!fresh_ok) reasons.push("stale")

    const confidence_ok = !opts.high_stakes || c.confidence === "medium" || c.confidence === "high"
    if (!confidence_ok) reasons.push("low-confidence")

    const valid = linkrot_ok && circular_ok && fresh_ok && confidence_ok
    return { citation: c, linkrot_ok, circular_ok, fresh_ok, confidence_ok, valid, reasons }
  })

  const valid = gates.filter((g) => g.valid).map((g) => g.citation)
  const sufficient = valid.length > 0

  let insufficient_reason: string | null = null
  if (!sufficient) {
    if (citations.length === 0) {
      insufficient_reason = "zero citations — ungrounded"
    } else {
      const tally = new Map<string, number>()
      for (const g of gates) for (const r of g.reasons) tally.set(r, (tally.get(r) ?? 0) + 1)
      const parts = [...tally.entries()].map(([r, n]) => `${r}×${n}`).join(", ")
      insufficient_reason = `no valid citation among ${citations.length} (failed: ${parts})`
    }
  }

  return { gates, valid, sufficient, insufficient_reason }
}

// ---------------------------------------------------------------------------
// The Gemini OSINT sensor — shells k-hole's dig-search.ts (npx tsx). The ONLY
// wired sensor in .7. NEVER invoked during test (tests inject a mock body).
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..", "..")
const DEFAULT_DIG_SEARCH_PATH = resolve(
  REPO_ROOT,
  ".claude/constructs/packs/k-hole/scripts/dig-search.ts",
)

/** Shape of dig-search's deep-dig stdout blob (the fields the probe consumes). */
interface DigSearchOutput {
  findings?: string
  synthesis?: string
  sources?: { title?: string; url?: string }[]
}

export interface GeminiSensorConfig {
  /** Path to dig-search.ts (default: the k-hole pack script). */
  dig_search_path?: string
  /** Dig depth — 2 is the cheap subscription/flash default (NOT Deep Research). */
  depth?: number
  /** Spawn timeout (ms). */
  timeout_ms?: number
  /** Per-citation linkrot check → HTTP status. Default: a real HEAD probe.
   *  Injectable so the gate's http_status can be populated (or stubbed). */
  link_check?: (url: string) => Promise<number | null>
  /** Confidence stamped on each citation (flash synthesis is `claimed-by-sensor`
   *  — a notch above speculation; default "medium"). */
  default_confidence?: "low" | "medium" | "high"
}

/** Default linkrot probe — a HEAD request, status or null on any failure. Real
 *  network I/O; only ever runs on the PRODUCTION path (tests mock the sensor). */
async function defaultLinkCheck(url: string): Promise<number | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5_000)
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal })
      return res.status
    } finally {
      clearTimeout(t)
    }
  } catch {
    return null
  }
}

/** Build the Gemini OSINT SensorFn that shells dig-search.ts. Direct path:
 *  provider_intended === provider_resolved === "gemini" (subscription, no
 *  marginal spend → cost_micro 0). dig-search's own model fallback is
 *  sub-provider (still Gemini) and below Contract B's provider granularity. */
export function makeGeminiDigSearchSensor(cfg: GeminiSensorConfig = {}): SensorFn {
  const digPath = cfg.dig_search_path ?? DEFAULT_DIG_SEARCH_PATH
  const depth = cfg.depth ?? 2
  const timeoutMs = cfg.timeout_ms ?? 600_000
  const linkCheck = cfg.link_check ?? defaultLinkCheck
  const confidence = cfg.default_confidence ?? "medium"

  return async (input) => {
    const out = await runDigSearch(digPath, input.question, depth, timeoutMs)
    const findingText = (out.findings ?? out.synthesis ?? "").trim()
    const rawSources = (out.sources ?? []).filter((s) => typeof s.url === "string" && s.url)

    const citations: Citation[] = await Promise.all(
      rawSources.map(async (s) => ({
        url: s.url as string,
        retrieved_ts: input.now(),
        http_status: await linkCheck(s.url as string),
        source_type: "osint-gemini",
        claim_support: null,
        confidence,
      })),
    )

    return {
      finding: findingText,
      citations,
      cost_micro: 0n, // subscription — no marginal charge
      inference_micro: 0n,
      modelinv_ref: null,
      provider_intended: "gemini",
      provider_resolved: "gemini",
    }
  }
}

/** Spawn `npx tsx dig-search.ts --query <q> --depth <n>` and parse its stdout
 *  JSON blob. Throws a ResearchSensorError on spawn / non-zero / parse failure
 *  (partial_micro 0 — the subscription path has no marginal spend to record). */
function runDigSearch(
  digPath: string,
  question: string,
  depth: number,
  timeoutMs: number,
): Promise<DigSearchOutput> {
  return new Promise((resolveOut, rejectOut) => {
    const child = spawn(
      "npx",
      ["tsx", digPath, "--query", question, "--depth", String(depth)],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      stdout += d.toString()
    })
    child.stderr.on("data", (d) => {
      stderr += d.toString()
    })
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      rejectOut(new ResearchSensorError(`dig-search timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on("error", (err) => {
      clearTimeout(timer)
      rejectOut(new ResearchSensorError(`dig-search spawn failed: ${err.message}`))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        rejectOut(new ResearchSensorError(`dig-search exited ${code}: ${stderr.slice(-300)}`))
        return
      }
      const firstBrace = stdout.indexOf("{")
      if (firstBrace === -1) {
        rejectOut(new ResearchSensorError("dig-search produced no JSON output"))
        return
      }
      try {
        resolveOut(JSON.parse(stdout.slice(firstBrace)) as DigSearchOutput)
      } catch (err) {
        rejectOut(new ResearchSensorError(`dig-search output parse failed: ${String(err)}`))
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Sensor dispatch (Contract G) — probe.ts reaches a sensor ONLY through the
// stable SensorFn seam. gemini stays the direct dig-search shell wired here;
// grok/dune route through the sensors registry (.8: the Cheval xai shim / the
// Asson dune-meter shim). Absent infra is typed-unavailable, never silent.
// ---------------------------------------------------------------------------

function resolveSensorImpl(sensor: ResearchSensor, override?: SensorFn): SensorFn {
  if (override) return override
  if (sensor === "gemini") return makeGeminiDigSearchSensor()
  return makeRegisteredSensor(sensor)
}

// ---------------------------------------------------------------------------
// The probe orchestrator.
// ---------------------------------------------------------------------------

/** A finding's epistemic class:
 *  - `claimed`          — grounded + provider-attributed → lands on the spine.
 *  - `routing_fallback` — served by a different provider than intended; surfaced
 *                         but NOT evidence the intended provider works, NOT landed.
 *  - `insufficient`     — failed the grounding gate; finding withheld (null). */
export type FindingClass = "claimed" | "routing_fallback" | "insufficient"

export interface ProbeOptions {
  /** Which seam (also the atom's `sensor`). Default "gemini". */
  sensor?: ResearchSensor
  /** Dependency-injected sensor body (tests pass the mock; mirrors .6's okBody).
   *  When set, used instead of the registered impl — no real dig-search runs. */
  sensorImpl?: SensorFn
  /** Max citation age (ms) — threaded to the sensor AND enforced by the gate. */
  freshness_max_age?: number
  /** High-stakes ⇒ only-low-confidence citations → INSUFFICIENT. */
  high_stakes?: boolean
  /** The question's own source URL (circular-citation gate). */
  question_source_url?: string | null
  /** Pre-call estimate → the budget_reservation, surfaced BEFORE the finding. */
  estimate_micro?: bigint
  /** Hard per-probe ceiling (MAX_MICRO_USD_PER_PROBE). Over it ⇒ auto-abort with
   *  ProbeCeilingError AND a terminal failure atom (FIX#1) — no dangling reserve. */
  max_micro_usd_per_probe?: bigint
  atom_writer?: ResearchAtomWriter
  spine_writer?: SpineEventWriter
  atom_ledger_path?: string
  spine_ledger_path?: string
  /** Fired with the estimate BEFORE the finding (Contract D: surface cost first). */
  onCostSurfaced?: (estimate_micro: bigint, sensor: ResearchSensor) => void
  now?: () => number
}

export interface ProbeResult {
  /** The finding — `null` when INSUFFICIENT (never asserted ungrounded). */
  finding: string | null
  finding_class: FindingClass
  /** Every citation the sensor produced (transparency). */
  citations: Citation[]
  /** Citations that passed the grounding gate (the evidence). */
  valid_citations: Citation[]
  grounding: CitationValidation
  /** The closed actual_cost atom (durable BEFORE this result existed). */
  cost_atom: ResearchAtomEnvelope
  /** The budget_reservation atom (estimate, surfaced first). */
  reservation: ResearchAtomEnvelope
  /** Total actual spend this probe represents (research + referenced MODELINV). */
  cost_micro: bigint
  /** The estimate surfaced to the operator before the finding. */
  estimate_micro: bigint
  routing_fallback: boolean
  provider_intended: string
  provider_resolved: string
  /** The claimed-tier spine bet — null for INSUFFICIENT / routing_fallback. */
  spine_event: ResearchSpineEvent | null
}

/** Run one reality-grounded probe under the cost gate + grounding gate.
 *
 *  Order (each gate before the next): surface cost → meter+sense (atom closes
 *  inside runMeteredResearch BEFORE the finding is representable) → validate
 *  citation quality → classify (claimed / routing_fallback / insufficient) →
 *  land the claimed bet on the durable spine. No finding escapes un-metered (the
 *  atom is always closed) or un-grounded (INSUFFICIENT withholds it). */
export async function probe(question: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const now = opts.now ?? Date.now
  const sensorName: ResearchSensor = opts.sensor ?? "gemini"
  const sensorImpl = resolveSensorImpl(sensorName, opts.sensorImpl)
  const atomWriter =
    opts.atom_writer ?? new ResearchAtomWriter(opts.atom_ledger_path ?? RESEARCH_ATOM_LEDGER_PATH)
  const spineWriter =
    opts.spine_writer ?? new SpineEventWriter(opts.spine_ledger_path ?? SPINE_EVENTS_PATH)
  const estimate = opts.estimate_micro ?? 0n
  const ceiling = opts.max_micro_usd_per_probe

  // Contract D: surface the cost BEFORE the finding. The estimate is exactly the
  // budget_reservation value runMeteredResearch is about to write.
  opts.onCostSurfaced?.(estimate, sensorName)

  // The metered body can only return the fixed ResearchBodyResult shape; the
  // probe needs the raw citations, the validation, and the providers too. They
  // are captured in this closure-scoped slot, set BEFORE the body returns — so
  // they exist exactly when (and only when) the atom has closed. Definite-
  // assignment (`!`): runMeteredResearch awaits the body and only resolves after
  // it assigns this; a body throw re-throws, so the post-await reads are reached
  // only when `captured` is set.
  interface Captured {
    rawFinding: string
    allCitations: Citation[]
    validation: CitationValidation
    providerIntended: string
    providerResolved: string
  }
  let captured!: Captured

  // Contract A: the finding is the resolved value of runMeteredResearch — it is
  // representable ONLY after the actual_cost atom is durably appended. A failing
  // sensor re-throws (and writes a typed failure atom); no finding escapes.
  const metered = await runMeteredResearch(
    { writer: atomWriter, sensor: sensorName, question, estimate_micro: estimate, ceiling_micro: ceiling, now },
    async () => {
      const out = await sensorImpl({ question, freshness_max_age: opts.freshness_max_age, now })
      const validation = validateCitations(out.citations, {
        question_source_url: opts.question_source_url ?? null,
        freshness_max_age: opts.freshness_max_age,
        high_stakes: opts.high_stakes,
        now,
      })
      captured = {
        rawFinding: out.finding,
        allCitations: out.citations,
        validation,
        providerIntended: out.provider_intended,
        providerResolved: out.provider_resolved,
      }
      return {
        finding: out.finding,
        // the atom's `grounded` flag reflects the QUALITY gate (valid count),
        // not raw count — Contract D folded into the structural meter.
        citations: validation.valid,
        actual_micro: out.cost_micro,
        inference_micro: out.inference_micro ?? 0n,
        modelinv_ref: out.modelinv_ref ?? null,
        provider_intended: out.provider_intended,
        provider_resolved: out.provider_resolved,
      }
    },
  )

  // captured is set here: the body assigned it before returning, and a body throw
  // re-throws from runMeteredResearch so this is unreachable on failure.
  const cap = captured
  const routing_fallback = isRoutingFallback(cap.providerIntended, cap.providerResolved)
  const sufficient = cap.validation.sufficient

  let finding_class: FindingClass
  let finding: string | null
  if (!sufficient) {
    finding_class = "insufficient" // ungrounded → abstain over fabricate
    finding = null
  } else if (routing_fallback) {
    finding_class = "routing_fallback" // surfaced, but not evidence the intended provider works
    finding = cap.rawFinding
  } else {
    finding_class = "claimed"
    finding = cap.rawFinding
  }

  // Contract C: only a genuinely CLAIMED finding enters the Ledger of Bets.
  // INSUFFICIENT (ungrounded) and routing_fallback (un-attributable) findings do
  // not land as claims — the spine stays honest.
  const actualAtomId = metered.actual.atom.atom_id as string
  let spine_event: ResearchSpineEvent | null = null
  if (finding_class === "claimed") {
    spine_event = await spineWriter.append({
      kind: "probe",
      tier: "claimed",
      sensor: sensorName,
      question_hash: questionHash(question),
      finding: cap.rawFinding,
      citations: cap.validation.valid,
      cost_atom_ref: actualAtomId,
      ts: now(),
    })
  }

  return {
    finding,
    finding_class,
    citations: cap.allCitations,
    valid_citations: cap.validation.valid,
    grounding: cap.validation,
    cost_atom: metered.actual,
    reservation: metered.reservation,
    cost_micro: atomTotalMicro(decodeAtom(metered.actual.atom)),
    estimate_micro: estimate,
    routing_fallback,
    provider_intended: cap.providerIntended,
    provider_resolved: cap.providerResolved,
    spine_event,
  }
}
