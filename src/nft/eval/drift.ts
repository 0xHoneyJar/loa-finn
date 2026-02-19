// src/nft/eval/drift.ts — Personality Drift Analysis (Sprint 16 Task 16.4)
//
// Computes drift between dAPM fingerprints across personality versions.
// Drift = sum of absolute dial deltas across all 96 dials.

import { DAPM_DIAL_IDS, type DAPMFingerprint, type DAPMDialId } from "../signal-types.js"
import type { PersonalityVersion } from "../signal-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single dial change entry */
export interface DialChange {
  dial_id: DAPMDialId
  old_value: number
  new_value: number
  delta: number
}

/** Result of a drift computation between two fingerprints */
export interface DriftResult {
  /** Sum of absolute deltas across all 96 dials */
  total_drift: number
  /** Number of dials compared */
  dial_count: number
  /** Mean absolute drift per dial */
  mean_drift: number
  /** Maximum single-dial drift */
  max_drift: number
  /** Top N most-changed dials, sorted by absolute delta descending */
  top_changed: DialChange[]
}

/** Result of analyzing drift across a version chain */
export interface VersionChainDrift {
  /** Number of version transitions analyzed */
  transition_count: number
  /** Drift result for each consecutive pair */
  transitions: Array<{
    from_version: string
    to_version: string
    drift: DriftResult
  }>
  /** Cumulative drift across all transitions */
  cumulative_drift: number
  /** Average drift per transition */
  mean_transition_drift: number
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Compute drift between two dAPM fingerprints.
 * Drift is the sum of absolute deltas across all 96 dials.
 *
 * @param fingerprintA - First fingerprint (baseline)
 * @param fingerprintB - Second fingerprint (comparison)
 * @returns DriftResult with total, mean, max drift and top changed dials
 */
export function computeDrift(
  fingerprintA: DAPMFingerprint,
  fingerprintB: DAPMFingerprint,
): DriftResult {
  const changes: DialChange[] = []
  let totalDrift = 0
  let maxDrift = 0

  for (const dialId of DAPM_DIAL_IDS) {
    const oldVal = fingerprintA.dials[dialId] ?? 0
    const newVal = fingerprintB.dials[dialId] ?? 0
    const delta = Math.abs(newVal - oldVal)

    totalDrift += delta
    if (delta > maxDrift) maxDrift = delta

    changes.push({
      dial_id: dialId,
      old_value: oldVal,
      new_value: newVal,
      delta,
    })
  }

  const dialCount = DAPM_DIAL_IDS.length
  const meanDrift = dialCount > 0 ? totalDrift / dialCount : 0

  // Sort by delta descending for top_changed
  changes.sort((a, b) => b.delta - a.delta)

  return {
    total_drift: totalDrift,
    dial_count: dialCount,
    mean_drift: meanDrift,
    max_drift: maxDrift,
    top_changed: changes.slice(0, 10), // default top 10
  }
}

/**
 * Get the top N most-changed dials between two fingerprints.
 *
 * @param fingerprintA - First fingerprint (baseline)
 * @param fingerprintB - Second fingerprint (comparison)
 * @param topN - Number of top changed dials to return (default: 10)
 * @returns Array of DialChange entries sorted by absolute delta descending
 */
export function getTopChangedDials(
  fingerprintA: DAPMFingerprint,
  fingerprintB: DAPMFingerprint,
  topN = 10,
): DialChange[] {
  const changes: DialChange[] = []

  for (const dialId of DAPM_DIAL_IDS) {
    const oldVal = fingerprintA.dials[dialId] ?? 0
    const newVal = fingerprintB.dials[dialId] ?? 0
    const delta = Math.abs(newVal - oldVal)

    changes.push({
      dial_id: dialId,
      old_value: oldVal,
      new_value: newVal,
      delta,
    })
  }

  changes.sort((a, b) => b.delta - a.delta)
  return changes.slice(0, topN)
}

/**
 * Analyze drift across a chain of personality versions.
 * Computes drift between each consecutive pair of versions that have dAPM fingerprints.
 *
 * @param versions - Array of PersonalityVersion records, ordered chronologically
 * @returns VersionChainDrift with per-transition and cumulative drift
 */
export function analyzeDrift(versions: PersonalityVersion[]): VersionChainDrift {
  const transitions: VersionChainDrift["transitions"] = []
  let cumulativeDrift = 0

  // Filter to versions that have dAPM fingerprints
  const withFingerprints = versions.filter(
    (v): v is PersonalityVersion & { dapm_fingerprint: DAPMFingerprint } =>
      v.dapm_fingerprint !== null && v.dapm_fingerprint !== undefined,
  )

  for (let i = 1; i < withFingerprints.length; i++) {
    const prev = withFingerprints[i - 1]
    const curr = withFingerprints[i]

    const drift = computeDrift(prev.dapm_fingerprint, curr.dapm_fingerprint)
    cumulativeDrift += drift.total_drift

    transitions.push({
      from_version: prev.version_id,
      to_version: curr.version_id,
      drift,
    })
  }

  return {
    transition_count: transitions.length,
    transitions,
    cumulative_drift: cumulativeDrift,
    mean_transition_drift: transitions.length > 0
      ? cumulativeDrift / transitions.length
      : 0,
  }
}
