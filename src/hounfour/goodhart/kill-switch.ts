// src/hounfour/goodhart/kill-switch.ts — Kill Switch (SDD §4.1.5, cycle-035 T-1.2)
//
// Async KillSwitch backed by RuntimeConfig (Redis GET + env fallback).
// Race condition safety: callers reading mode during a concurrent write get
// either the old or new value (eventually consistent via Redis GET, no partial state).

import type { RuntimeConfig, RoutingMode } from "../runtime-config.js"

export class KillSwitch {
  private readonly runtimeConfig: RuntimeConfig | null

  constructor(runtimeConfig?: RuntimeConfig | null) {
    this.runtimeConfig = runtimeConfig ?? null
  }

  /** Check if reputation routing is disabled. Async — reads RuntimeConfig. */
  async isDisabled(): Promise<boolean> {
    const state = await this.getState()
    return state === "disabled"
  }

  /** Get current state string for observability. */
  async getState(): Promise<RoutingMode> {
    if (this.runtimeConfig) {
      return this.runtimeConfig.getMode()
    }
    // Fallback: direct env var read (backward compat when no RuntimeConfig)
    const val = process.env.FINN_REPUTATION_ROUTING
    if (val === "disabled") return "disabled"
    if (val === "shadow") return "shadow"
    return "enabled"
  }

  /** Log state transition for audit trail. */
  logTransition(previousState: RoutingMode, currentState: RoutingMode): void {
    if (previousState !== currentState) {
      console.log(JSON.stringify({
        component: "kill-switch",
        event: "state_transition",
        action: "kill_switch_toggle",
        from: previousState,
        to: currentState,
        timestamp: new Date().toISOString(),
      }))
    }
  }
}
