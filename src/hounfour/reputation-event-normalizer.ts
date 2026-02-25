// src/hounfour/reputation-event-normalizer.ts — ReputationEvent Normalizer (Sprint 133 Task 2.1)
//
// Schema-validated normalizer for the 4-variant ReputationEvent discriminated union.
// Accepts unknown input, validates with Value.Check before switch.

import { Value } from "@sinclair/typebox/value"
import { ReputationEventSchema, type ReputationEvent } from "@0xhoneyjar/loa-hounfour/governance"
import "./typebox-formats.js" // Register uuid/date-time formats for Value.Check

// --- Types ---

export type ReputationEventType =
  | "quality_signal"
  | "task_completed"
  | "credential_update"
  | "model_performance"

export interface NormalizedReputationEvent {
  type: ReputationEventType
  /** Event recognized as a valid protocol variant */
  recognized: boolean
  /** Event can be metered for billing/reputation purposes */
  metered: boolean
}

// --- Normalizer ---

/**
 * Normalize a ReputationEvent from unknown input.
 * Validates against ReputationEventSchema before dispatching.
 *
 * @throws Error if input fails schema validation
 */
export function normalizeReputationEvent(event: unknown): NormalizedReputationEvent {
  if (!Value.Check(ReputationEventSchema, event)) {
    const errors = [...Value.Errors(ReputationEventSchema, event)]
    throw new Error(
      `Invalid ReputationEvent: ${errors.map((e) => `${e.path}: ${e.message}`).join(", ")}`,
    )
  }

  const validated = event as ReputationEvent
  switch (validated.type) {
    case "quality_signal":
      return { type: "quality_signal", recognized: true, metered: true }
    case "task_completed":
      return { type: "task_completed", recognized: true, metered: true }
    case "credential_update":
      return { type: "credential_update", recognized: true, metered: true }
    case "model_performance":
      return { type: "model_performance", recognized: true, metered: true }
    default: {
      // Schema validation passed but type is unrecognized — should never happen
      // unless the schema adds new variants that this code hasn't been updated for.
      const _exhaustive: never = validated
      throw new Error(
        `Unhandled ReputationEvent type after schema validation: ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}
