// src/hounfour/goodhart/kill-switch.ts — Kill Switch (SDD §4.1.5, cycle-034)
//
// Reads process.env.FINN_REPUTATION_ROUTING on every call (~100ns, no cache).
// "disabled" → deterministic routing. Anything else → reputation routing active.

export class KillSwitch {
  /** Check if reputation routing is disabled. Reads env on every call (no cache). */
  isDisabled(): boolean {
    return process.env.FINN_REPUTATION_ROUTING === "disabled"
  }

  /** Get current state string for observability. */
  getState(): "disabled" | "enabled" | "shadow" {
    const val = process.env.FINN_REPUTATION_ROUTING
    if (val === "disabled") return "disabled"
    if (val === "shadow") return "shadow"
    return "enabled"
  }

  /** Log state transition for audit trail. */
  logTransition(previousState: boolean, currentState: boolean): void {
    if (previousState !== currentState) {
      const action = currentState ? "disabled" : "enabled"
      console.log(JSON.stringify({
        component: "kill-switch",
        event: "state_transition",
        action: "kill_switch_toggle",
        from: previousState ? "disabled" : "enabled",
        to: action,
        timestamp: new Date().toISOString(),
      }))
    }
  }
}
