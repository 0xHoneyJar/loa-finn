// src/scheduler/circuit-breaker.ts — Three-state circuit breaker (SDD §3.4.2, T-4.2)

export type CircuitState = "closed" | "open" | "half-open"

export interface CircuitBreakerConfig {
  failureThreshold: number  // Default: 3
  cooldownMs: number        // Default: 300_000 (5 min)
}

export interface CircuitBreakerStats {
  state: CircuitState
  failureCount: number
  successCount: number
  lastFailure?: number
  lastSuccess?: number
  probes: number
}

export class CircuitBreakerOpenError extends Error {
  constructor(taskId: string, retryAfterMs: number) {
    super(`Circuit breaker OPEN for ${taskId}, retry after ${retryAfterMs}ms`)
    this.name = "CircuitBreakerOpenError"
  }
}

export class CircuitBreaker {
  private state: CircuitState = "closed"
  private failureCount = 0
  private successCount = 0
  private lastFailure: number | undefined
  private lastSuccess: number | undefined
  private probes = 0
  private onStateChange?: (taskId: string, from: CircuitState, to: CircuitState) => void

  constructor(
    private taskId: string,
    private config: CircuitBreakerConfig = { failureThreshold: 3, cooldownMs: 300_000 },
  ) {}

  /** Register a callback for state changes (for WAL logging, beads labels). */
  onTransition(cb: (taskId: string, from: CircuitState, to: CircuitState) => void): void {
    this.onStateChange = cb
  }

  /** Execute a function with circuit breaker protection. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    switch (this.state) {
      case "closed":
        return this.executeClosed(fn)
      case "open":
        return this.executeOpen(fn)
      case "half-open":
        return this.executeHalfOpen(fn)
    }
  }

  getState(): CircuitState {
    // Check if OPEN should transition to HALF-OPEN
    if (
      this.state === "open" &&
      this.lastFailure &&
      Date.now() - this.lastFailure >= this.config.cooldownMs
    ) {
      this.transition("half-open")
    }
    return this.state
  }

  getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      probes: this.probes,
    }
  }

  /** Manual reset to closed state. */
  reset(): void {
    this.transition("closed")
    this.failureCount = 0
  }

  private async executeClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn()
      this.successCount++
      this.lastSuccess = Date.now()
      return result
    } catch (err) {
      this.failureCount++
      this.lastFailure = Date.now()
      if (this.failureCount >= this.config.failureThreshold) {
        this.transition("open")
      }
      throw err
    }
  }

  private async executeOpen<T>(fn: () => Promise<T>): Promise<T> {
    // Check if cooldown has elapsed
    if (this.lastFailure && Date.now() - this.lastFailure >= this.config.cooldownMs) {
      this.transition("half-open")
      return this.executeHalfOpen(fn)
    }

    const retryAfter = this.lastFailure
      ? this.config.cooldownMs - (Date.now() - this.lastFailure)
      : this.config.cooldownMs

    throw new CircuitBreakerOpenError(this.taskId, retryAfter)
  }

  private async executeHalfOpen<T>(fn: () => Promise<T>): Promise<T> {
    this.probes++
    try {
      const result = await fn()
      this.transition("closed")
      this.failureCount = 0
      this.successCount++
      this.lastSuccess = Date.now()
      return result
    } catch (err) {
      this.transition("open")
      this.lastFailure = Date.now()
      throw err
    }
  }

  private transition(to: CircuitState): void {
    const from = this.state
    if (from === to) return
    this.state = to
    this.onStateChange?.(this.taskId, from, to)
  }
}
