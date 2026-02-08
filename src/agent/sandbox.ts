// src/agent/sandbox.ts — Tool execution sandbox (SDD §3.1–3.5, Issue #11)

import { execFileSync } from "node:child_process"
import { lstatSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { FinnConfig } from "../config.js"
import { AuditLog, type AuditEntry } from "./audit-log.js"
import type { WorkerPool, ExecSpec } from "./worker-pool.js"

// ── Types ────────────────────────────────────────────────────

export interface SandboxCommand {
  binary: string
  args: string[]
}

export interface SandboxResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  truncated: boolean
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SandboxError"
  }
}

// ── Command Policy ───────────────────────────────────────────

export interface CommandPolicy {
  binary: string
  subcommands: string[]
  deniedFlags: string[]
  validatePaths: boolean
}

const READ_ONLY_COMMANDS = new Set(["ls", "cat", "wc"])

// ── Shell Metacharacter Rejection ────────────────────────────

const SHELL_METACHAR_PATTERN = /[|&;$`(){}!<>\\#~]/

// ── Sandbox Environment ──────────────────────────────────────

function buildSandboxEnv(jailRoot: string): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: jailRoot,
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  }
}

// ── Secret Redactor (SDD §3.5) ──────────────────────────────

export class SecretRedactor {
  private readonly secretValues: Set<string>
  private readonly secretPatterns: RegExp[]

  constructor(env: Record<string, string | undefined> = process.env) {
    const secretKeys = [
      "ANTHROPIC_API_KEY",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "FINN_AUTH_TOKEN",
      "GIT_TOKEN",
    ]
    this.secretValues = new Set(
      secretKeys.map((k) => env[k]).filter((v): v is string => typeof v === "string" && v.length >= 8),
    )

    this.secretPatterns = [
      /sk-ant-api[A-Za-z0-9_-]{20,}/g,
      /(?:key|token|secret|password)["'\s:=]+["']?([A-Za-z0-9_\-/.+]{20,})/gi,
    ]
  }

  redact(output: string): string {
    let result = output

    for (const value of this.secretValues) {
      result = result.replaceAll(value, "[REDACTED]")
    }

    for (const pattern of this.secretPatterns) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0
      result = result.replace(pattern, (match, group1) =>
        group1 ? match.replace(group1, "[REDACTED]") : "[REDACTED]",
      )
    }

    return result
  }
}

// ── Filesystem Jail (SDD §3.3) ──────────────────────────────

export class FilesystemJail {
  private readonly jailRoot: string

  constructor(dataDir: string) {
    this.jailRoot = realpathSync(resolve(dataDir))
  }

  validatePath(inputPath: string): string {
    const resolved = resolve(this.jailRoot, inputPath)

    // Enforce jail prefix early on the resolved (non-symlink-resolved) path
    if (!resolved.startsWith(this.jailRoot + "/") && resolved !== this.jailRoot) {
      throw new SandboxError(`Path escapes jail: ${inputPath}`)
    }

    // Walk each existing path component and reject any symlink in the chain
    const rel = resolved.slice(this.jailRoot.length)
    const parts = rel.split("/").filter(Boolean)
    let current = this.jailRoot
    for (const part of parts) {
      current = resolve(current, part)
      try {
        const st = lstatSync(current)
        if (st.isSymbolicLink()) {
          throw new SandboxError(`Symlink rejected: ${inputPath}`)
        }
      } catch (err) {
        if (err instanceof SandboxError) throw err
        // Stop walking when the component doesn't exist
        break
      }
    }

    // Canonicalize existing paths and ensure still inside jail
    try {
      const canonical = realpathSync(resolved)
      if (!canonical.startsWith(this.jailRoot + "/") && canonical !== this.jailRoot) {
        throw new SandboxError(`Path escapes jail: ${inputPath}`)
      }
      return canonical
    } catch {
      // Path doesn't exist; we already verified prefix + component symlinks
      return resolved
    }
  }

  getJailRoot(): string {
    return this.jailRoot
  }
}

// ── ToolSandbox (SDD §3.1) ──────────────────────────────────

export class ToolSandbox {
  private readonly config: FinnConfig["sandbox"]
  private readonly policies: Record<string, CommandPolicy>
  private readonly jail: FilesystemJail
  private readonly redactor: SecretRedactor
  private readonly auditLog: AuditLog
  private readonly sandboxEnv: Record<string, string>
  private readonly pool: WorkerPool | undefined
  private poolMissingWarned = false

  constructor(config: FinnConfig["sandbox"], auditLog: AuditLog, pool?: WorkerPool) {
    this.config = config
    this.jail = new FilesystemJail(config.jailRoot)
    this.redactor = new SecretRedactor()
    this.auditLog = auditLog
    this.pool = pool
    this.sandboxEnv = buildSandboxEnv(this.jail.getJailRoot())

    // Resolve binary paths at startup
    this.policies = {
      git: {
        binary: resolveBinary("git"),
        subcommands: ["log", "status", "diff", "show", "rev-parse"],
        deniedFlags: ["-c", "--exec-path", "--git-dir", "--work-tree"],
        validatePaths: false,
      },
      br: {
        binary: resolveBinary("br"),
        subcommands: ["list", "get", "sync"],
        deniedFlags: [],
        validatePaths: false,
      },
      ls: {
        binary: resolveBinary("ls"),
        subcommands: [],
        deniedFlags: [],
        validatePaths: true,
      },
      cat: {
        binary: resolveBinary("cat"),
        subcommands: [],
        deniedFlags: [],
        validatePaths: true,
      },
      wc: {
        binary: resolveBinary("wc"),
        subcommands: [],
        deniedFlags: [],
        validatePaths: true,
      },
    }
  }

  /**
   * Tokenize a raw command string into SandboxCommand.
   * Rejects shell metacharacters and splits on whitespace.
   */
  tokenize(commandString: string): SandboxCommand {
    const trimmed = commandString.trim()
    if (!trimmed) {
      throw new SandboxError("Empty command")
    }

    if (SHELL_METACHAR_PATTERN.test(trimmed)) {
      throw new SandboxError("Shell metacharacters rejected")
    }

    const tokens = trimmed.split(/\s+/)
    return {
      binary: tokens[0],
      args: tokens.slice(1),
    }
  }

  /**
   * Execute a command through the sandbox pipeline:
   * Gate → Tokenize → Policy → Jail → Audit → Dispatch → Redact
   */
  async execute(commandString: string): Promise<SandboxResult> {
    // 1. Gate check
    if (!this.config.allowBash) {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        action: "deny",
        command: commandString,
        args: [],
        reason: "bash_disabled",
      }
      this.auditLog.append(entry)
      throw new SandboxError("Bash execution is disabled (set FINN_ALLOW_BASH=true)")
    }

    // 2. Tokenize
    const cmd = this.tokenize(commandString)

    // 3. Policy lookup
    const policy = this.policies[cmd.binary]
    if (!policy) {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        action: "deny",
        command: cmd.binary,
        args: cmd.args,
        reason: `binary_not_allowed: ${cmd.binary}`,
      }
      this.auditLog.append(entry)
      throw new SandboxError(`Command not allowed: ${cmd.binary}`)
    }

    // 4. Subcommand validation
    if (policy.subcommands.length > 0) {
      if (cmd.args.length === 0) {
        const entry: AuditEntry = {
          timestamp: new Date().toISOString(),
          action: "deny",
          command: cmd.binary,
          args: cmd.args,
          reason: "subcommand_required",
        }
        this.auditLog.append(entry)
        throw new SandboxError(`Subcommand required for: ${cmd.binary}`)
      }
      const subcommand = cmd.args[0]
      if (!policy.subcommands.includes(subcommand)) {
        const entry: AuditEntry = {
          timestamp: new Date().toISOString(),
          action: "deny",
          command: cmd.binary,
          args: cmd.args,
          reason: `subcommand_denied: ${subcommand}`,
        }
        this.auditLog.append(entry)
        throw new SandboxError(`Subcommand not allowed: ${cmd.binary} ${subcommand}`)
      }
    }

    // 5. Denied flags (check exact, --flag=value, and combined short forms)
    for (const arg of cmd.args) {
      for (const flag of policy.deniedFlags) {
        const isExact = arg === flag
        const isEqualsForm = arg.startsWith(flag + "=")
        const isCombinedShort = flag.length === 2 && flag.startsWith("-") && arg.startsWith(flag) && arg !== flag
        if (isExact || isEqualsForm || isCombinedShort) {
          const entry: AuditEntry = {
            timestamp: new Date().toISOString(),
            action: "deny",
            command: cmd.binary,
            args: cmd.args,
            reason: `flag_denied: ${flag}`,
          }
          this.auditLog.append(entry)
          throw new SandboxError(`Flag not allowed: ${flag}`)
        }
      }
    }

    // 6. Jail path validation for file commands
    const validatedArgs = [...cmd.args]
    if (policy.validatePaths) {
      for (let i = 0; i < validatedArgs.length; i++) {
        const arg = validatedArgs[i]
        // Skip flags (start with -)
        if (arg.startsWith("-")) continue
        validatedArgs[i] = this.jail.validatePath(arg)
      }
    }

    // 6a. Resolve binary path (realpath for TOCTOU safety)
    let binaryPath: string
    try {
      binaryPath = realpathSync(policy.binary)
    } catch {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        action: "deny",
        command: cmd.binary,
        args: cmd.args,
        reason: `binary_not_found_or_unresolvable: ${policy.binary}`,
      }
      this.auditLog.append(entry)
      throw new SandboxError(`Binary not available: ${cmd.binary}`)
    }

    // 6b. Resolve cwd (realpath to prevent symlink TOCTOU)
    const cwd = this.jail.getJailRoot()

    // 6c. Build sanitized env (already done at construction — sandboxEnv)

    // 6d. Build immutable ExecSpec
    const spec: ExecSpec = {
      binaryPath,
      args: validatedArgs,
      cwd,
      timeoutMs: this.config.execTimeout,
      env: this.sandboxEnv,
      maxBuffer: this.config.maxOutput,
    }

    // 7. Audit log (fail-closed for non-read-only)
    const auditEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      action: "allow",
      command: cmd.binary,
      args: cmd.args,
    }
    const logged = this.auditLog.append(auditEntry)
    if (!logged) {
      if (READ_ONLY_COMMANDS.has(cmd.binary)) {
        console.warn(
          `[sandbox] audit log failed — allowing read-only command '${cmd.binary}' in degraded mode`,
        )
      } else {
        throw new SandboxError("Audit log write failed — command denied (fail-closed)")
      }
    }

    // 8. Dispatch to worker pool
    if (!this.pool) {
      if (!this.poolMissingWarned) {
        this.poolMissingWarned = true
        console.warn("[sandbox] pool unavailable — all tool calls will fail. If SANDBOX_MODE is not 'disabled', check worker pool initialization.")
      }
      return { stdout: "", stderr: "Sandbox is disabled (no worker pool available)", exitCode: 1, timedOut: false, truncated: false }
    }
    const startTime = Date.now()
    let timedOut = false
    let result: { stdout: string; stderr: string; exitCode: number; truncated: boolean }

    try {
      result = await this.pool.exec(spec, "interactive")
    } catch (err: unknown) {
      // Map PoolError timeout to SandboxResult (preserve shape for callers)
      const poolErr = err as { name?: string; code?: string; message?: string }
      if (poolErr.name === "PoolError" && poolErr.code === "EXEC_TIMEOUT") {
        timedOut = true
        result = {
          stdout: "",
          stderr: poolErr.message ?? "Command timed out",
          exitCode: 137,
          truncated: false,
        }
      } else {
        // Log execution failure to maintain complete audit trail (SD-010).
        // Every "allow" entry must have a corresponding outcome.
        this.auditLog.append({
          ...auditEntry,
          duration: Date.now() - startTime,
          reason: `execution_failed: ${poolErr.code ?? poolErr.message ?? "unknown"}`,
        })
        throw err
      }
    }

    const duration = Date.now() - startTime

    // Map timeout-like exit codes to timedOut flag
    if (result.exitCode === 137 || result.exitCode === 143) {
      timedOut = true
    }

    // 9. Redact secrets from output
    let stdout = this.redactor.redact(result.stdout)
    let stderr = this.redactor.redact(result.stderr)

    // Update audit entry with execution details
    this.auditLog.append({
      ...auditEntry,
      duration,
      outputSize: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
    })

    return { stdout, stderr, exitCode: result.exitCode, timedOut, truncated: result.truncated }
  }

  getJail(): FilesystemJail {
    return this.jail
  }
}

// ── Helpers ──────────────────────────────────────────────────

function resolveBinary(name: string): string {
  try {
    const out = execFileSync("which", [name], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "" },
    })
    const p = out.trim()
    // Only accept absolute paths from `which`
    if (!p.startsWith("/")) {
      throw new Error(`Non-absolute path from which: ${p}`)
    }
    // Canonicalize at startup to avoid later realpathSync throwing
    return realpathSync(p)
  } catch {
    // Fail closed: sentinel path will deterministically fail at dispatch with ENOENT
    return `/__missing_binary__/${name}`
  }
}
