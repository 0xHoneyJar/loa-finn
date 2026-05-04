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
// Shadow Comparison Result — T-5.1 / T-5.2 (Sprint 5)
// ---------------------------------------------------------------------------

export interface ShadowCompareResult {
  shadowState: BillingState
  invariants: {
    cost_non_negative: boolean
    valid_state: boolean
    reserve_conservation: boolean
  }
  allHold: boolean
}

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

    // billing_commit validates against COMMITTED (intermediate state) but
    // produces FINALIZE_PENDING — matching BillingStateMachine's collapsed step
    // where commit() validates RESERVE_HELD→COMMITTED then sets FINALIZE_PENDING.
    const validationTarget =
      event === "billing_commit" ? BillingState.COMMITTED : targetState

    const valid = VALID_TRANSITIONS[state.state]
    if (!valid.includes(validationTarget)) return state

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

  // --- Shadow comparison (T-5.1 / T-5.2) ---

  /**
   * Run a synchronous shadow comparison: apply event to current state,
   * then verify invariants on the resulting state.
   *
   * Used by BillingStateMachine's shadow mode to compare GovernedBilling's
   * pure state transition against the primary transition. Fully synchronous —
   * no I/O, no DB, no network, no additional awaits.
   */
  runShadow(eventType: BillingEventType): ShadowCompareResult {
    const context: MutationContext = {
      actorId: "finn:billing-shadow",
      actorType: "system",
    }
    const newState = this.applyEvent(this.current, eventType, context)

    // Verify invariants on the post-transition state by creating a
    // verifier instance (verifyAll checks this.current, so we need
    // a fresh instance seeded with newState).
    const verifier = new GovernedBilling(this.resourceId, newState)
    const results = verifier.verifyAll()

    const invariantMap: ShadowCompareResult["invariants"] = {
      cost_non_negative: true,
      valid_state: true,
      reserve_conservation: true,
    }
    for (const r of results) {
      if (r.invariantId in invariantMap) {
        invariantMap[r.invariantId as BillingInvariantId] = r.holds
      }
    }

    return {
      shadowState: newState.state,
      invariants: invariantMap,
      allHold: results.every((r) => r.holds),
    }
  }
}
