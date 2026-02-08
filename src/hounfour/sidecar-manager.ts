// src/hounfour/sidecar-manager.ts — Sidecar lifecycle manager (SDD §4.2, T-1.3)

import { spawn, type ChildProcess } from "node:child_process"

// --- Types ---

export interface SidecarManagerConfig {
  pythonBin: string                    // Default: "python3"
  uvicornModule: string                // Default: "uvicorn"
  appImport: string                    // Default: "adapters.cheval_server:app"
  port: number                         // Default: 3001
  host: string                         // Default: "127.0.0.1"
  startupTimeoutMs: number             // Default: 30000
  shutdownTimeoutMs: number            // Default: 30000
  restartBackoff: {
    initialMs: number                  // Default: 1000
    maxMs: number                      // Default: 30000
    multiplier: number                 // Default: 2
  }
  env: Record<string, string>
  workingDirectory: string             // Default: process.cwd()
}

export type SidecarState = "stopped" | "starting" | "running" | "stopping"

export interface SidecarStatus {
  state: SidecarState
  pid: number | null
  restartCount: number
  uptimeMs: number
  baseUrl: string
}

// --- Default Config ---

export function defaultSidecarConfig(
  overrides: Partial<SidecarManagerConfig> & { env: Record<string, string> },
): SidecarManagerConfig {
  return {
    pythonBin: overrides.pythonBin ?? "python3",
    uvicornModule: overrides.uvicornModule ?? "uvicorn",
    appImport: overrides.appImport ?? "adapters.cheval_server:app",
    port: overrides.port ?? 3001,
    host: overrides.host ?? "127.0.0.1",
    startupTimeoutMs: overrides.startupTimeoutMs ?? 30_000,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 30_000,
    restartBackoff: {
      initialMs: overrides.restartBackoff?.initialMs ?? 1000,
      maxMs: overrides.restartBackoff?.maxMs ?? 30_000,
      multiplier: overrides.restartBackoff?.multiplier ?? 2,
    },
    env: overrides.env,
    workingDirectory: overrides.workingDirectory ?? process.cwd(),
  }
}

// --- SidecarManager ---

export class SidecarManager {
  private process: ChildProcess | null = null
  private state: SidecarState = "stopped"
  private restartCount = 0
  private startedAt = 0
  private lastSuccessfulStartAt = 0
  private config: SidecarManagerConfig

  constructor(config: Partial<SidecarManagerConfig> & { env: Record<string, string> }) {
    this.config = defaultSidecarConfig(config)
  }

  /**
   * Start the sidecar process and wait for /healthz 200.
   *
   * 1. Spawn: python3 -m uvicorn adapters.cheval_server:app --host ... --port ...
   * 2. Poll GET /healthz every 500ms until 200 or timeout
   * 3. Register process exit handler → auto-restart with backoff
   */
  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      return
    }

    this.state = "starting"
    this.startedAt = Date.now()

    const { pythonBin, uvicornModule, appImport, host, port, env, workingDirectory } = this.config
    const portStr = String(port)

    const mergedEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PYTHONPATH: workingDirectory,
      CHEVAL_PORT: portStr,
      ...env,
    }

    const args = [
      "-m", uvicornModule,
      appImport,
      "--host", host,
      "--port", portStr,
      "--log-level", "warning",
    ]

    this.process = spawn(pythonBin, args, {
      cwd: workingDirectory,
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })

    // Pipe stderr to console for diagnostics
    this.process.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        if (line.trim()) console.warn(`[sidecar] ${line}`)
      }
    })

    // Handle unexpected exits
    this.process.on("exit", (code, signal) => {
      const pid = this.process?.pid
      this.process = null

      if (this.state === "stopping") {
        this.state = "stopped"
        return
      }

      console.warn(
        `[sidecar] Process ${pid} exited unexpectedly (code=${code}, signal=${signal})`,
      )
      this.state = "stopped"
      this.onUnexpectedExit()
    })

    // Wait for health
    await this.waitForHealth()
    this.state = "running"
    this.lastSuccessfulStartAt = Date.now()

    // Reset restart count after 60s of successful running
    setTimeout(() => {
      if (this.state === "running") {
        this.restartCount = 0
      }
    }, 60_000).unref()

    console.log(
      `[sidecar] Started on ${host}:${port} (pid: ${this.process?.pid})`,
    )
  }

  /**
   * Graceful shutdown.
   *
   * 1. Set state = "stopping" (prevents auto-restart)
   * 2. Send SIGTERM to child process
   * 3. Wait up to shutdownTimeoutMs for exit
   * 4. If still alive: SIGKILL
   */
  async stop(): Promise<void> {
    if (this.state === "stopped" || !this.process) {
      this.state = "stopped"
      return
    }

    this.state = "stopping"
    const proc = this.process

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (proc.exitCode === null) {
          console.warn("[sidecar] Shutdown timeout, sending SIGKILL")
          proc.kill("SIGKILL")
        }
        cleanup()
      }, this.config.shutdownTimeoutMs)
      timeout.unref()

      const cleanup = () => {
        clearTimeout(timeout)
        this.process = null
        this.state = "stopped"
        resolve()
      }

      proc.once("exit", cleanup)
      proc.kill("SIGTERM")
    })
  }

  /** Current status for health reporting */
  getStatus(): SidecarStatus {
    return {
      state: this.state,
      pid: this.process?.pid ?? null,
      restartCount: this.restartCount,
      uptimeMs: this.state === "running" ? Date.now() - this.startedAt : 0,
      baseUrl: `http://${this.config.host}:${this.config.port}`,
    }
  }

  /** Base URL for the sidecar (e.g., "http://127.0.0.1:3001") */
  get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  /** Whether the sidecar is running and healthy */
  get isRunning(): boolean {
    return this.state === "running"
  }

  /** Port the sidecar is listening on */
  get port(): number {
    return this.config.port
  }

  // --- Private ---

  private async waitForHealth(): Promise<void> {
    const url = `http://${this.config.host}:${this.config.port}/healthz`
    const deadline = Date.now() + this.config.startupTimeoutMs
    const pollIntervalMs = 500

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
        if (response.ok) return
      } catch {
        // Not ready yet — retry
      }
      await sleep(pollIntervalMs)
    }

    // Timeout — kill the process and throw
    this.process?.kill("SIGKILL")
    this.process = null
    this.state = "stopped"
    throw new Error(
      `[sidecar] Health check timeout after ${this.config.startupTimeoutMs}ms`,
    )
  }

  private async onUnexpectedExit(): Promise<void> {
    this.restartCount++
    const { initialMs, maxMs, multiplier } = this.config.restartBackoff
    const delay = Math.min(initialMs * Math.pow(multiplier, this.restartCount - 1), maxMs)

    console.warn(`[sidecar] Auto-restarting in ${delay}ms (restart #${this.restartCount})`)

    await sleep(delay)

    if (this.state === "stopping" || this.state === "running") {
      return // Shutdown requested or already restarted
    }

    try {
      await this.start()
    } catch (err) {
      console.error(`[sidecar] Restart failed:`, err)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
