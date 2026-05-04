// src/hounfour/task-type-allowlist.ts — Tenant Task Type Allowlist (SDD §4.6.4.1, IMP-004)
//
// Per-tenant allowlist for custom task types beyond the finn-native registry.
// Only active when OPEN_TASK_TYPES_ENABLED=true. When disabled, all lookups
// short-circuit to false with zero env var parsing (fail-closed).

import { OPEN_TASK_TYPES_ENABLED } from "./economic-boundary.js"
import type { TaskType } from "./protocol-types.js"

const allowlist: Map<string, Set<string>> = new Map()

if (OPEN_TASK_TYPES_ENABLED) {
  const raw = process.env.TENANT_TASK_TYPE_ALLOWLIST
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string[]>
      for (const [tenantId, types] of Object.entries(parsed)) {
        allowlist.set(tenantId, new Set(types))
      }
      console.log(`[task-type-allowlist] Loaded allowlist for ${allowlist.size} tenant(s)`)
    } catch (err) {
      throw new Error(`[task-type-allowlist] Invalid TENANT_TASK_TYPE_ALLOWLIST JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * Check whether a tenant is allowlisted for a specific task type.
 *
 * When OPEN_TASK_TYPES_ENABLED is false, always returns false (fail-closed).
 * Logs at INFO level when an allowlist grant is exercised.
 */
export function isTenantAllowlisted(tenantId: string, taskType: TaskType): boolean {
  if (!OPEN_TASK_TYPES_ENABLED) return false
  const tenantTypes = allowlist.get(tenantId)
  if (!tenantTypes) return false
  const granted = tenantTypes.has(taskType as string)
  if (granted) {
    console.log(`[task-type-allowlist] Allowlist grant: tenant=${tenantId} taskType=${taskType as string}`)
  }
  return granted
}
