// src/cron/sandbox-policies.ts — Restricted bash and network policies for cron sessions (SDD §4.2)

// ── Types ───────────────────────────────────────────────────

export interface BashPolicy {
  /** Command name (e.g., "git", "npm") */
  command: string
  /** Allowed subcommands. If undefined, all subcommands allowed. */
  allowedSubcommands?: string[]
  /** Explicitly denied arguments. Checked before allowedSubcommands. */
  deniedArgs?: string[]
  /**
   * Execution mode. Must be "execFile" — callers MUST use array-based
   * execution (no shell interpretation). This field enforces the contract
   * that checkBashCommand is a validation helper, not the security boundary.
   * The actual security boundary is execFile with shell:false.
   */
  executionMode: "execFile"
}

export interface NetworkPolicy {
  /** Blocked hostnames/patterns */
  blockedHosts: string[]
  /** Blocked commands (all invocations denied) */
  blockedCommands: string[]
  /** Allowed hostnames (explicit allowlist for outbound) */
  allowedHosts: string[]
}

// ── Cron Bash Policies ──────────────────────────────────────

/** Git subcommands allowed in cron sessions (read-only only). (SDD §4.2) */
const GIT_ALLOWED_SUBCOMMANDS = ["log", "show", "diff", "status", "ls-files", "blame", "rev-parse", "branch"]

/** Git subcommands explicitly denied in cron sessions. (SDD §4.2) */
const GIT_DENIED_SUBCOMMANDS = [
  "push", "remote", "checkout", "reset", "clean", "rebase", "merge",
  "commit", "add", "rm", "mv", "stash", "pull", "fetch", "clone",
  "cherry-pick", "revert", "tag", "init",
]

/** Bash policies for cron agent sessions. (SDD §4.2) */
export const CRON_BASH_POLICIES: BashPolicy[] = [
  { command: "git", allowedSubcommands: GIT_ALLOWED_SUBCOMMANDS, deniedArgs: GIT_DENIED_SUBCOMMANDS, executionMode: "execFile" },
  { command: "br", allowedSubcommands: ["list", "get", "sync"], executionMode: "execFile" },
  { command: "ls", executionMode: "execFile" },
  { command: "cat", executionMode: "execFile" },
  { command: "wc", executionMode: "execFile" },
  { command: "head", executionMode: "execFile" },
  { command: "tail", executionMode: "execFile" },
  { command: "grep", executionMode: "execFile" },
  { command: "find", executionMode: "execFile" },
  { command: "npm", allowedSubcommands: ["install", "test", "run"], deniedArgs: ["-g", "--global"], executionMode: "execFile" },
  { command: "pnpm", allowedSubcommands: ["install", "test", "run"], deniedArgs: ["-g", "--global"], executionMode: "execFile" },
]
// NOTE: `gh` is intentionally NOT included — all GitHub access must go through MCP tools.

/** Network policy for cron sessions. (SDD §4.2, Flatline SKP-005) */
export const CRON_NETWORK_POLICY: NetworkPolicy = {
  blockedHosts: ["api.github.com", "github.com", "*.github.com"],
  blockedCommands: ["curl", "wget"],  // All HTTP must go through MCP tools
  allowedHosts: ["registry.npmjs.org", "registry.npmmirror.com"],
}
// NOTE: MCP server calls GitHub in-process (not via bash), so it's not subject to bash network policy.

// ── Policy Checking ─────────────────────────────────────────

/**
 * Check if a bash command is allowed by cron policies.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function checkBashCommand(
  command: string,
  args: string[],
  policies: BashPolicy[] = CRON_BASH_POLICIES,
): { allowed: boolean; reason?: string } {
  // Find matching policy
  const policy = policies.find(p => p.command === command)
  if (!policy) {
    return { allowed: false, reason: `Command "${command}" is not in cron bash allowlist` }
  }

  // Check denied args first (flags and subcommands that are never allowed)
  if (policy.deniedArgs && args.length > 0) {
    for (const arg of args) {
      if (policy.deniedArgs.includes(arg)) {
        return { allowed: false, reason: `Argument "${arg}" is denied for "${command}"` }
      }
    }
  }

  // Check allowed subcommands (if specified, first arg must be in list)
  if (policy.allowedSubcommands && args.length > 0) {
    const subcommand = args[0]
    if (!policy.allowedSubcommands.includes(subcommand)) {
      return { allowed: false, reason: `Subcommand "${subcommand}" is not allowed for "${command}"` }
    }
  }

  // Defense-in-depth: reject shell metacharacters in arguments to prevent
  // command injection if the caller ever uses shell execution instead of execFile.
  const SHELL_METACHAR = /[|;&`$()><]/
  for (const arg of args) {
    if (SHELL_METACHAR.test(arg)) {
      return { allowed: false, reason: `Argument "${arg}" contains shell metacharacter` }
    }
  }

  return { allowed: true }
}

/**
 * Check if a network request is allowed by cron policies.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function checkNetworkAccess(
  command: string,
  host?: string,
  policy: NetworkPolicy = CRON_NETWORK_POLICY,
): { allowed: boolean; reason?: string } {
  // Check blocked commands
  if (policy.blockedCommands.includes(command)) {
    return { allowed: false, reason: `Command "${command}" is blocked in cron sessions` }
  }

  // Check blocked hosts
  if (host) {
    for (const blocked of policy.blockedHosts) {
      if (blocked.startsWith("*.")) {
        const suffix = blocked.slice(1) // ".github.com"
        if (host.endsWith(suffix) || host === blocked.slice(2)) {
          return { allowed: false, reason: `Host "${host}" is blocked (matches ${blocked})` }
        }
      } else if (host === blocked) {
        return { allowed: false, reason: `Host "${host}" is blocked` }
      }
    }
  }

  return { allowed: true }
}
