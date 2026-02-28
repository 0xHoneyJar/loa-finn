// src/billing/governed-billing.ts — GovernedResource<T> Type Conformance (T-3.4)
//
// Type-level proof that the billing state machine conforms to GovernedResource<T>.
// Extends GovernedResourceBase from hounfour v8.3.0 with billing-specific types.
// Not wired into production — demonstrates conformance path for future adoption.
//
// @see SDD §4.8 — FR-8 GovernedResource<T> Runtime Interface Extraction

import type { BillingEntry, BillingEventType } from "./types.js"
import { BillingState, VALID_TRANSITIONS } from "./types.js"
import {
  GovernedResourceBase,
  type InvariantResult,
  type MutationContext,
} from "../hounfour/protocol-types.js"

// ---------------------------------------------------------------------------
// Billing Invariant IDs — string literal union for GovernedResource<T>
// ---------------------------------------------------------------------------

export type BillingInvariantId =
  | "cost_non_negative"
  | "valid_state"
  | "reserve_conservation"

// ---------------------------------------------------------------------------
// GovernedBilling — extends GovernedResourceBase<BillingEntry, BillingEventType>
// ---------------------------------------------------------------------------

/**
 * Governed billing resource — proves BillingEntry + BillingEventType conform
 * to the GovernedResource<T> interface from hounfour v8.3.0.
 *
 * This class is a type-level conformance proof. It is NOT wired into the
 * production billing pipeline. The existing BillingStateMachine remains the
 * runtime implementation; this demonstrates the upgrade path for future
 * GovernedResource adoption.
 *
 * Concrete adoption would replace BillingStateMachine's direct state mutation
 * with GovernedResourceBase's event-sourced transition + invariant verification.
 */
export class GovernedBilling extends GovernedResourceBase<
  BillingEntry,
  BillingEventType,
  BillingInvariantId
> {
  readonly resourceId: string
  readonly resourceType = "billing_entry" as const

  constructor(entryId: string, initialState: BillingEntry) {
    super(initialState)
    this.resourceId = entryId
  }

  // --- Abstract method: pure state transition logic ---

  protected applyEvent(
    state: BillingEntry,
    event: BillingEventType,
    _context: MutationContext,
  ): BillingEntry {
    // Map event type to target state
    const TARGET_STATE: Partial<Record<BillingEventType, BillingState>> = {
      billing_reserve: BillingState.RESERVE_HELD,
      billing_commit: BillingState.FINALIZE_PENDING,
      billing_release: BillingState.RELEASED,
      billing_void: BillingState.VOIDED,
      billing_finalize_ack: BillingState.FINALIZE_ACKED,
      billing_finalize_fail: BillingState.FINALIZE_FAILED,
    }

    const targetState = TARGET_STATE[event]
    if (!targetState) return state

    const valid = VALID_TRANSITIONS[state.state]
    if (!valid.includes(targetState)) return state

    return { ...state, state: targetState, updated_at: Date.now() }
  }

  // --- Abstract method: invariant definitions ---

  protected defineInvariants(): Map<
    BillingInvariantId,
    (state: BillingEntry) => InvariantResult
  > {
    const invariants = new Map<
      BillingInvariantId,
      (state: BillingEntry) => InvariantResult
    >()

    invariants.set("cost_non_negative", (s) => ({
      invariantId: "cost_non_negative",
      holds:
        Number(s.estimated_cost) >= 0 &&
        (s.actual_cost === null || Number(s.actual_cost) >= 0),
    }))

    invariants.set("valid_state", (s) => ({
      invariantId: "valid_state",
      holds: Object.values(BillingState).includes(s.state),
    }))

    invariants.set("reserve_conservation", (s) => ({
      invariantId: "reserve_conservation",
      holds:
        s.actual_cost === null ||
        Number(s.actual_cost) <= Number(s.estimated_cost),
      detail:
        s.actual_cost !== null &&
        Number(s.actual_cost) > Number(s.estimated_cost)
          ? `actual ${s.actual_cost} > estimated ${s.estimated_cost}`
          : undefined,
    }))

    return invariants
  }

  // --- Abstract method: post-transition hook (audit trail append) ---

  protected async onTransitionSuccess(
    _event: BillingEventType,
    _context: MutationContext,
    _previousState: BillingEntry,
    _newState: BillingEntry,
    _version: number,
  ): Promise<void> {
    // Conformance proof only — production adoption would append to
    // WAL audit trail and mutation log here.
  }
}
