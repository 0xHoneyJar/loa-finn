// src/hounfour/goodhart/routing-events.ts — Routing State Transition Events (cycle-036 T-4.6)
//
// Structured event emitters for routing state transitions and KillSwitch overrides.
// Injectable for testing — default implementations log JSON to stdout/stderr.

export type RoutingState = "disabled" | "shadow" | "enabled" | "init_failed"

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

/**
 * Emit a structured routing state transition event.
 * Default: console.log JSON. Override for testing.
 */
export let emitRoutingStateTransition = (
  from: RoutingState,
  to: RoutingState,
  reason: string,
): void => {
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
}

/**
 * Emit a structured routing override event (KillSwitch activation/deactivation).
 * Default: console.warn JSON. Override for testing.
 */
export let emitRoutingOverride = (
  override: "killswitch",
  state: "activated" | "deactivated",
): void => {
  const event: RoutingOverrideEvent = {
    component: "routing-events",
    event: "routing_override",
    override,
    state,
    timestamp: new Date().toISOString(),
  }
  console.warn(JSON.stringify(event))
}

/** Replace the transition emitter (for testing). Returns the previous one. */
export function setRoutingStateTransitionEmitter(
  fn: typeof emitRoutingStateTransition,
): typeof emitRoutingStateTransition {
  const prev = emitRoutingStateTransition
  emitRoutingStateTransition = fn
  return prev
}

/** Replace the override emitter (for testing). Returns the previous one. */
export function setRoutingOverrideEmitter(
  fn: typeof emitRoutingOverride,
): typeof emitRoutingOverride {
  const prev = emitRoutingOverride
  emitRoutingOverride = fn
  return prev
}
