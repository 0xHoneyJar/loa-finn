// src/x402/relayer-monitor.ts — Relayer Gas Monitoring (SDD §4.4.5, T-3.8)
//
// Periodic health probe for relayer ETH balance on Base.
// alert (0.01 ETH): log warning for CloudWatch
// critical (0.001 ETH): refuse new settlements (503)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelayerHealthStatus = "healthy" | "low" | "critical"

export interface RelayerHealth {
  balanceWei: bigint
  balanceEth: string
  status: RelayerHealthStatus
}

export interface RelayerMonitorConfig {
  /** Alert threshold in wei (default: 0.01 ETH = 10^16) */
  alertThresholdWei?: bigint
  /** Critical threshold in wei (default: 0.001 ETH = 10^15) */
  criticalThresholdWei?: bigint
  /** Check interval in ms (default: 60000 = 1 minute) */
  checkIntervalMs?: number
}

/** Minimal provider interface for balance queries. */
export interface BalanceProvider {
  getBalance(address: string): Promise<bigint>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ALERT_THRESHOLD = 10_000_000_000_000_000n   // 0.01 ETH
const DEFAULT_CRITICAL_THRESHOLD = 1_000_000_000_000_000n  // 0.001 ETH
const DEFAULT_CHECK_INTERVAL_MS = 60_000
const WEI_PER_ETH = 1_000_000_000_000_000_000n

// ---------------------------------------------------------------------------
// RelayerMonitor
// ---------------------------------------------------------------------------

export class RelayerMonitor {
  private readonly provider: BalanceProvider
  private readonly relayerAddress: string
  private readonly alertThreshold: bigint
  private readonly criticalThreshold: bigint
  private readonly checkIntervalMs: number
  private monitorTimer: ReturnType<typeof setInterval> | null = null
  private lastHealth: RelayerHealth | null = null

  constructor(provider: BalanceProvider, relayerAddress: string, config?: RelayerMonitorConfig) {
    this.provider = provider
    this.relayerAddress = relayerAddress
    this.alertThreshold = config?.alertThresholdWei ?? DEFAULT_ALERT_THRESHOLD
    this.criticalThreshold = config?.criticalThresholdWei ?? DEFAULT_CRITICAL_THRESHOLD
    this.checkIntervalMs = config?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
  }

  /**
   * Check relayer balance on startup.
   */
  async checkOnStartup(): Promise<RelayerHealth> {
    const health = await this.getRelayerHealth()
    this.lastHealth = health

    if (health.status === "critical") {
      console.error(JSON.stringify({
        metric: "relayer.balance.critical",
        balance_eth: health.balanceEth,
        threshold_eth: formatEth(this.criticalThreshold),
        timestamp: Date.now(),
      }))
    } else if (health.status === "low") {
      console.warn(JSON.stringify({
        metric: "relayer.balance.low",
        balance_eth: health.balanceEth,
        threshold_eth: formatEth(this.alertThreshold),
        timestamp: Date.now(),
      }))
    }

    return health
  }

  /**
   * Get current relayer health.
   */
  async getRelayerHealth(): Promise<RelayerHealth> {
    const balanceWei = await this.provider.getBalance(this.relayerAddress)
    const balanceEth = formatEth(balanceWei)

    let status: RelayerHealthStatus
    if (balanceWei < this.criticalThreshold) {
      status = "critical"
    } else if (balanceWei < this.alertThreshold) {
      status = "low"
    } else {
      status = "healthy"
    }

    const health: RelayerHealth = { balanceWei, balanceEth, status }
    this.lastHealth = health
    return health
  }

  /**
   * Start periodic monitoring.
   */
  startMonitoring(): void {
    if (this.monitorTimer) return

    this.monitorTimer = setInterval(async () => {
      try {
        await this.getRelayerHealth()

        if (this.lastHealth?.status === "critical") {
          console.error(JSON.stringify({
            metric: "relayer.balance.critical",
            balance_eth: this.lastHealth.balanceEth,
            timestamp: Date.now(),
          }))
        } else if (this.lastHealth?.status === "low") {
          console.warn(JSON.stringify({
            metric: "relayer.balance.low",
            balance_eth: this.lastHealth.balanceEth,
            timestamp: Date.now(),
          }))
        }
      } catch (err) {
        console.error(JSON.stringify({
          metric: "relayer.monitor.error",
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        }))
      }
    }, this.checkIntervalMs)

    // Don't prevent Node from exiting
    if (this.monitorTimer.unref) {
      this.monitorTimer.unref()
    }
  }

  /**
   * Stop periodic monitoring.
   */
  stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
  }

  /**
   * Whether the relayer can accept new settlements.
   * Returns false if balance is critical.
   */
  canSettle(): boolean {
    if (!this.lastHealth) return true // Optimistic until first check
    return this.lastHealth.status !== "critical"
  }

  /** Last cached health (for /health endpoint). */
  getCachedHealth(): RelayerHealth | null {
    return this.lastHealth
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEth(wei: bigint): string {
  const whole = wei / WEI_PER_ETH
  const fraction = wei % WEI_PER_ETH
  const fractionStr = fraction.toString().padStart(18, "0").slice(0, 6)
  return `${whole}.${fractionStr}`
}
