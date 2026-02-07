// src/safety/boot-validation.ts — Boot-time safety validation sequence (SDD §7.2, §9.1)
//
// Fail-fast boot checks: token presence, token type, permissions, repo access,
// filesystem capabilities, PID file, and firewall self-test.

import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

// ── Error codes ─────────────────────────────────────────────

export const BootErrorCode = {
  E_TOKEN_MISSING: "E_TOKEN_MISSING",
  E_TOKEN_TYPE: "E_TOKEN_TYPE",
  E_PERM_MISSING: "E_PERM_MISSING",
  E_PERM_EXCLUDED: "E_PERM_EXCLUDED",
  E_REPO_ACCESS: "E_REPO_ACCESS",
  E_FS_CAPABILITY: "E_FS_CAPABILITY",
  E_PID_CONFLICT: "E_PID_CONFLICT",
  E_SELF_TEST: "E_SELF_TEST",
} as const

export type BootErrorCodeType = (typeof BootErrorCode)[keyof typeof BootErrorCode]

/** Error thrown by boot validation steps. */
export class BootValidationError extends Error {
  public readonly code: BootErrorCodeType
  public readonly step: number

  constructor(code: BootErrorCodeType, message: string, step: number) {
    super(`[${code}] ${message}`)
    this.name = "BootValidationError"
    this.code = code
    this.step = step
  }
}

// ── Types ───────────────────────────────────────────────────

export type TokenType = "app" | "pat" | "unknown"

export interface BootConfig {
  token?: string
  autonomous?: boolean
  permissions?: Record<string, string>
  repoAccessCheck?: () => Promise<boolean>
  firewallSelfTest?: () => Promise<boolean>
  dataDir?: string
  pidFilePath?: string
  /** Gateway bind address — used to enforce auth token on non-loopback. */
  bindAddress?: string
  /** Gateway bearer token — must be non-empty when binding to non-loopback. */
  authToken?: string
}

/** Required GitHub permissions for agent operation. */
export const REQUIRED_PERMISSIONS: Record<string, string> = {
  issues: "write",
  pull_requests: "write",
  contents: "write",
  metadata: "read",
}

/** Permissions that must NOT be present (overly broad). */
export const EXCLUDED_PERMISSIONS: string[] = [
  "administration",
  "organization_administration",
]

// ── Token Detection ─────────────────────────────────────────

/** Detect token type from prefix. (SDD §7.2) */
export function detectTokenType(token: string): TokenType {
  if (token.startsWith("ghs_")) return "app"
  if (token.startsWith("ghp_") || token.startsWith("github_pat_")) return "pat"
  return "unknown"
}

// ── Filesystem Validation ───────────────────────────────────

