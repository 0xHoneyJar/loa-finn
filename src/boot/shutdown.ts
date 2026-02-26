// src/boot/shutdown.ts — GracefulShutdown (SDD §3.1, cycle-035 T-1.4)
//
// Centralized shutdown handler with 25s deadline within ECS 30s stopTimeout.
// Shutdown order: stop inbound → drain background → flush outbound → exit.
// In-flight request draining: server.close() stops accepting new connections,
// existing keep-alive connections drained. Background pollers receive shutdown
// signal and complete current iteration. If deadline reached, force-exit(1).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShutdownTarget {
  /** Human-readable name for logging. */
  name: string
  /** Shutdown function. Should resolve when cleanup is done. */
  shutdown: () => Promise<void>
  /** Priority: lower runs first. Same priority runs in parallel. Default: 100. */
  priority?: number
}

export interface GracefulShutdownOptions {
  /** Deadline in ms before force-exit. Default: 25000 (25s for ECS 30s stopTimeout). */
  deadlineMs?: number
  /** Logger function. Default: console.log. */
  log?: (msg: string) => void
}

// ---------------------------------------------------------------------------
// GracefulShutdown
// ---------------------------------------------------------------------------

export class GracefulShutdown {
  private readonly targets: ShutdownTarget[] = []
  private readonly deadlineMs: number
  private readonly log: (msg: string) => void
  private shuttingDown = false
  private registered = false

  constructor(options?: GracefulShutdownOptions) {
    this.deadlineMs = options?.deadlineMs ?? 25_000
    this.log = options?.log ?? ((msg) => console.log(msg))
  }

  /** Register a shutdown target. */
  register(target: ShutdownTarget): void {
    this.targets.push(target)
  }

  /** Register SIGTERM/SIGINT handlers. Call once after all targets registered. */
  registerSignalHandlers(): void {
    if (this.registered) return
    this.registered = true

    const handler = (signal: string) => {
      this.execute(signal)
    }

    process.on("SIGTERM", () => handler("SIGTERM"))
    process.on("SIGINT", () => handler("SIGINT"))
  }

  /** Whether shutdown is in progress. */
  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  /**
   * Execute shutdown sequence. Idempotent — second call is a no-op.
   * Groups targets by priority, executes each group in parallel.
   */
  async execute(signal: string = "manual"): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true

    const start = Date.now()
    this.log(`[shutdown] ${signal} received, starting graceful shutdown (deadline: ${this.deadlineMs}ms)`)

    // Force-exit timer (unref so it doesn't keep process alive)
    const forceTimer = setTimeout(() => {
      this.log(`[shutdown] deadline exceeded after ${this.deadlineMs}ms, forcing exit`)
      process.exit(1)
    }, this.deadlineMs)
    forceTimer.unref()

    // Group by priority
    const groups = new Map<number, ShutdownTarget[]>()
    for (const target of this.targets) {
      const prio = target.priority ?? 100
      const group = groups.get(prio) ?? []
      group.push(target)
      groups.set(prio, group)
    }

    // Execute groups in priority order (lowest first)
    const sortedPriorities = [...groups.keys()].sort((a, b) => a - b)

    for (const prio of sortedPriorities) {
      const group = groups.get(prio)!
      const names = group.map(t => t.name).join(", ")
      this.log(`[shutdown] priority ${prio}: ${names}`)

      const results = await Promise.allSettled(
        group.map(async (target) => {
          try {
            await target.shutdown()
            this.log(`[shutdown] ✓ ${target.name}`)
          } catch (err) {
            this.log(`[shutdown] ✗ ${target.name}: ${(err as Error).message}`)
          }
        }),
      )

      // Log any unexpected rejections
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          this.log(`[shutdown] ✗ ${group[i].name}: unhandled rejection`)
        }
      }
    }

    clearTimeout(forceTimer)
    const duration = Date.now() - start
    this.log(`[shutdown] complete in ${duration}ms`)
    process.exit(0)
  }
}
