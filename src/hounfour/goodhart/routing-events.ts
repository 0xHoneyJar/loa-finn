// src/hounfour/goodhart/routing-events.ts — Routing State Transition Events (cycle-036 T-4.6)
//
// Structured event emitters for routing state transitions and KillSwitch overrides.
// Injectable for testing — holder object pattern ensures reassignment propagates
// to all importers regardless of ESM/CJS interop (T-7.2).

// T-7.3: Import canonical RoutingState from router.ts
import type { RoutingState } from "../router.js"
export type { RoutingState }

export interface RoutingStateTransitionEvent {
  component: "routing-events"
  event: "routing_state_transition"
  from: RoutingState
  to: RoutingState
  reason: string
  timestamp: string
}

export interface RoutingOverrideEvent {
  component: "routing-events"
  event: "routing_override"
  override: "killswitch"
  state: "activated" | "deactivated"
  timestamp: string
}

// --- Emitter function types ---

type TransitionEmitter = (from: RoutingState, to: RoutingState, reason: string) => void
type OverrideEmitter = (override: "killswitch", state: "activated" | "deactivated") => void

// --- Internal holder — mutations propagate to all importers (T-7.2) ---

const _emitters = {
  transition: ((from: RoutingState, to: RoutingState, reason: string): void => {
    if (from === to) return
    const event: RoutingStateTransitionEvent = {
      component: "routing-events",
      event: "routing_state_transition",
      from,
      to,
      reason,
      timestamp: new Date().toISOString(),
    }
    console.log(JSON.stringify(event))
  }) as TransitionEmitter,

  override: ((override: "killswitch", state: "activated" | "deactivated"): void => {
    const event: RoutingOverrideEvent = {
      component: "routing-events",
      event: "routing_override",
      override,
      state,
      timestamp: new Date().toISOString(),
    }
    console.warn(JSON.stringify(event))
  }) as OverrideEmitter,
}

/**
 * Emit a structured routing state transition event.
 * Default: console.log JSON. Override via setRoutingStateTransitionEmitter().
 */
export function emitRoutingStateTransition(
  from: RoutingState,
  to: RoutingState,
  reason: string,
): void {
  _emitters.transition(from, to, reason)
}

/**
 * Emit a structured routing override event (KillSwitch activation/deactivation).
 * Default: console.warn JSON. Override via setRoutingOverrideEmitter().
 */
export function emitRoutingOverride(
  override: "killswitch",
  state: "activated" | "deactivated",
): void {
  _emitters.override(override, state)
}

/** Replace the transition emitter (for testing). Returns the previous one. */
export function setRoutingStateTransitionEmitter(
  fn: TransitionEmitter,
): TransitionEmitter {
  const prev = _emitters.transition
  _emitters.transition = fn
  return prev
}

/** Replace the override emitter (for testing). Returns the previous one. */
export function setRoutingOverrideEmitter(
  fn: OverrideEmitter,
): OverrideEmitter {
  const prev = _emitters.override
  _emitters.override = fn
  return prev
}
