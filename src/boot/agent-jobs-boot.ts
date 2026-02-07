// src/boot/agent-jobs-boot.ts — Agent-jobs subsystem boot orchestrator (SDD §8.1, steps 10a-10e)
//
// Self-contained boot sequence for the agent-jobs subsystem. Provides graceful
// degradation: if any init step fails, the error is captured and agent-jobs is
// disabled rather than crashing Finn.

// ── Config & Result types ──────────────────────────────────

export interface AgentJobsBootConfig {
  token?: string
  autonomous?: boolean
  dataDir?: string
  dryRun?: boolean
  enabled?: boolean
}

export interface AgentJobsBootResult {
  success: boolean
  warnings: string[]
  error?: string
  orphanedIntents?: number
  staleLocks?: string[]
  subsystems?: {
    auditTrail: boolean
    alertService: boolean
    firewall: boolean
    cronService: boolean
  }
}

// ── Dependency injection interface ─────────────────────────

export interface AgentJobsBootDeps {
  validateBoot?: (config: AgentJobsBootConfig) => Promise<{ tokenType: string; warnings: string[] }>
  validateFs?: (dir: string) => Promise<{ warnings: string[] }>
  initAuditTrail?: () => Promise<boolean>
  initAlertService?: () => Promise<boolean>
  initFirewall?: () => Promise<boolean>
  firewallSelfTest?: () => Promise<boolean>
  reconcileOrphanedIntents?: () => Promise<number>
  recoverStaleLocks?: () => Promise<string[]>
  initCronService?: () => Promise<boolean>
}

// ── Boot sequence ──────────────────────────────────────────

/**
 * Boot the agent-jobs subsystem. (SDD §8.1, steps 10a-10e)
 *
 * Runs each initialization step in order. On any failure, returns
 * { success: false, error } with partial subsystem status -- does NOT throw.
 */
export async function bootAgentJobs(
  config: AgentJobsBootConfig,
  deps: AgentJobsBootDeps = {},
): Promise<AgentJobsBootResult> {
  const warnings: string[] = []
  const subsystems = {
    auditTrail: false,
    alertService: false,
    firewall: false,
    cronService: false,
  }

  try {
    // ── Step 10a: Config validation ────────────────────────
    if (config.enabled === false) {
      return { success: false, warnings: [], error: "Agent jobs disabled by config" }
    }

    if (config.autonomous && !config.token) {
      return {
        success: false,
        warnings: [],
        error: "Autonomous mode requires a token",
      }
    }

    if (deps.validateBoot) {
      const bootResult = await deps.validateBoot(config)
      warnings.push(...bootResult.warnings)
    }

    // ── Step 10b: Filesystem validation ────────────────────
    if (config.dataDir && deps.validateFs) {
      const fsResult = await deps.validateFs(config.dataDir)
      warnings.push(...fsResult.warnings)
    }

    // ── Step 10c: Initialize subsystems ────────────────────
    if (deps.initAuditTrail) {
      subsystems.auditTrail = await deps.initAuditTrail()
      if (!subsystems.auditTrail) {
        return {
          success: false,
          warnings,
          error: "Audit trail initialization failed — agent jobs disabled",
          subsystems,
        }
      }
    } else {
      // No audit trail dep provided — mark as ok (noop)
      subsystems.auditTrail = true
    }

    if (deps.initAlertService) {
      subsystems.alertService = await deps.initAlertService()
      if (!subsystems.alertService) {
        warnings.push("Alert service initialization failed — continuing without alerts")
      }
    } else {
      subsystems.alertService = true
    }

    if (deps.initFirewall) {
      subsystems.firewall = await deps.initFirewall()
      if (!subsystems.firewall) {
        return {
          success: false,
          warnings,
          error: "Firewall initialization failed — agent jobs disabled",
          subsystems,
        }
      }
    } else {
      subsystems.firewall = true
    }

    // ── Step 10d: Firewall self-test ───────────────────────
    if (deps.firewallSelfTest) {
      const selfTestOk = await deps.firewallSelfTest()
      if (!selfTestOk) {
        return {
          success: false,
          warnings,
          error: "Firewall self-test failed — agent jobs disabled",
          subsystems,
        }
      }
    }

    // ── Step 10e: Reconcile orphaned intents ───────────────
    let orphanedIntents = 0
    if (deps.reconcileOrphanedIntents) {
      orphanedIntents = await deps.reconcileOrphanedIntents()
      if (orphanedIntents > 0) {
        warnings.push(`Reconciled ${orphanedIntents} orphaned intent(s)`)
      }
    }

    // ── Recover stale locks ────────────────────────────────
    let staleLocks: string[] = []
    if (deps.recoverStaleLocks) {
      staleLocks = await deps.recoverStaleLocks()
      if (staleLocks.length > 0) {
        warnings.push(`Recovered ${staleLocks.length} stale lock(s): ${staleLocks.join(", ")}`)
      }
    }

    // ── Initialize cron service ────────────────────────────
    if (deps.initCronService) {
      subsystems.cronService = await deps.initCronService()
      if (!subsystems.cronService) {
        warnings.push("Cron service initialization failed — scheduled jobs unavailable")
      }
    } else {
      subsystems.cronService = true
    }

    return {
      success: true,
      warnings,
      orphanedIntents,
      staleLocks,
      subsystems,
    }
  } catch (err: unknown) {
    // Graceful degradation: capture any unexpected throw, don't crash Finn
    const message = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      warnings,
      error: `Boot failed unexpectedly: ${message}`,
      subsystems,
    }
  }
}
