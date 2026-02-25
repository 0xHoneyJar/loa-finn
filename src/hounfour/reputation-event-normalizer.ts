// src/hounfour/reputation-event-normalizer.ts — ReputationEvent Normalizer (Sprint 133 Task 2.1)
//
// Schema-validated normalizer for the 4-variant ReputationEvent discriminated union.
// Uses KnownFoo pattern (Sprint 6 T-6.1): closed inner function with never exhaustiveness
// check + open wrapper with Set guard for forward-compatible unknown variant handling.

import { Value } from "@sinclair/typebox/value"
import { ReputationEventSchema, type ReputationEvent } from "@0xhoneyjar/loa-hounfour/governance"
import "./typebox-formats.js" // Register uuid/date-time formats for Value.Check
import { assertFormatsRegistered } from "./typebox-formats.js"

// --- KnownFoo Pattern: Known Reputation Event Types (T-6.1) ---

/** The 4 known variant discriminators as a const array. */
const KNOWN_REPUTATION_EVENT_TYPE_LIST = [
  "quality_signal",
  "task_completed",
  "credential_update",
  "model_performance",
] as const

/** Closed type union of known event types. */
export type KnownReputationEventType = (typeof KNOWN_REPUTATION_EVENT_TYPE_LIST)[number]

/** Set guard for O(1) membership check at the open boundary. */
export const KNOWN_REPUTATION_EVENT_TYPES: ReadonlySet<string> = new Set(KNOWN_REPUTATION_EVENT_TYPE_LIST)

// --- Types ---

export type ReputationEventType = KnownReputationEventType | string

export interface NormalizedReputationEvent {
  type: ReputationEventType
  /** Event recognized as a valid protocol variant */
  recognized: boolean
  /** Event can be metered for billing/reputation purposes */
  metered: boolean
}

// --- Inner: Closed exhaustive normalizer (KnownFoo pattern) ---

/**
 * Normalize a known ReputationEvent type with exhaustive switch + never check.
 * This inner function operates in the CLOSED type space where all variants are known.
 */
function normalizeKnownEvent(type: KnownReputationEventType): NormalizedReputationEvent {
  switch (type) {
    case "quality_signal":
      return { type: "quality_signal", recognized: true, metered: true }
    case "task_completed":
      return { type: "task_completed", recognized: true, metered: true }
    case "credential_update":
      return { type: "credential_update", recognized: true, metered: true }
    case "model_performance":
      return { type: "model_performance", recognized: true, metered: true }
    default: {
      const _exhaustive: never = type
      throw new Error(`Unhandled KnownReputationEventType: ${_exhaustive}`)
    }
  }
}

// --- Outer: Open normalizer with Set guard ---

/**
 * Normalize a ReputationEvent from unknown input.
 * Validates against ReputationEventSchema, then dispatches via KnownFoo pattern:
 * known types go through exhaustive inner function, unknown types return a
 * structured fallback without throwing.
 *
 * @throws Error if input fails schema validation (structure invalid)
 */
export function normalizeReputationEvent(event: unknown): NormalizedReputationEvent {
  // Belt-and-suspenders guard: ensure required formats are registered before Value.Check.
  // Without format registration, Value.Check silently passes invalid UUIDs/date-times.
  assertFormatsRegistered(["uuid", "date-time"])

  if (!Value.Check(ReputationEventSchema, event)) {
    const errors = [...Value.Errors(ReputationEventSchema, event)]
    throw new Error(
      `Invalid ReputationEvent: ${errors.map((e) => `${e.path}: ${e.message}`).join(", ")}`,
    )
  }

  const validated = event as ReputationEvent
  const eventType = validated.type

  // Set guard: known types → exhaustive inner function
  if (KNOWN_REPUTATION_EVENT_TYPES.has(eventType)) {
    return normalizeKnownEvent(eventType as KnownReputationEventType)
  }

  // Unknown type: schema-valid but not yet recognized by this code version.
  // Return structured fallback without throwing — forward-compatible.
  return { type: eventType, recognized: false, metered: false }
}
