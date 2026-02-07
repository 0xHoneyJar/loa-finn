// src/safety/tool-registry.ts — MCP Tool Registry for GitHub tools (SDD §4.2)
//
// Static registry of all known GitHub MCP tools with capability classification
// and parameter constraint validation. Used at boot to reject unknown tools
// and at runtime to gate tool invocations by capability level.

// ── Types ───────────────────────────────────────────────────

/** Tool capability levels — read is lowest, admin is highest. (SDD §4.2) */
export type ToolCapability = "read" | "write" | "admin"

/** Parameter constraint: value must equal a specific value. */
export interface MustBeConstraint {
  type: "must_be"
  param: string
  value: unknown
}

/** Parameter constraint: string value must match a regex pattern. */
export interface PatternConstraint {
  type: "pattern"
  param: string
  pattern: string
}

/** Parameter constraint: value must be one of the allowed values. */
export interface AllowlistConstraint {
  type: "allowlist"
  param: string
  values: unknown[]
}

export type ParamConstraint = MustBeConstraint | PatternConstraint | AllowlistConstraint

/** A single tool entry in the registry. (SDD §4.2) */
export interface ToolRegistryEntry {
  name: string
  capability: ToolCapability
  paramConstraints?: ParamConstraint[]
}

// ── Registry ────────────────────────────────────────────────

/** Branch pattern: must start with finn/ or be a feature/fix/chore branch. (SDD §4.2) */
const BRANCH_PATTERN = "^(finn/|feature/|fix/|chore/)"

/** Static registry of all known GitHub MCP tools. (SDD §4.2) */
export const TOOL_REGISTRY: Map<string, ToolRegistryEntry> = new Map([
  // ── Read tools ──────────────────────────────────────────
  ["get_pull_request", { name: "get_pull_request", capability: "read" }],
  ["get_pull_request_files", { name: "get_pull_request_files", capability: "read" }],
  ["get_pull_request_comments", { name: "get_pull_request_comments", capability: "read" }],
  ["get_pull_request_reviews", { name: "get_pull_request_reviews", capability: "read" }],
  ["list_pull_requests", { name: "list_pull_requests", capability: "read" }],
  ["get_issue", { name: "get_issue", capability: "read" }],
  ["list_issues", { name: "list_issues", capability: "read" }],
  ["search_issues", { name: "search_issues", capability: "read" }],
  ["search_code", { name: "search_code", capability: "read" }],
  ["get_file_contents", { name: "get_file_contents", capability: "read" }],
  ["list_commits", { name: "list_commits", capability: "read" }],
  ["get_pull_request_status", { name: "get_pull_request_status", capability: "read" }],

  // ── Write tools ─────────────────────────────────────────
  ["create_pull_request_review", { name: "create_pull_request_review", capability: "write" }],
  ["add_issue_comment", { name: "add_issue_comment", capability: "write" }],
  ["update_issue", { name: "update_issue", capability: "write" }],
  ["create_issue", { name: "create_issue", capability: "write" }],
  ["create_pull_request", {
    name: "create_pull_request",
    capability: "write",
    paramConstraints: [
      { type: "must_be", param: "draft", value: true },
    ],
  }],
  ["create_branch", {
    name: "create_branch",
    capability: "write",
    paramConstraints: [
      { type: "pattern", param: "branch", pattern: BRANCH_PATTERN },
    ],
  }],
  ["create_or_update_file", {
    name: "create_or_update_file",
    capability: "write",
    paramConstraints: [
      { type: "pattern", param: "branch", pattern: BRANCH_PATTERN },
    ],
  }],
  ["push_files", {
    name: "push_files",
    capability: "write",
    paramConstraints: [
      { type: "pattern", param: "branch", pattern: BRANCH_PATTERN },
    ],
  }],

  // ── Admin tools ─────────────────────────────────────────
  ["merge_pull_request", { name: "merge_pull_request", capability: "admin" }],
  ["delete_branch", { name: "delete_branch", capability: "admin" }],
  ["update_branch_protection", { name: "update_branch_protection", capability: "admin" }],
  ["update_pull_request_branch", { name: "update_pull_request_branch", capability: "admin" }],
])

// ── Lookup helpers ──────────────────────────────────────────

/** Get the full registry entry for a tool. (SDD §4.2) */
export function getToolEntry(name: string): ToolRegistryEntry | undefined {
  return TOOL_REGISTRY.get(name)
}

/** Get the capability level for a tool. (SDD §4.2) */
export function getToolCapability(name: string): ToolCapability | undefined {
  return TOOL_REGISTRY.get(name)?.capability
}

/** Check if a tool name is in the registry. (SDD §4.2) */
export function isKnownTool(name: string): boolean {
  return TOOL_REGISTRY.has(name)
}

/** List all tools with a given capability. (SDD §4.2) */
export function getToolsByCapability(cap: ToolCapability): string[] {
  const result: string[] = []
  for (const [name, entry] of TOOL_REGISTRY) {
    if (entry.capability === cap) {
      result.push(name)
    }
  }
  return result
}

// ── Validation ──────────────────────────────────────────────

/**
 * Validate that all MCP tool names are present in the registry.
 * Returns unknown tools — caller should fail boot if any are found. (SDD §4.2)
 */
export function validateToolRegistry(mcpToolNames: string[]): { valid: boolean; unknownTools: string[] } {
  const unknownTools = mcpToolNames.filter((name) => !TOOL_REGISTRY.has(name))
  return { valid: unknownTools.length === 0, unknownTools }
}

/**
 * Validate tool parameters against registered constraints. (SDD §4.2)
 *
 * Returns violations for each constraint that fails. If the tool has no
 * constraints, or the tool is unknown, returns valid with no violations.
 */
export function validateParams(
  toolName: string,
  params: Record<string, unknown>,
): { valid: boolean; violations: string[] } {
  const entry = TOOL_REGISTRY.get(toolName)
  if (!entry?.paramConstraints) {
    return { valid: true, violations: [] }
  }

  const violations: string[] = []

  for (const constraint of entry.paramConstraints) {
    switch (constraint.type) {
      case "must_be": {
        const actual = params[constraint.param]
        if (actual !== constraint.value) {
          violations.push(
            `${constraint.param} must be ${JSON.stringify(constraint.value)}, got ${JSON.stringify(actual)}`,
          )
        }
        break
      }
      case "pattern": {
        const actual = params[constraint.param]
        if (typeof actual !== "string") {
          violations.push(
            `${constraint.param} must be a string matching /${constraint.pattern}/, got ${typeof actual}`,
          )
        } else {
          const re = new RegExp(constraint.pattern)
          if (!re.test(actual)) {
            violations.push(
              `${constraint.param} must match /${constraint.pattern}/, got "${actual}"`,
            )
          }
        }
        break
      }
      case "allowlist": {
        const actual = params[constraint.param]
        if (!constraint.values.includes(actual)) {
          violations.push(
            `${constraint.param} must be one of ${JSON.stringify(constraint.values)}, got ${JSON.stringify(actual)}`,
          )
        }
        break
      }
    }
  }

  return { valid: violations.length === 0, violations }
}