/** Test filesystem capabilities required for safe operation. (SDD §9.1) */
export async function validateFilesystem(dataDir: string): Promise<{ fsType?: string; warnings: string[] }> {
  const warnings: string[] = []
  let fsType: string | undefined

  // Detect filesystem type (Linux only — /proc/mounts)
  try {
    const mounts = await readFile("/proc/mounts", "utf-8")
    let bestMatch = ""
    for (const line of mounts.split("\n")) {
      const parts = line.split(" ")
      if (parts.length < 3) continue
      const mountPoint = parts[1]
      const type = parts[2]
      if (dataDir.startsWith(mountPoint) && mountPoint.length > bestMatch.length) {
        bestMatch = mountPoint
        fsType = type
      }
    }

    if (fsType === "nfs" || fsType === "nfs4" || fsType === "cifs") {
      throw new BootValidationError(
        BootErrorCode.E_FS_CAPABILITY,
        `Unsupported filesystem "${fsType}" — O_EXCL is unreliable on network filesystems.`,
        0,
      )
    }
    if (fsType === "overlay" || fsType === "overlayfs") {
      warnings.push(`Filesystem "${fsType}" detected — rename() may not be atomic.`)
    }
  } catch (err) {
    if (err instanceof BootValidationError) throw err
    // /proc/mounts not available (macOS, etc.) — skip detection
  }

  // Test O_EXCL atomicity + rename
  const testPath = join(dataDir, `.boot-test-${Date.now()}`)
  const testPathRenamed = testPath + ".renamed"
  try {
    const fh = await open(testPath, "wx")
    await fh.writeFile("boot-test", "utf-8")
    await fh.sync()
    await fh.close()
    await rename(testPath, testPathRenamed)
    await stat(testPathRenamed)
  } catch (err) {
    if (err instanceof BootValidationError) throw err
    throw new BootValidationError(
      BootErrorCode.E_FS_CAPABILITY,
      `Filesystem test failed in "${dataDir}": ${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  } finally {
    try { await unlink(testPath) } catch { /* ignore */ }
    try { await unlink(testPathRenamed) } catch { /* ignore */ }
  }

  return { fsType, warnings }
}

// ── Boot Validation ─────────────────────────────────────────

export interface BootResult {
  tokenType: TokenType
  fsType?: string
  warnings: string[]
}

/**
 * Run the full 7-step boot validation sequence. (SDD §7.2)
 * Throws BootValidationError on any critical failure.
 */
export async function validateBootSafety(config: BootConfig): Promise<BootResult> {
  const warnings: string[] = []

  // Step 1: Token presence
  if (!config.token) {
    throw new BootValidationError(
      BootErrorCode.E_TOKEN_MISSING,
      "GitHub token not configured. Set GITHUB_TOKEN or configure via agent-jobs settings.",
      1,
    )
  }

  // Step 2: Token type detection
  const tokenType = detectTokenType(config.token)
  if (config.autonomous && tokenType !== "app") {
    throw new BootValidationError(
      BootErrorCode.E_TOKEN_TYPE,
      `Autonomous mode requires a GitHub App token (ghs_...), got ${tokenType}.`,
      2,
    )
  }

  // Step 3: Permission validation
  if (config.permissions) {
    for (const [perm, level] of Object.entries(REQUIRED_PERMISSIONS)) {
      const actual = config.permissions[perm]
      if (!actual) {
        throw new BootValidationError(
          BootErrorCode.E_PERM_MISSING,
          `Required permission "${perm}: ${level}" not found.`,
          3,
        )
      }
      // 'write' satisfies 'read', so only fail if we need 'write' and got 'read'
      if (level === "write" && actual === "read") {
        throw new BootValidationError(
          BootErrorCode.E_PERM_MISSING,
          `Permission "${perm}" requires "write", got "${actual}".`,
          3,
        )
      }
    }
    for (const perm of EXCLUDED_PERMISSIONS) {
      if (config.permissions[perm]) {
        throw new BootValidationError(
          BootErrorCode.E_PERM_EXCLUDED,
          `Excluded permission "${perm}" is present. Remove it.`,
          3,
        )
      }
    }
  }

  // Step 4: Repo access check
  if (config.repoAccessCheck) {
    const canAccess = await config.repoAccessCheck()
    if (!canAccess) {
      throw new BootValidationError(
        BootErrorCode.E_REPO_ACCESS,
        "Cannot access target repository. Verify token and repo visibility.",
        4,
      )
    }
  }

  // Step 5: Branch protection check (non-blocking — advisory only)

  // Step 6: PID file single-instance check
  if (config.pidFilePath) {
    try {
      const pidContent = await readFile(config.pidFilePath, "utf-8")
      const existingPid = parseInt(pidContent.trim(), 10)
      if (!isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0)
          // Process is alive — conflict
          throw new BootValidationError(
            BootErrorCode.E_PID_CONFLICT,
            `Another instance is running (PID ${existingPid}). Stop it or remove ${config.pidFilePath}.`,
            6,
          )
        } catch (err) {
          if (err instanceof BootValidationError) throw err
          // Process not running — stale PID file, safe to overwrite
          warnings.push(`Stale PID file found (PID ${existingPid} not running), overwriting.`)
        }
      }
    } catch (err) {
      if (err instanceof BootValidationError) throw err
      // PID file doesn't exist — fine
    }
    await writeFile(config.pidFilePath, String(process.pid), "utf-8")
  }

  // Step 7a: Auth token presence when binding to non-loopback
  if (config.bindAddress && config.bindAddress !== "127.0.0.1" && config.bindAddress !== "::1") {
    if (!config.authToken) {
      throw new BootValidationError(
        BootErrorCode.E_TOKEN_MISSING,
        `Auth token required when binding to non-loopback address "${config.bindAddress}". Set FINN_AUTH_TOKEN.`,
        7,
      )
    }
  }

  // Step 7b: Firewall self-test
  if (config.firewallSelfTest) {
    const passed = await config.firewallSelfTest()
    if (!passed) {
      throw new BootValidationError(
        BootErrorCode.E_SELF_TEST,
        "Firewall self-test failed. Check audit trail and firewall config.",
        7,
      )
    }
  }

  // Filesystem validation (if dataDir provided)
  let fsType: string | undefined
  if (config.dataDir) {
    const fsResult = await validateFilesystem(config.dataDir)
    fsType = fsResult.fsType
    warnings.push(...fsResult.warnings)
  }

  return { tokenType, fsType, warnings }
}
