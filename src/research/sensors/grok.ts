// src/research/sensors/grok.ts — the Grok SIGINT sensor: a THIN SHIM over the
// Cheval xai seam (bd-8ywq.8 · Agent R&D Lab V1 · spec § Sensors item 3,
// Acceptance Contract G).
//
// Grok is the real-time / X-firehose nowcasting half (SIGINT) to Gemini's
// strategic OSINT. Per Contract G the shim contains NO provider logic of its
// own: it reaches a model ONLY through the Cheval invoker interface (the LLM
// seam). There is deliberately no direct provider HTTP call here — that lives
// INSIDE Cheval (an xai provider / grok-headless binding is a Cheval/loa-side
// addition). This file therefore never imports an HTTP client and never names a
// provider host; the boundary scanner in ./index.ts enforces that statically.
//
// KEY-GATED SCAFFOLD (operator decision 3): grok is wired now, designed
// iteratively. Gating, in order, both ZERO-call and ZERO-spend:
//   1. no XAI_API_KEY            → typed-unavailable (V2-ready; nothing to wire to)
//   2. key present, no xai route → typed-unavailable (finn cheval = anthropic/
//      google/openai; there is no xai provider, so the seam is scaffolded and the
//      real adapter is a Cheval/loa-side addition — surfaced cleanly, not faked)
//   3. key + a wired route       → route via Cheval (provider_intended = "xai")
// Availability is a pure predicate; the SensorFn raises `SensorUnavailableError`
// (cost 0) on 1–2, so the probe meters a typed failure and surfaces no finding.

import type { Citation, ModelinvRef } from "../schemas/index.js"
import type { SensorFn, SensorInput, SensorOutput } from "../probe.js"
import { SensorUnavailableError, type SensorAvailability } from "./contract.js"

/** What a Cheval xai route returns to the shim. The shim maps this onto a
 *  `SensorOutput`; it never constructs a provider request itself. */
export interface ChevalXaiResult {
  /** The model's answer — becomes the finding. */
  content: string
  /** SIGINT sources Cheval surfaced (real-time refs), if any. The probe's
   *  grounding gate validates these — the shim does not pre-judge them. */
  citations?: Citation[]
  /** Contract B honesty: what Cheval ACTUALLY served. A fallback to a different
   *  provider is surfaced here and classed `routing_fallback` by the probe —
   *  never counted as evidence the intended provider works. Defaults to "xai". */
  provider_resolved?: string
  /** The MODELINV dedup link — Cheval-routed LLM spend is already metered by
   *  MODELINV, so the research atom REFERENCES it instead of re-charging
   *  inference (Contract E #4). When set, inference is booked there, not here. */
  modelinv_ref?: ModelinvRef | null
  /** Inference micro-USD charged to the RESEARCH ledger — used ONLY when the
   *  call is NOT metered by MODELINV (`modelinv_ref` null). Integer micro-USD. */
  inference_micro?: bigint
}

/** The single function through which grok reaches a model — the Cheval xai seam.
 *  Production binds this to the Cheval invoker (an xai provider / grok-headless
 *  binding, a loa-side V2 addition). Tests inject a mock — no real model call,
 *  no spend. Its absence (`undefined`) IS the "seam scaffolded" signal. */
export type ChevalXaiRoute = (input: {
  question: string
  freshness_max_age?: number
  signal?: AbortSignal
}) => Promise<ChevalXaiResult>

export interface GrokSensorDeps {
  /** Reads the gating key. Default: `process.env.XAI_API_KEY`. ZERO calls. */
  getApiKey?: () => string | undefined
  /** The Cheval xai route — the ONLY path grok reaches a model. UNSET ⇒ the seam
   *  is scaffolded (finn cheval has no xai provider), so grok is cleanly
   *  unavailable even WITH a key. V2 wires this loa-side; tests inject a mock. */
  chevalRoute?: ChevalXaiRoute
}

/** Default key reader — the env var the seam is gated on. */
function defaultXaiKey(): string | undefined {
  return process.env.XAI_API_KEY
}

/** Pure, zero-call availability of the grok SIGINT seam. The `reason` documents
 *  exactly what V2 wiring is missing (key vs. xai provider). */
export function grokAvailability(deps: GrokSensorDeps = {}): SensorAvailability {
  const key = (deps.getApiKey ?? defaultXaiKey)()
  if (!key) {
    return {
      available: false,
      reason:
        "XAI_API_KEY not set — grok SIGINT is a key-gated scaffold (V2-ready); zero calls, zero spend",
    }
  }
  if (!deps.chevalRoute) {
    return {
      available: false,
      reason:
        "no xai provider wired in cheval (finn cheval = anthropic/google/openai) — the xai seam is scaffolded; the real adapter is a Cheval/loa-side addition (V2-ready)",
    }
  }
  return { available: true }
}

/** Build the Grok SIGINT SensorFn. When unavailable it raises
 *  `SensorUnavailableError` (cost 0, zero calls) BEFORE any routing — so the
 *  probe meters a typed failure and surfaces no finding. When available it routes
 *  ONLY through the injected Cheval xai seam (`provider_intended` = "xai"); the
 *  research ledger never double-charges inference that MODELINV already metered. */
export function makeGrokSensor(deps: GrokSensorDeps = {}): SensorFn {
  return async (input: SensorInput): Promise<SensorOutput> => {
    const avail = grokAvailability(deps)
    if (!avail.available) {
      throw new SensorUnavailableError("grok", avail.reason)
    }
    // grokAvailability guarantees a route here.
    const route = deps.chevalRoute as ChevalXaiRoute
    const res = await route({
      question: input.question,
      freshness_max_age: input.freshness_max_age,
      signal: input.signal,
    })

    const metered = res.modelinv_ref != null
    const inference = metered ? 0n : (res.inference_micro ?? 0n)
    return {
      finding: res.content,
      citations: res.citations ?? [],
      cost_micro: inference,
      inference_micro: inference,
      modelinv_ref: res.modelinv_ref ?? null,
      provider_intended: "xai",
      provider_resolved: res.provider_resolved ?? "xai",
    }
  }
}
