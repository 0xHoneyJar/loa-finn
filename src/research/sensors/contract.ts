// src/research/sensors/contract.ts — the shared kernel of the sensor bounded
// context (bd-8ywq.8 · Agent R&D Lab V1 · Acceptance Contract G).
//
// Two seam-level primitives that BOTH shims (grok, dune) and the registry
// (index.ts) depend on. Kept here — not in index.ts — so the registry can
// import the shims and the shims can import these without a value-level import
// cycle (index → grok → contract is acyclic; index → grok → index is not).
//
// WHY a typed-unavailable is a THROW, not a silent return: the one hard gate
// (spec § "Quality Rules") is that absent infra is "typed-unavailable, never a
// silent failure". A shim whose infra is missing (no XAI_API_KEY, no dune-meter
// binary) raises `SensorUnavailableError` — a `ResearchSensorError` subclass
// with ZERO partial spend. Routed through the probe's cost gate
// (`runMeteredResearch`), that records a first-class TYPED FAILURE atom
// (error_class "SensorUnavailableError", cost 0) and re-throws — so an
// unavailable sensor is metered + auditable, never a quiet no-op or a fake
// finding. `<sensor>Availability()` is the pure, zero-call predicate the caller
// can check up front (V2-ready: the `reason` documents what wiring is missing).

import { ResearchSensorError } from "../cost-atom-research.js"
import type { ResearchSensor } from "../schemas/index.js"

/** The pure availability verdict for a sensor's backing infra. Computed with
 *  ZERO calls and ZERO spend (an env read / a filesystem `existsSync`, no
 *  network, no subprocess). `available:false` carries a human `reason` that
 *  names exactly what V2 wiring is missing. */
export type SensorAvailability =
  | { available: true }
  | { available: false; reason: string }

/** Raised by a shim when its backing infra is absent (key-gated scaffold with
 *  no key / Asson-CLI scaffold with no binary). It extends `ResearchSensorError`
 *  with `partial_micro` 0, so the probe's cost gate writes a typed `failure`
 *  atom (no gap in the chain) and surfaces NO finding — the spec's
 *  "typed-unavailable, never a silent failure" made mechanical. */
export class SensorUnavailableError extends ResearchSensorError {
  constructor(
    readonly sensor: ResearchSensor,
    readonly detail: string,
  ) {
    super(`sensor "${sensor}" unavailable: ${detail}`, 0n)
    this.name = "SensorUnavailableError"
  }
}
