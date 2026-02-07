// src/gateway/dashboard-audit-api.ts — Paginated, filterable audit trail API (TASK-6.2)

import { createHash, timingSafeEqual } from "node:crypto"
import type { ResponseRedactor } from "./redaction-middleware.js"

// ── Domain types ─────────────────────────────────────────────

export interface AuditRecord {
  id: string
  timestamp: number
  jobId?: string
  templateId?: string
  action: string
  phase: string
  data?: Record<string, unknown>
}

export interface AuditApiDeps {
  auditTrail: {
    getRecords(opts?: { since?: number; until?: number; limit?: number; offset?: number }): AuditRecord[]
    getRecordCount(): number
    verifyChain(): Promise<{ valid: boolean; brokenAt?: number }>
  }
  redactor: ResponseRedactor
  authToken: string
}

// ── Request / Response types ─────────────────────────────────

export interface ApiRequest {
  method: string
  path: string
  headers: Record<string, string>
  body?: unknown
  params?: Record<string, string>
  query?: Record<string, string>
}

export interface ApiResponse {
  status: number
  body: unknown
}

// ── AuditApi ─────────────────────────────────────────────────

export class AuditApi {
  private readonly deps: AuditApiDeps

  constructor(deps: AuditApiDeps) {
    this.deps = deps
  }

  async handle(req: ApiRequest): Promise<ApiResponse> {
    const method = req.method.toUpperCase()
    const path = req.path
    const query = req.query ?? {}

    // Auth check for all routes
    const authErr = this.checkAuth(req)
    if (authErr) return authErr

    // Route: GET /api/dashboard/audit/verify (must match before /audit)
    if (method === "GET" && path === "/api/dashboard/audit/verify") {
      return this.verifyChain()
    }

    // Route: GET /api/dashboard/audit
    if (method === "GET" && path === "/api/dashboard/audit") {
      return this.listRecords(query)
    }

    return { status: 404, body: { error: "Not found", code: "ROUTE_NOT_FOUND" } }
  }

  // ── Auth ─────────────────────────────────────────────────

  private checkAuth(req: ApiRequest): ApiResponse | null {
    const authHeader = req.headers["authorization"] ?? req.headers["Authorization"]
    if (!authHeader?.startsWith("Bearer ")) {
      return { status: 401, body: { error: "Unauthorized", code: "AUTH_REQUIRED" } }
    }
    const token = authHeader.slice(7)
    if (!safeCompare(token, this.deps.authToken)) {
      return { status: 401, body: { error: "Unauthorized", code: "AUTH_INVALID" } }
    }
    return null
  }

  // ── Handlers ─────────────────────────────────────────────

  private async listRecords(query: Record<string, string>): Promise<ApiResponse> {
    const limit = Math.min(Math.max(parseInt(query["limit"] ?? "50", 10) || 50, 1), 200)
    const offset = Math.max(parseInt(query["offset"] ?? "0", 10) || 0, 0)
    const since = query["from"] ? Number(query["from"]) : undefined
    const until = query["to"] ? Number(query["to"]) : undefined

    // Fetch records with timestamp bounds; we over-fetch so we can filter client-side
    let records = this.deps.auditTrail.getRecords({ since, until })

    // Apply optional field filters
    const jobFilter = query["job"]
    const templateFilter = query["template"]
    const actionFilter = query["action"]

    if (jobFilter) records = records.filter((r) => r.jobId === jobFilter)
    if (templateFilter) records = records.filter((r) => r.templateId === templateFilter)
    if (actionFilter) records = records.filter((r) => r.action === actionFilter)

    const total = records.length
    const page = records.slice(offset, offset + limit)
    const redacted = this.deps.redactor.redact(page)

    return {
      status: 200,
      body: { records: redacted, pagination: { limit, offset, total } },
    }
  }

  private async verifyChain(): Promise<ApiResponse> {
    const result = await this.deps.auditTrail.verifyChain()
    const totalRecords = this.deps.auditTrail.getRecordCount()
    return {
      status: 200,
      body: { valid: result.valid, brokenAt: result.brokenAt, totalRecords },
    }
  }
}

// ── Utility ──────────────────────────────────────────────────

function safeCompare(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest()
  const bufB = createHash("sha256").update(b).digest()
  return timingSafeEqual(bufA, bufB)
}
